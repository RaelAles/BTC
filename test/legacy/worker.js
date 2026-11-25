import { parseXpub } from '../../src/derivation.js';
import { openElectrum, estimateFees } from '../../src/electrum.js';
import { WalletScanner } from '../../src/wallet-sync.js';
import { electrumConfig, fail, json, SECURITY_HEADERS } from '../../src/config.js';
import { feeRateKvb } from '../../src/psbt.js';
import { broadcastSignedPsbt, previewSignedPsbt, MAX_PSBT_TEXT } from '../../src/broadcast.js';
import { WalletWatcher } from './watcher.js';
import { normalizeWatchRequest } from './watch-set.js';
import BTC from '../../src/btc-core.js';

/* Tetos de entrada antes de qualquer decodificação custosa: uma xpub válida
   tem 111 caracteres e um endereço mainnet cabe em 90. */
const MAX_XPUB_LENGTH = 111;
const MAX_ADDRESS_LENGTH = 90;

/* Monitor BTC — rotas HTTP.

   `POST /api/wallet`  → estado da carteira (saldo, endereços usados).
                         Recebe o conjunto já derivado pelo navegador.
                         Com o binding WATCH, quem faz o trabalho é o
                         Durable Object de tempo real (conexão Electrum
                         reaproveitada + assinaturas); sem ele, a consulta
                         é avulsa (dev/testes).
   `POST /api/raw`     → transações cruas do conjunto; o navegador monta o
                         PSBT localmente.
   `POST /api/psbt`    → legado: monta o PSBT no servidor. A tela não usa.
   `POST /api/cpfp`   → legado: monta o CPFP no servidor. A tela não usa.
   `POST /api/broadcast` → confere o PSBT assinado contra a carteira e
                         (sem `preview`) publica a transação final no
                         Electrum. Só transmite o que gasta entradas desta
                         carteira.
   `GET  /api/fees`    → taxa estimada (o `estimatefee` de 2 blocos do
                         Bitcoin Core), em sat/vB.
   `GET  /api/events?session=…` → WebSocket do Durable Object, que empurra
                         o estado novo quando um scripthash muda.
   `GET  /api/health`  → configuração efetiva.

   Nada é gravado: o D1 não existe mais. A tela deriva a xpub localmente e
   manda só o conjunto de endereços; ele vive na memória do Durable Object
   durante a sessão e é descartado quando a última tela fecha. Sem chave
   privada em lugar nenhum. */

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

/* Corpo que o Worker manda ao Durable Object: o fluxo novo leva só o
   conjunto derivado, nunca a xpub. */
function watchWire(wr) {
  const out = {
    wallet_id: wr.walletId,
    fingerprint: wr.fingerprint,
    version_type: wr.versionType
  };
  if (wr.watch) out.watch = wr.watch;
  else out.watch_add = wr.watchAdd;
  return out;
}

/* Lê a carteira de uma rota: conjunto watch, xpub legado ou nenhum (sessão
   já aberta no Durable Object). */
function walletInput(body) {
  let wr = null;
  try { wr = normalizeWatchRequest(body); }
  catch (e) { return { error: e.message }; }
  if (wr) return { wr, xpub: '', account: null };
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return { wr: null, xpub: '', account: null };
  if (xpub.length > MAX_XPUB_LENGTH) return { error: 'xpub grande demais' };
  try { return { wr: null, xpub, account: parseXpub(xpub) }; }
  catch (e) { return { error: xpubHint(xpub) || e.message }; }
}

function inputWire(input) {
  return input.wr ? watchWire(input.wr) : { xpub: input.xpub };
}

function scannerFor(env, input, client) {
  if (input.wr) {
    return new WalletScanner({
      env,
      watch: input.wr.watch || input.wr.watchAdd,
      walletId: input.wr.walletId,
      fingerprint: input.wr.fingerprint,
      versionType: input.wr.versionType,
      client
    });
  }
  return new WalletScanner({ env, xpub: input.xpub, account: input.account, client });
}

async function handleWallet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  let wr = null;
  try { wr = normalizeWatchRequest(body); }
  catch (e) { return fail(e.message); }
  let xpub = '';
  let account = null;
  if (!wr) {
    xpub = String(body.xpub || '').trim();
    if (!xpub) return fail('informe a xpub');
    if (xpub.length > MAX_XPUB_LENGTH) return fail('xpub grande demais');
    try { account = parseXpub(xpub); }
    catch (e) { return fail(xpubHint(xpub) || e.message); }
  }

  if (env.WATCH) {
    // sessão = id aleatório do Durable Object; nunca derivado da xpub.
    // O cliente devolve o id nas próximas consultas para reaproveitar a
    // conexão e as assinaturas enquanto a tela estiver aberta.
    const session = String(body.session || '').trim();
    const hasSession = /^[0-9a-f]{64}$/.test(session);
    const id = hasSession ? env.WATCH.idFromString(session) : env.WATCH.newUniqueId();
    const stub = env.WATCH.get(id);
    const text = JSON.stringify(wr
      ? watchWire(wr)
      : { xpub, scan: body.scan === 'step' ? 'step' : '' });
    const post = (target) => target.fetch('https://watch/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text
    });
    let res = await post(stub);
    let payload = await res.json();
    // o DO fixa a carteira por sessão: o id que veio do cliente era de
    // outra carteira. Sessão de tela não vale como credencial; começa outra.
    if (res.status === 409 && hasSession) {
      const fresh = env.WATCH.newUniqueId();
      res = await post(env.WATCH.get(fresh));
      payload = await res.json();
      if (res.status === 200) {
        return json(Object.assign({}, payload, { watch: true, session: fresh.toString() }));
      }
      return json(payload, res.status);
    }
    if (res.status !== 200) return json(payload, res.status);
    return json(Object.assign({}, payload, { watch: true, session: id.toString() }));
  }

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
    const scanner = await new WalletScanner({
      env,
      ...(wr
        ? {
          watch: wr.watch || wr.watchAdd,
          walletId: wr.walletId,
          fingerprint: wr.fingerprint,
          versionType: wr.versionType
        }
        : { xpub, account }),
      client
    }).init();
    const payload = await scanner.fullSync();
    return json(Object.assign({}, payload, { watch: false }));
  } catch (e) {
    return scanFailure(e, client);
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

/* Parâmetros do envio validados antes de consultar o Electrum. O valor é
   opcional: no preview ele só acrescenta a taxa daquele valor à resposta,
   junto com `quote_rates` (as taxas extras pedidas na mesma consulta). */
function sendTarget(body) {
  const address = String(body.address || '').trim();
  if (!address) throw new Error('informe o endereço de destino');
  if (address.length > MAX_ADDRESS_LENGTH) throw new Error('endereço de destino grande demais');
  try { BTC.scriptFromAddress(address); }
  catch (e) { throw new Error('endereço de destino: ' + e.message); }
  const feeRate = Number(body.fee_rate);
  // valida a faixa (aceita as casas decimais do estimador); a conversão para
  // sat/kvB e a conta da taxa acontecem em psbt.js
  feeRateKvb(feeRate);
  return {
    address,
    feeRate,
    amountSats: amountSatsOf(body),
    quoteRates: quoteRatesOf(body)
  };
}

/* Taxas extras que o preview cota para o mesmo valor (a taxa em vigor na
   tela). São só números: cada cotação faz a mesma seleção de entradas. */
function quoteRatesOf(body) {
  if (body.quote_rates == null) return null;
  if (!Array.isArray(body.quote_rates)) throw new Error('taxas de cotação inválidas');
  const rates = [];
  for (const value of body.quote_rates) {
    const rate = Number(value);
    feeRateKvb(rate);
    if (!rates.includes(rate)) rates.push(rate);
  }
  return rates.length ? rates : null;
}

function amountSatsOf(body) {
  if (body.amount_sats == null || body.amount_sats === '') return null;
  const amountSats = Number(body.amount_sats);
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('valor inválido');
  if (amountSats > 2100000000000000) throw new Error('valor acima do limite do bitcoin');
  return amountSats;
}

function sendParams(body) {
  const params = sendTarget(body);
  if (params.amountSats == null) throw new Error('valor inválido');
  return params;
}

function scanFailure(e, client) {
  /* Falha de transporte (Electrum caiu no meio do scan) não é erro de
     validação: a tela trata 400 como formulário inválido. */
  const transport = (client && client.dead) || (e && e.failures);
  return fail(e && e.message ? e.message : '' + e, transport ? 502 : 400);
}

async function handlePsbt(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const input = walletInput(body);
  if (input.error) return fail(input.error);
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
      body: JSON.stringify({ ...inputWire(input), preview, ...params })
    });
    const payload = await res.json();
    // sem carteira no corpo, a sessão é a única credencial: deixa o 409
    // chegar à tela, que refaz o /api/wallet e tenta de novo
    if (res.status !== 409 || (!input.wr && !input.xpub)) return json(payload, res.status);
  }
  if (!input.wr && !input.xpub) return fail('informe a xpub');

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
    const scanner = await scannerFor(env, input, client).init();
    await scanner.fullSync();
    return json(preview ? scanner.limits(params) : await scanner.prepare(params));
  } catch (e) {
    return scanFailure(e, client);
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

/* O PSBT assinado vem do Cofre BTC. A conferência cruza cada entrada com os
   scripts/UTXOs do conjunto observado; com sessão, o DO reaproveita a
   conexão e, ao transmitir, as assinaturas já avisam a tela do estado novo. */
/* CPFP: a filha gasta uma saída da transação pendente. O corpo é só o txid
   do pai e a taxa-alvo; o servidor escolhe a saída, calcula o pacote e monta
   o PSBT sem assinatura. A chave privada continua no Cofre BTC. */
async function handleCpfp(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const input = walletInput(body);
  if (input.error) return fail(input.error);
  const txid = String(body.txid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return fail('txid inválido');
  const feeRate = Number(body.fee_rate);
  try { feeRateKvb(feeRate); }
  catch (e) { return fail(e.message); }

  const session = sessionId(body.session);
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/cpfp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...inputWire(input), txid, feeRate })
    });
    const payload = await res.json();
    if (res.status !== 409 || (!input.wr && !input.xpub)) return json(payload, res.status);
  }
  if (!input.wr && !input.xpub) return fail('informe a xpub');

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
    const scanner = await scannerFor(env, input, client).init();
    await scanner.fullSync();
    return json(await scanner.prepareCpfp({ txid, feeRate }));
  } catch (e) {
    return scanFailure(e, client);
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

/* Transações cruas do conjunto observado: o navegador usa para conferir os
   UTXOs e montar o PSBT localmente, sem o servidor escolher moedas. */
async function handleRaw(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const input = walletInput(body);
  if (input.error) return fail(input.error);
  const session = sessionId(body.session);
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inputWire(input))
    });
    const payload = await res.json();
    if (res.status !== 409 || (!input.wr && !input.xpub)) return json(payload, res.status);
  }
  if (!input.wr && !input.xpub) return fail('informe a xpub');

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
    const scanner = await scannerFor(env, input, client).init();
    await scanner.fullSync();
    return json({ raw: scanner.rawTransactions() });
  } catch (e) {
    return scanFailure(e, client);
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

async function handleBroadcast(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const input = walletInput(body);
  if (input.error) return fail(input.error);
  const psbt = String(body.psbt || '');
  if (!psbt.trim()) return fail('informe o psbt assinado');
  if (psbt.length > MAX_PSBT_TEXT) return fail('psbt grande demais para conferir');
  const preview = body.preview === true;

  const session = sessionId(body.session);
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...inputWire(input), psbt, preview })
    });
    const payload = await res.json();
    if (res.status !== 409 || (!input.wr && !input.xpub)) return json(payload, res.status);
  }
  if (!input.wr && !input.xpub) return fail('informe a xpub');

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
    const scanner = await scannerFor(env, input, client).init();
    await scanner.fullSync();
    return json(preview
      ? previewSignedPsbt({ scanner, psbtText: psbt })
      : await broadcastSignedPsbt({ client, scanner, psbtText: psbt }));
  } catch (e) {
    return scanFailure(e, client);
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

async function handleFees(env, url) {
  const session = sessionId(url.searchParams.get('session'));
  if (env.WATCH && session) {
    const stub = env.WATCH.get(env.WATCH.idFromString(session));
    const res = await stub.fetch('https://watch/fees');
    if (res.status === 200) {
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    }
  }
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
    return json(await estimateFees(client));
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

export { WalletWatcher };

/* Páginas HTML publicadas de verdade. A SPA fallback do asset layer
   (wrangler.jsonc) responde 200 com index.html em qualquer caminho
   desconhecido; fora estes caminhos, essa resposta vira 404 para o caminho
   não parecer um arquivo existente para scanners e clientes. A tela 404 do
   app continua sendo desenhada, porque o corpo é o mesmo index.html. */
const HTML_ROUTES = new Set(['/', '/index.html', '/cofre-btc', '/cofre-btc.html']);

/* Cabeçalhos de reescrita de caminho pertencem a um proxy interno. Aceitos
   do cliente, deixam um scanner achar que `/` e `/.git` são o mesmo recurso
   (alerta "Bypassing 403" do ZAP). O Worker usa só o caminho da URL e não
   repassa nenhum deles ao asset layer. */
const REWRITE_HEADERS = ['x-original-url', 'x-rewrite-url', 'x-forwarded-prefix'];

function hasRewriteHeader(request) {
  return REWRITE_HEADERS.some(name => request.headers.has(name));
}

function isSpaFallback(pathname, response) {
  if (HTML_ROUTES.has(pathname) || response.status !== 200) return false;
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  return type.startsWith('text/html');
}

/* Aplica os cabeçalhos de segurança em toda resposta, inclusive nos
   estáticos do ASSETS. O 101 do WebSocket não é recriado: o handshake
   original é o único que vale. */
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

/* Rate por IP em balde de fichas. Sem credencial nenhuma, um laço externo
   vira custo direto de CPU/rede. O balde repõe fichas continuamente, então
   o limite é de ritmo (não uma janela fixa que zera de uma vez) e uma
   carteira grande pode continuar logo após uma pausa curta. O estado vive
   só na memória do isolate (não é durável): serve para conter rajada e
   pedido repetido, não como cota exata.
   A varredura é uma ação só, dividida em passos de até 200 endereços, e
   por isso tem orçamento próprio: uma carteira grande não esbarra no teto
   das rotas avulsas. */
const RATE_WINDOW_MS = 60000;
const RATE_MAX_REQUESTS = 120;
const RATE_MAX_SCAN_REQUESTS = 600;
const RATE_MAX_SCANS = 6;
const RATE_REFILL_PER_MS = RATE_MAX_REQUESTS / RATE_WINDOW_MS;
const RATE_SCAN_REFILL_PER_MS = RATE_MAX_SCAN_REQUESTS / RATE_WINDOW_MS;
const rateBuckets = new Map(); // ip -> { general, scan, scans }

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
      general: { tokens: RATE_MAX_REQUESTS, updated: now },
      scan: { tokens: RATE_MAX_SCAN_REQUESTS, updated: now },
      scans: 0
    };
    rateBuckets.set(ip, bucket);
  }
  refill(bucket.general, now, RATE_MAX_REQUESTS, RATE_REFILL_PER_MS);
  refill(bucket.scan, now, RATE_MAX_SCAN_REQUESTS, RATE_SCAN_REFILL_PER_MS);
  if (rateBuckets.size > 2000) {
    for (const [key, value] of rateBuckets) {
      const idle = now - Math.max(value.general.updated, value.scan.updated);
      if (idle >= RATE_WINDOW_MS && value.scans === 0) rateBuckets.delete(key);
    }
  }
  return bucket;
}

function tooMany(waitMs) {
  const retry = Math.max(1, Math.ceil(waitMs / 1000));
  return new Response(JSON.stringify({ error: 'muitos pedidos; tente de novo em ' + retry + ' s' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': String(retry)
    }
  });
}

/* Freio de contagem, sem consumir slot de varredura: usado também nas rotas
   leves (fees/events) que ainda abrem conexão ou instanciam um objeto.
   `scan` escolhe o orçamento da varredura, que é separado do das demais
   rotas para não punir carteiras grandes. */
async function withRateLimit(request, run, scan = false) {
  const bucket = rateBucket(clientIp(request));
  const counter = scan ? bucket.scan : bucket.general;
  const perMs = scan ? RATE_SCAN_REFILL_PER_MS : RATE_REFILL_PER_MS;
  if (counter.tokens < 1) {
    return tooMany((1 - counter.tokens) / perMs);
  }
  counter.tokens--;
  return await run();
}

/* Rate por IP + teto de varreduras simultâneas para as rotas que derivam
   endereços. O slot é liberado no finally, mesmo quando o handler falha. */
async function withScanSlot(request, run, scan = false) {
  return await withRateLimit(request, async () => {
    const bucket = rateBucket(clientIp(request));
    if (bucket.scans >= RATE_MAX_SCANS) return tooMany(1000);
    bucket.scans++;
    try {
      return await run();
    } finally {
      bucket.scans--;
    }
  }, scan);
}

async function route(request, env) {
  const url = new URL(request.url);
  try {
    if (hasRewriteHeader(request)) return fail('cabeçalho de reescrita de caminho não é aceito', 400);
    if (url.pathname === '/api/health') {
      const cfg = electrumConfig(env);
      return json({
        ok: true,
        service: 'monitor-btc-electrum',
        source: 'electrum',
        storage: 'nenhum',
        realtime: !!env.WATCH,
        electrum: cfg && cfg.error ? cfg.error : cfg
          ? cfg.servers.map(s => s.host + ':' + s.port + (s.secure ? ' tls' : ' tcp'))
          : 'off',
        time: new Date().toISOString()
      });
    }
    if (url.pathname === '/api/wallet') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withScanSlot(request, () => handleWallet(request, env), true);
    }
    if (url.pathname === '/api/psbt') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withScanSlot(request, () => handlePsbt(request, env));
    }
    if (url.pathname === '/api/cpfp') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withScanSlot(request, () => handleCpfp(request, env));
    }
    if (url.pathname === '/api/raw') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withScanSlot(request, () => handleRaw(request, env), true);
    }
    if (url.pathname === '/api/broadcast') {
      if (request.method !== 'POST') return fail('use POST', 405);
      return await withScanSlot(request, () => handleBroadcast(request, env));
    }
    if (url.pathname === '/api/fees') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail('use GET', 405);
      return await withRateLimit(request, () => handleFees(env, url));
    }
    if (url.pathname === '/api/events') {
      return await withRateLimit(request, () => handleEvents(request, env, url));
    }
    if (url.pathname.startsWith('/api/')) return fail('rota não encontrada', 404);
    /* O site é só leitura: nenhum método além de GET/HEAD tem o que fazer
       no asset layer. Responde 405 mesmo se a borda deixar passar. */
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

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await route(request, env));
  }
};
