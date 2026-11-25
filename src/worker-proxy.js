/* Monitor BTC — entrada de produção sem estado de carteira.

   O Worker é só um proxy do Electrum e um relay de broadcast. O navegador
   deriva endereços, consulta históricos/transações por scripthash, calcula
   saldo/histórico/UTXOs, monta o PSBT (envio e CPFP) e confere o PSBT
   assinado. O Worker vê scripthashes, txids, transações cruas e a transação
   assinada; não recebe xpub, a lista derivada de endereços/pubkeys nem chave
   privada. As transações cruas contêm os scripts públicos delas. */
import { openElectrum, estimateFees } from './electrum.js';
import { electrumConfig, fail, json, SECURITY_HEADERS } from './config.js';
import { ProxyWatcher } from './proxy-watcher.js';

const MAX_PROXY_ITEMS = 2500;
const MAX_TX_HEX = 400000;
const RATE_WINDOW_MS = 60000;
const RATE_MAX_REQUESTS = 120;
const RATE_MAX_PROXY_ITEMS = 20000;
const RATE_REFILL_PER_MS = RATE_MAX_REQUESTS / RATE_WINDOW_MS;
const RATE_ITEM_REFILL_PER_MS = RATE_MAX_PROXY_ITEMS / RATE_WINDOW_MS;
const rateBuckets = new Map();

function clientIp(request) {
  const h = request.headers;
  const raw = h.get('cf-connecting-ip') || h.get('x-forwarded-for') || 'local';
  return String(raw).split(',')[0].trim() || 'local';
}

function refill(counter, now, max, perMs) {
  const elapsed = Math.max(0, now - counter.updated);
  counter.tokens = Math.min(max, counter.tokens + elapsed * perMs);
  counter.updated = now;
}

function rateBucket(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = {
      requests: { tokens: RATE_MAX_REQUESTS, updated: now },
      items: { tokens: RATE_MAX_PROXY_ITEMS, updated: now }
    };
    rateBuckets.set(ip, bucket);
  }
  refill(bucket.requests, now, RATE_MAX_REQUESTS, RATE_REFILL_PER_MS);
  refill(bucket.items, now, RATE_MAX_PROXY_ITEMS, RATE_ITEM_REFILL_PER_MS);
  if (rateBuckets.size > 2000) {
    for (const [key, value] of rateBuckets) {
      if (now - Math.max(value.requests.updated, value.items.updated) >= RATE_WINDOW_MS) {
        rateBuckets.delete(key);
      }
    }
  }
  return bucket;
}

function tooMany(retrySeconds) {
  return new Response(JSON.stringify({ error: 'muitos pedidos; tente de novo em ' + retrySeconds + ' s' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retrySeconds)
    }
  });
}

async function withRate(request, items, run) {
  const bucket = rateBucket(clientIp(request));
  if (bucket.requests.tokens < 1) {
    return tooMany(Math.max(1, Math.ceil((1 - bucket.requests.tokens) / RATE_REFILL_PER_MS / 1000)));
  }
  if (bucket.items.tokens < items) {
    return tooMany(Math.max(1, Math.ceil((items - bucket.items.tokens) / RATE_ITEM_REFILL_PER_MS / 1000)));
  }
  bucket.requests.tokens--;
  bucket.items.tokens -= items;
  return await run();
}

const READ_METHODS = new Set([
  'blockchain.scripthash.get_history',
  'blockchain.scripthash.get_mempool',
  'blockchain.transaction.get',
  'blockchain.estimatefee'
]);
const BROADCAST_METHOD = 'blockchain.transaction.broadcast';
const HEX64 = /^[0-9a-f]{64}$/;

function proxyItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('item de proxy inválido');
  const method = String(raw.method || '');
  if (method !== BROADCAST_METHOD && !READ_METHODS.has(method)) {
    throw new Error('método não permitido: ' + method);
  }
  const params = Array.isArray(raw.params) ? raw.params : [];
  if (method === 'blockchain.scripthash.get_history' || method === 'blockchain.scripthash.get_mempool') {
    if (params.length !== 1 || !HEX64.test(String(params[0] || '').toLowerCase())) {
      throw new Error('scripthash inválido');
    }
    return { method, params: [String(params[0]).toLowerCase()] };
  }
  if (method === 'blockchain.transaction.get') {
    if (params.length < 1 || !HEX64.test(String(params[0] || '').toLowerCase())) {
      throw new Error('txid inválido');
    }
    return { method, params: [String(params[0]).toLowerCase()] };
  }
  if (method === 'blockchain.estimatefee') {
    const target = Number(params[0]);
    if (!Number.isInteger(target) || target < 1 || target > 1000) {
      throw new Error('alvo de taxa inválido');
    }
    return { method, params: [target] };
  }
  const tx = String(params[0] || '').toLowerCase();
  if (tx.length < 2 || tx.length > MAX_TX_HEX || tx.length % 2 || !/^[0-9a-f]+$/.test(tx)) {
    throw new Error('transação inválida');
  }
  return { method, params: [tx] };
}

async function runProxyItems(client, items) {
  const results = new Array(items.length);
  const errors = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await client.request(items[i].method, items[i].params); }
      catch (e) { errors[i] = e && e.message ? e.message : String(e); results[i] = null; }
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(20, items.length); k++) workers.push(worker());
  await Promise.all(workers);
  return { results, errors };
}

async function handleProxy(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const rawItems = Array.isArray(body && body.items) ? body.items : [body];
  if (!rawItems.length || rawItems.length > MAX_PROXY_ITEMS) return fail('lote inválido');
  let items;
  try { items = rawItems.map(proxyItem); }
  catch (e) { return fail(e.message); }
  if (items.some(item => item.method === BROADCAST_METHOD) && items.length !== 1) {
    return fail('broadcast precisa ser sozinho no lote');
  }
  return await withRate(request, items.length, async () => {
    const cfg = electrumConfig(env);
    if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);
    if (cfg.error) return fail(cfg.error, 503);
    let client;
    try {
      client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
    } catch (e) {
      return fail('Electrum indisponível: ' + (e && e.message ? e.message : e), 502);
    }
    try {
      return json(await runProxyItems(client, items));
    } finally {
      try { await client.close(); } catch (e) {}
    }
  });
}

async function handleFees(env) {
  const cfg = electrumConfig(env);
  if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);
  if (cfg.error) return fail(cfg.error, 503);
  const sources = await Promise.all(cfg.servers.map(async server => {
    try {
      const client = await openElectrum({ servers: [server], timeoutMs: cfg.timeoutMs });
      try {
        const fees = await estimateFees(client);
        return {
          source: client.name,
          levels: fees.levels,
          sat_per_vb: fees.sat_per_vb,
          floored: fees.floored
        };
      } finally {
        try { await client.close(); } catch (e) {}
      }
    } catch (e) {
      return { source: server.host + ':' + server.port, error: e && e.message ? e.message : String(e) };
    }
  }));
  const ok = sources.filter(s => !s.error);
  if (!ok.length) return fail('nenhum servidor Electrum respondeu: ' + sources.map(s => s.source + ': ' + s.error).join('; '), 502);
  /* Mediana por nível entre as fontes que responderam. O cliente mostra
     todas as fontes e o valor escolhido; nenhuma taxa é imposta pelo
     servidor. */
  const chosen = ok[0];
  const levels = {};
  const satPerVb = {};
  const floored = {};
  const keys = Object.keys(chosen.levels || {});
  for (const key of keys) {
    const values = ok.map(s => Number(s.sat_per_vb && s.sat_per_vb[key]))
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const value = values.length ? values[Math.floor(values.length / 2)] : null;
    satPerVb[key] = value;
    levels[key] = value;
    floored[key] = value != null && value < 0.1;
  }
  return json({
    levels,
    targets: { next: 2 },
    sat_per_vb: satPerVb,
    floored,
    relay_min_kvb: 100,
    unit: 'sat/vB',
    source: ok.map(s => s.source).join(', '),
    sources,
    updated_at: new Date().toISOString()
  });
}

function handleSession(env) {
  if (!env.WATCH) return fail('tempo real não configurado (sem o Durable Object WATCH)', 503);
  return json({ session: env.WATCH.newUniqueId().toString() });
}

async function handleEvents(request, env) {
  const url = new URL(request.url);
  const session = String(url.searchParams.get('session') || '').trim();
  if (!/^[0-9a-f]{64}$/.test(session)) return fail('sessão inválida', 400);
  if (!env.WATCH) return fail('tempo real não configurado (sem o Durable Object WATCH)', 503);
  return await env.WATCH.get(env.WATCH.idFromString(session)).fetch(request);
}

function handleHealth(env) {
  const cfg = electrumConfig(env);
  return json({
    ok: true,
    service: 'monitor-btc-proxy',
    source: 'electrum',
    storage: 'nenhum',
    realtime: !!env.WATCH,
    electrum: cfg && cfg.error ? cfg.error : cfg
      ? cfg.servers.map(s => s.host + ':' + s.port + (s.secure ? ' tls' : ' tcp'))
      : 'off',
    time: new Date().toISOString()
  });
}

const HTML_ROUTES = new Set(['/', '/index.html', '/cofre-btc', '/cofre-btc.html']);
const REWRITE_HEADERS = ['x-original-url', 'x-rewrite-url', 'x-forwarded-prefix'];

function hasRewriteHeader(request) {
  return REWRITE_HEADERS.some(name => request.headers.has(name));
}

function isSpaFallback(pathname, response) {
  if (HTML_ROUTES.has(pathname) || response.status !== 200) return false;
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  return type.startsWith('text/html');
}

function withSecurityHeaders(response) {
  if (!response || response.status === 101 || response.webSocket) return response;
  const headers = new Headers(response.headers);
  for (const name of Object.keys(SECURITY_HEADERS)) headers.set(name, SECURITY_HEADERS[name]);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  try {
    if (hasRewriteHeader(request)) return fail('cabeçalho de reescrita de caminho não é aceito', 400);
    if (url.pathname === '/api/health') return handleHealth(env);
    if (url.pathname === '/api/proxy') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await handleProxy(request, env);
    }
    if (url.pathname === '/api/fees') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail('use GET', 405);
      return await withRate(request, 1, () => handleFees(env));
    }
    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withRate(request, 1, () => handleSession(env));
    }
    if (url.pathname === '/api/events') return await withRate(request, 1, () => handleEvents(request, env));
    if (url.pathname.startsWith('/api/')) return fail('rota não encontrada', 404);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (isSpaFallback(url.pathname, res)) {
        return new Response(res.body, {
          status: 404,
          statusText: 'Not Found',
          headers: res.headers
        });
      }
      return res;
    }
    return new Response('not found', { status: 404 });
  } catch (e) {
    return fail(e && e.message ? e.message : '' + e, 500);
  }
}

export { ProxyWatcher as WalletWatcher };

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await route(request, env));
  }
};
