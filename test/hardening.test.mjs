/* Robustez de borda: tetos de entrada, freio de abuso, Origin do WebSocket
   e validação da configuração do Electrum. Tudo sem rede.
   node test/hardening.test.mjs */
import assert from 'node:assert/strict';
import worker from './legacy/worker.js';
import { parseXpub } from '../src/derivation.js';
import { electrumConfig } from '../src/config.js';
import { WalletWatcher } from './legacy/watcher.js';
import { setConnectOverride } from '../src/electrum.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';

async function post(path, body, env, ip) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['cf-connecting-ip'] = ip;
  const r = await worker.fetch(new Request('https://x' + path, {
    method: 'POST', headers, body: JSON.stringify(body)
  }), env || {});
  return { status: r.status, j: await r.json() };
}

/* ---------------- 1. tetos antes da decodificação quadrática ---------------- */
{
  /* xpub: recusa pelo tamanho, sem passar pelo base58 O(n²) */
  assert.throws(() => parseXpub('xpub' + '1'.repeat(2000000)), /tamanho inválido/);

  const hugeXpub = 'xpub' + '1'.repeat(2000000);
  const wallet = await post('/api/wallet', { xpub: hugeXpub });
  assert.equal(wallet.status, 400);
  assert.match(wallet.j.error, /xpub grande demais/);

  /* endereço: recusado antes de scriptFromAddress */
  const psbt = await post('/api/psbt', {
    xpub: USER, address: 'bc1' + 'q'.repeat(200000), amount_sats: 1000, fee_rate: 2
  }, { ELECTRUM_SERVERS: 'off' });
  assert.equal(psbt.status, 400);
  assert.match(psbt.j.error, /endereço de destino grande demais/);

  /* base58 gigante também é barrado no próprio decodificador */
  assert.throws(() => BTC.scriptFromAddress('1'.repeat(200)), /grande demais/);

  /* PSBT: o teto já existia; continua antes de qualquer parse */
  const broadcast = await post('/api/broadcast', {
    xpub: USER, psbt: 'x'.repeat(400001)
  }, { ELECTRUM_SERVERS: 'off' });
  assert.equal(broadcast.status, 400);
  assert.match(broadcast.j.error, /psbt grande demais/);

  console.log('ok   xpub/endereço/PSBT têm teto antes da decodificação');
}

/* ---------------- 2. configuração do Electrum ---------------- */
{
  for (const bad of ['abc', '0', '-1', 'NaN']) {
    const cfg = electrumConfig({ ELECTRUM_TIMEOUT_MS: bad });
    assert.ok(cfg.error, 'timeout inválido (' + bad + ') vira erro explícito');
    assert.match(cfg.error, /ELECTRUM_TIMEOUT_MS/);
  }
  const cfg = electrumConfig({});
  assert.ok(Array.isArray(cfg.servers) && cfg.servers.length > 0);
  assert.ok(cfg.servers.every(s => s.secure === true), 'fallback padrão só usa TLS');
  assert.equal(cfg.timeoutMs, 8000);
  console.log('ok   timeout inválido não cai em default nem em negativo; fallback só TLS');
}

/* ---------------- 3. freio de abuso também em /api/fees ---------------- */
{
  const ip = '203.0.113.77';
  const env = { ELECTRUM_SERVERS: 'off' };
  let last;
  for (let i = 0; i < 120; i++) {
    last = await worker.fetch(new Request('https://x/api/fees', {
      headers: { 'cf-connecting-ip': ip }
    }), env);
    assert.notEqual(last.status, 429, 'pedido ' + (i + 1) + ' ainda passa');
  }
  /* o balde repõe fichas: o 121º pode passar se o teste demorar, então
     procura o 429 em vez de exigir que ele venha exatamente no 121º. */
  let blocked = null;
  for (let i = 0; i < 120 && !blocked; i++) {
    const r = await worker.fetch(new Request('https://x/api/fees', {
      headers: { 'cf-connecting-ip': ip }
    }), env);
    if (r.status === 429) blocked = r;
  }
  assert.ok(blocked, 'o freio devolve 429 depois da rajada');
  assert.ok(Number(blocked.headers.get('Retry-After')) >= 1);
  const body = await blocked.json();
  assert.match(body.error, /muitos pedidos/);
  console.log('ok   /api/fees entra no freio de abuso (429 com Retry-After)');
}

/* ---------------- 3b. varredura tem orçamento próprio, maior ---------------- */
{
  const ip = '203.0.113.78';
  const env = { ELECTRUM_SERVERS: 'off' };
  let last;
  for (let i = 0; i < 600; i++) {
    last = await post('/api/wallet', { xpub: USER, scan: 'step' }, env, ip);
    assert.notEqual(last.status, 429, 'passo ' + (i + 1) + ' da varredura ainda passa');
  }
  let blocked = null;
  for (let i = 0; i < 600 && !blocked; i++) {
    const r = await post('/api/wallet', { xpub: USER, scan: 'step' }, env, ip);
    if (r.status === 429) blocked = r;
  }
  assert.ok(blocked, 'o teto da varredura continua existindo');
  assert.match(blocked.j.error, /muitos pedidos/);

  const fees = await worker.fetch(new Request('https://x/api/fees', {
    headers: { 'cf-connecting-ip': ip }
  }), env);
  assert.notEqual(fees.status, 429, 'orçamento da varredura não consome o das rotas avulsas');
  console.log('ok   varredura tem 600 passos/min por IP, separados dos 120 das outras rotas');
}

/* ---------------- 4. queda no meio da varredura vira 502, não 500 ---------------- */
{
  setConnectOverride(nodeConnect);
  const fake = await startFakeElectrum({ closeAfter: 'blockchain.scripthash.get_history' });
  const r = await worker.fetch(new Request('https://x/api/wallet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpub: USER })
  }), {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
    ELECTRUM_TIMEOUT_MS: '5000'
  });
  const j = await r.json();
  assert.equal(r.status, 502, 'transporte caiu no meio da varredura: 502');
  assert.match(j.error, /conexão Electrum|nenhum servidor|fechada/i);
  await fake.close();
  console.log('ok   falha de transporte no caminho avulso de /api/wallet é 502');
}

/* ---------------- 5. Origin do handshake WebSocket ---------------- */
{
  const watcher = new WalletWatcher({}, {});
  const evil = await watcher.events(new Request(
    'https://x/api/events?session=' + 'a'.repeat(64), {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' }
    }));
  assert.equal(evil.status, 403);
  assert.match((await evil.json()).error, /origem não permitida/);

  /* sem Origin (cliente não-navegador) a credencial continua sendo a sessão */
  const noOrigin = await watcher.events(new Request(
    'https://x/api/events?session=' + 'a'.repeat(64), {
      headers: { Upgrade: 'websocket' }
    }));
  assert.equal(noOrigin.status, 409, 'sessão sem xpub responde 409');
  console.log('ok   Origin diferente do host é recusado no handshake do WebSocket');
}

console.log('\ntestes de robustez de borda passaram');
