import { parseXpub } from './derivation.js';
import { openElectrum, estimateFees } from './electrum.js';
import { WalletScanner } from './wallet-sync.js';
import { electrumConfig, fail, json } from './config.js';
import { WalletWatcher } from './watcher.js';
import BTC from './btc-core.js';

/* Projeto 2 — rotas HTTP.

   `POST /api/wallet`  → estado da carteira (saldo, endereços usados).
                         Com o binding WATCH, quem faz o trabalho é o
                         Durable Object de tempo real (conexão Electrum
                         reaproveitada + assinaturas); sem ele, a consulta
                         é avulsa (dev/testes).
   `POST /api/psbt`    → monta o PSBT de envio (sem assinatura) com os UTXOs
                         da carteira e a taxa escolhida. A chave privada
                         não passa por aqui; quem assina é o projeto 1.
   `GET  /api/fees`    → taxa estimada pelo Electrum em três níveis
                         (baixa, média, alta), em sat/vB.
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
      body: JSON.stringify({ xpub, scan: body.scan === 'step' ? 'step' : '' })
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
      env, xpub, account, client
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

function sessionId(value) {
  const s = String(value || '').trim();
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

/* Parâmetros do envio validados antes de consultar o Electrum. */
function sendTarget(body) {
  const address = String(body.address || '').trim();
  if (!address) throw new Error('informe o endereço de destino');
  try { BTC.scriptFromAddress(address); }
  catch (e) { throw new Error('endereço de destino: ' + e.message); }
  const feeRate = Number(body.fee_rate);
  if (!Number.isInteger(feeRate) || feeRate < 1 || feeRate > 10000) {
    throw new Error('taxa inválida: use de 1 a 10 000 sat/vB');
  }
  return { address, feeRate };
}

function sendParams(body) {
  const target = sendTarget(body);
  const amountSats = Number(body.amount_sats);
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('valor inválido');
  if (amountSats > 2100000000000000) throw new Error('valor acima do limite do bitcoin');
  return { ...target, amountSats };
}

async function handlePsbt(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return fail('informe a xpub');
  let account;
  try { account = parseXpub(xpub); }
  catch (e) { return fail(xpubHint(xpub) || e.message); }
  const preview = body.preview === true;
  let params;
  try { params = preview ? sendTarget(body) : sendParams(body); }
  catch (e) { return fail(e.message); }

  const session = sessionId(body.session);
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xpub, preview, ...params })
    });
    const payload = await res.json();
    // sessão despejada: refaz a varredura avulsa e monta o PSBT do mesmo jeito
    if (res.status !== 409) return json(payload, res.status);
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
    const scanner = await new WalletScanner({ env, xpub, account, client }).init();
    await scanner.fullSync();
    return json(preview ? scanner.limits(params) : await scanner.prepare(params));
  } catch (e) {
    return fail(e && e.message ? e.message : String(e), 400);
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

async function handleFees(env, url) {
  const session = sessionId(url.searchParams.get('session'));
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/fees');
    if (res.status === 200) return new Response(res.body, res);
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
    return json(await estimateFees(client));
  } finally {
    try { await client.close(); } catch (e) {}
  }
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
      if (url.pathname === '/api/psbt') {
        if (request.method !== 'POST') return fail('use POST', 405);
        return await handlePsbt(request, env);
      }
      if (url.pathname === '/api/fees') return await handleFees(env, url);
      if (url.pathname === '/api/events') return await handleEvents(request, env, url);
      if (url.pathname.startsWith('/api/')) return fail('rota não encontrada', 404);
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('not found', { status: 404 });
    } catch (e) {
      return fail(e && e.message ? e.message : String(e), 500);
    }
  }
};
