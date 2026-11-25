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
import { normalizeProxyItems, runProxyItems } from './proxy-rpc.js';

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

function sessionId(value) {
  const s = String(value || '').trim();
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

async function openOne(cfg, fn) {
  let client;
  try {
    client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
  } catch (e) {
    throw new Error('Electrum indisponível: ' + (e && e.message ? e.message : e));
  }
  try { return await fn(client); }
  finally { try { await client.close(); } catch (e) {} }
}

async function handleProxy(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  let items;
  try { items = normalizeProxyItems(body); }
  catch (e) { return fail(e.message); }
  return await withRate(request, items.length, async () => {
    const cfg = electrumConfig(env);
    if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);
    if (cfg.error) return fail(cfg.error, 503);
    /* Com sessão, o ProxyWatcher segura a conexão Electrum e o lote é
       executado dentro do objeto. Sem sessão (dev/testes), abre e fecha. */
    const session = sessionId(body && body.session);
    if (env.WATCH && session) {
      try {
        const stub = env.WATCH.get(env.WATCH.idFromString(session));
        const res = await stub.fetch('https://watch/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      } catch (e) {
        return fail('Electrum indisponível: ' + (e && e.message ? e.message : e), 502);
      }
    }
    try {
      return await openOne(cfg, async client => json(await runProxyItems(client, items)));
    } catch (e) {
      return fail(e && e.message ? e.message : String(e), 502);
    }
  });
}

const feeCache = new Map();
const FEE_CACHE_MS = 30000;

async function handleFees(request, env, url) {
  const session = sessionId(url && url.searchParams.get('session'));
  if (env.WATCH && session) {
    try {
      const stub = env.WATCH.get(env.WATCH.idFromString(session));
      return await stub.fetch('https://watch/fees');
    } catch (e) {
      return fail('Electrum indisponível: ' + (e && e.message ? e.message : e), 502);
    }
  }
  const cfg = electrumConfig(env);
  if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);
  if (cfg.error) return fail(cfg.error, 503);
  const key = (cfg.servers || []).map(s => s.host + ':' + s.port).join(',') + '|' + cfg.timeoutMs;
  const cached = feeCache.get(key);
  if (cached && Date.now() - cached.at < FEE_CACHE_MS) return json(cached.data);
  try {
    const data = await openOne(cfg, async client => {
      const fees = await estimateFees(client);
      return {
        levels: fees.levels,
        targets: fees.targets,
        sat_per_vb: fees.sat_per_vb,
        sat_per_kvb: fees.sat_per_kvb,
        floored: fees.floored,
        relay_min_kvb: fees.relay_min_kvb,
        unit: fees.unit,
        sources: [{ source: 'electrum', levels: fees.levels }],
        updated_at: new Date().toISOString()
      };
    });
    feeCache.set(key, { at: Date.now(), data });
    return json(data);
  } catch (e) {
    return fail(e && e.message ? e.message : String(e), 502);
  }
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
      return await withRate(request, 1, () => handleFees(request, env, url));
    }
    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withRate(request, 1, () => handleSession(env));
    }
    if (url.pathname === '/api/events') {
      return await withRate(request, 1, () => handleEvents(request, env));
    }
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
