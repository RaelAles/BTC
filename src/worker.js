import { parseXpub } from './derivation.js';
import { openElectrum } from './electrum.js';
import { WalletScanner } from './wallet-sync.js';
import { electrumConfig, fail, json, sha256Hex } from './config.js';
import { WalletWatcher } from './watcher.js';

/* Projeto 2 — rotas HTTP.

   `POST /api/wallet`  → estado da carteira (saldo, endereços usados).
                         Com o binding WATCH, quem faz o trabalho é o
                         Durable Object de tempo real (conexão Electrum
                         reaproveitada + assinaturas); sem ele, a consulta
                         é avulsa (dev/testes).
   `GET  /api/events`  → WebSocket do Durable Object, que empurra o estado
                         novo quando um scripthash muda.
   `GET  /api/health`  → configuração efetiva.

   Sem chave privada em lugar nenhum. */

async function handleWallet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return fail('informe a xpub');
  let account;
  try { account = parseXpub(xpub); } catch (e) { return fail(e.message); }
  const hash = await sha256Hex(xpub);

  if (env.WATCH) {
    const stub = env.WATCH.get(env.WATCH.idFromName(hash));
    const res = await stub.fetch('https://watch/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xpub })
    });
    const payload = await res.json();
    if (res.status !== 200) return json(payload, res.status);
    return json(Object.assign({}, payload, { watch: true }));
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
      env, xpub, account, hash, client, maxScan: cfg.maxScan
    }).init();
    const payload = await scanner.fullSync();
    return json(Object.assign({}, payload, { watch: false }));
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

async function handleEvents(request, env, url) {
  const hash = String(url.searchParams.get('hash') || '').trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) return fail('hash da xpub inválido', 400);
  if (!env.WATCH) return fail('tempo real não configurado (sem o Durable Object WATCH)', 503);
  const stub = env.WATCH.get(env.WATCH.idFromName(hash));
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
