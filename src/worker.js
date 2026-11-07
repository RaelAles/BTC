import { parseXpub } from './derivation.js';
import { openElectrum } from './electrum.js';
import { WalletScanner } from './wallet-sync.js';
import { electrumConfig, fail, json } from './config.js';
import { WalletWatcher } from './watcher.js';

/* Projeto 2 — rotas HTTP.

   `POST /api/wallet`  → estado da carteira (saldo, endereços usados).
                         Com o binding WATCH, quem faz o trabalho é o
                         Durable Object de tempo real (conexão Electrum
                         reaproveitada + assinaturas); sem ele, a consulta
                         é avulsa (dev/testes).
   `GET  /api/events?session=…` → WebSocket do Durable Object, que empurra
                         o estado novo quando um scripthash muda.
   `GET  /api/health`  → configuração efetiva.

   Nada é gravado: o D1 não existe mais. A xpub só vive na memória do
   Durable Object durante a sessão e é descartada quando a última tela
   fecha. Sem chave privada em lugar nenhum. */

/* Mensagem melhor para o que costuma ser colado no lugar da xpub. */
function xpubHint(value) {
  const s = String(value || '').trim();
  if (/^(xprv|yprv|zprv)/.test(s)) {
    return 'isso é uma chave privada (xprv/yprv/zprv). Nunca cole a privada aqui: o projeto é watch-only.';
  }
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(s)) {
    return 'isso é um endereço Bitcoin, não uma xpub. Use a chave estendida pública da conta (xpub/zpub/ypub).';
  }
  if (!/^(xpub|ypub|zpub)/.test(s)) {
    return 'a chave precisa começar com xpub, zpub ou ypub (chave estendida pública da conta).';
  }
  return null;
}

async function handleWallet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return fail('informe a xpub');
  let account;
  try { account = parseXpub(xpub); }
  catch (e) { return fail(xpubHint(xpub) || e.message); }

  if (env.WATCH) {
    // sessão = id aleatório do Durable Object; nunca derivado da xpub.
    // O cliente devolve o id nas próximas consultas para reaproveitar a
    // conexão e as assinaturas enquanto a tela estiver aberta.
    const session = String(body.session || '').trim();
    const id = /^[0-9a-f]{64}$/.test(session)
      ? env.WATCH.idFromString(session)
      : env.WATCH.newUniqueId();
    const stub = env.WATCH.get(id);
    const res = await stub.fetch('https://watch/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xpub })
    });
    const payload = await res.json();
    if (res.status !== 200) return json(payload, res.status);
    return json(Object.assign({}, payload, { watch: true, session: id.toString() }));
  }

  const cfg = electrumConfig(env);
  if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);

  let client;
  try {
    client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
  } catch (e) {
    return fail('Electrum indisponível: ' + (e && e.message ? e.message : e), 502);
  }
  try {
    const scanner = await new WalletScanner({
      env, xpub, account, client, gap: cfg.gap, maxScan: cfg.maxScan
    }).init();
    const payload = await scanner.fullSync();
    return json(Object.assign({}, payload, { watch: false }));
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

async function handleEvents(request, env, url) {
  const session = String(url.searchParams.get('session') || '').trim();
  if (!/^[0-9a-f]{64}$/.test(session)) return fail('sessão inválida', 400);
  if (!env.WATCH) return fail('tempo real não configurado (sem o Durable Object WATCH)', 503);
  const stub = env.WATCH.get(env.WATCH.idFromString(session));
  // o upgrade vai como veio (mesmo Request), o DO aceita /api/events
  return await stub.fetch(request);
}

export { WalletWatcher };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        const cfg = electrumConfig(env);
        return json({
          ok: true,
          service: 'projeto-2-electrum',
          source: 'electrum',
          storage: 'nenhum',
          realtime: !!env.WATCH,
          electrum: cfg ? cfg.servers.map(s => s.host + ':' + s.port + (s.secure ? ' tls' : ' tcp')) : 'off',
          time: new Date().toISOString()
        });
      }
      if (url.pathname === '/api/wallet') {
        if (request.method !== 'POST') return fail('use POST', 405);
        return await handleWallet(request, env);
      }
      if (url.pathname === '/api/events') return await handleEvents(request, env, url);
      if (url.pathname.startsWith('/api/')) return fail('rota não encontrada', 404);
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('not found', { status: 404 });
    } catch (e) {
      return fail(e && e.message ? e.message : String(e), 500);
    }
  }
};
