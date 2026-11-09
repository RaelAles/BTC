/* Teste do Durable Object de tempo real sem Cloudflare: servidor Electrum
   falso que empurra notificações e um par de WebSocket mínimo. O estado
   `storage` do objeto é um proxy que lança em qualquer acesso, para provar
   que o watcher não grava nada. Verifica assinatura, aviso → atualização
   incremental → push, e o descarte total quando a última tela fecha.

   node test/watcher.test.mjs */
import assert from 'node:assert/strict';
import { WalletWatcher } from '../src/watcher.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

/* ---------- shims do runtime ---------- */
class FakeSocket {
  constructor() {
    this.other = null;
    this.messages = [];
    this.listeners = new Map();
    this.closed = false;
    this.accepted = false;
  }
  accept() { this.accepted = true; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(data) {
    if (this.closed) throw new Error('socket fechado');
    this.other.messages.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.other.closed = true;
    this.fire('close');
    this.other.fire('close');
  }
  fire(type) { for (const fn of (this.listeners.get(type) || [])) fn({ type }); }
}
globalThis.WebSocketPair = class {
  constructor() {
    const a = new FakeSocket();
    const b = new FakeSocket();
    a.other = b;
    b.other = a;
    this[0] = a;
    this[1] = b;
  }
};

/* Qualquer tentativa de gravar no Durable Object (put, alarm) estoura. */
const noStorage = new Proxy({}, {
  get(_, key) { throw new Error('o watcher tentou usar storage: ' + String(key)); }
});
const fakeState = () => ({ id: { name: 'sessao-de-teste' }, storage: noStorage });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const ua = parseXpub(USER);

const a0 = await deriveAddress('bip84', ua, 0, 0);
const a1 = await deriveAddress('bip84', ua, 0, 1);
const sh0 = scripthash(a0.script);
const sh1 = scripthash(a1.script);

const tx1 = makeTx([{ txid: '00'.repeat(32), vout: 0 }], [{ value: 10000, script: a0.script }]);
const fake = await startFakeElectrum({
  histories: { [sh0]: [{ height: 700000, tx_hash: tx1.txid }] },
  txs: { [tx1.txid]: tx1.raw }
});
setConnectOverride(nodeConnect);

const env = {
  ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
  ELECTRUM_TIMEOUT_MS: '5000'
};
const watcher = new WalletWatcher(fakeState(), env);

/* 1. sincronização inicial + assinaturas, sem tocar em storage */
{
  const res = await watcher.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpub: USER })
  }));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.detected_type, 'bip84');
  assert.equal(payload.balance.detected, 10000);
  assert.equal(payload.xpub_hash, undefined, 'nem o hash da xpub é devolvido');
  const subs = fake.count('blockchain.scripthash.subscribe');
  assert.ok(subs >= 400, 'assina usados + cauda de gap (' + subs + ')');
  assert.equal(fake.count('blockchain.transaction.get'), 1);
  assert.ok(watcher.idleTimer, 'sem tela aberta agenda o descarte por inatividade (timer em memória)');
  console.log('ok   sync inicial e assinatura de usados + cauda de gap (' + subs + ')');
}

/* 1b. varredura em passos: progresso no primeiro passo, payload no último */
{
  const fakeStep = await startFakeElectrum({});
  const envStep = {
    ELECTRUM_SERVERS: '127.0.0.1:' + fakeStep.port + ':tcp',
    ELECTRUM_TIMEOUT_MS: '5000'
  };
  const w = new WalletWatcher(fakeState(), envStep);
  const step = (body) => w.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
  const p1 = await (await step({ xpub: USER, scan: 'step' })).json();
  assert.equal(p1.scanning, true, 'primeiro passo devolve progresso');
  assert.equal(p1.has_more, true);
  assert.ok(p1.progress.scanned > 0);
  const p2 = await (await step({ xpub: USER, scan: 'step' })).json();
  assert.equal(p2.scanning, false, 'último passo devolve o payload');
  assert.equal(p2.has_more, false);
  assert.equal(p2.balance.total, 0);
  await w.stopSession();
  await fakeStep.close();
  console.log('ok   varredura em passos devolve progresso e só o último passo traz o saldo');
}

/* 2. WebSocket recebe o estado atual na abertura */
const { client } = await watcher.openSocket();
assert.equal(client.messages.length, 1);
assert.equal(JSON.parse(client.messages[0]).type, 'payload');
assert.ok(watcher.keepaliveTimer, 'keepalive em memória com tela aberta');
assert.equal(watcher.idleTimer, null, 'tela aberta cancela o descarte');

/* 3. notificação → atualização incremental → push */
{
  const tx2 = makeTx([{ txid: tx1.txid, vout: 0 }], [{ value: 9000, script: a1.script }]);
  fake.txs.set(tx2.txid, tx2.raw);
  fake.histories.get(sh0).push({ height: 700100, tx_hash: tx2.txid });
  fake.histories.set(sh1, [{ height: 700100, tx_hash: tx2.txid }]);

  fake.notify(sh0);
  fake.notify(sh1);
  await sleep(30);
  assert.ok(watcher.debounceTimer, 'aviso agenda o debounce (timer em memória)');

  const subsBefore = fake.count('blockchain.scripthash.subscribe');
  await watcher.flushDirty();

  assert.equal(client.messages.length, 2, 'empurrou o estado novo');
  const pushed = JSON.parse(client.messages[1]);
  assert.equal(pushed.type, 'payload');
  assert.equal(pushed.payload.balance.detected, 9000);
  const row0 = pushed.payload.addresses.find(x => x.address === a0.address);
  const row1 = pushed.payload.addresses.find(x => x.address === a1.address);
  assert.deepEqual(
    { got: row0.received, spent: row0.spent, bal: row0.balance },
    { got: 10000, spent: 10000, bal: 0 }
  );
  assert.deepEqual({ got: row1.received, spent: row1.spent, bal: row1.balance }, { got: 9000, spent: 0, bal: 9000 });
  assert.equal(pushed.payload.types.find(t => t.detected).path, "m/84'/0'/0'/0/2", 'índice avançou');

  assert.ok(fake.count('blockchain.scripthash.subscribe') > subsBefore,
    'endereços novos da cauda de gap foram assinados');
  assert.equal(fake.count('blockchain.transaction.get'), 2, 'só a transação nova foi baixada');

  /* a sessão guarda endereços e transações só em memória */
  assert.ok(watcher.scanner.byScript.size >= 400, 'endereços derivados continuam na memória da sessão');
  assert.equal(watcher.scanner.txCache.size, 2, 'cache de transações só na memória');
  console.log('ok   notificação atualiza só o endereço afetado, avança o índice e empurra pelo WebSocket');
}

/* 4. conexão Electrum cai: o próximo sync reconecta e reaproveita a sessão */
{
  await watcher.closeClient();
  assert.equal(watcher.client, null);
  const subsBefore = fake.count('blockchain.scripthash.subscribe');
  const res = await watcher.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpub: USER })
  }));
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.balance.detected, 9000);
  assert.ok(watcher.client && !watcher.client.dead, 'conexão nova');
  assert.ok(fake.count('blockchain.scripthash.subscribe') > subsBefore, 'reassinou os scripthashes');
  console.log('ok   queda do Electrum reconecta e reassina sem perder a sessão');
}

/* 5. sem tela aberta o objeto descarta tudo (mantém só a sessão vazia) */
{
  client.close();
  await sleep(50);
  assert.equal(watcher.sockets.size, 0);
  assert.equal(watcher.client, null, 'conexão Electrum fechada');
  assert.equal(watcher.xpub, null, 'xpub descartada');
  assert.equal(watcher.scanner, null, 'endereços derivados descartados');
  assert.equal(watcher.lastPayload, null, 'último payload descartado');
  assert.equal(watcher.keepaliveTimer, null);
  assert.equal(watcher.debounceTimer, null);
  assert.equal(watcher.idleTimer, null);
  console.log('ok   tela fechada encerra conexão, assinaturas, endereços e xpub');
}

/* 6. recarga: fechar e re-sincronizar no mesmo instante preserva a sessão */
{
  const w = new WalletWatcher(fakeState(), env);
  const syncReq = () => w.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpub: USER })
  }));
  await syncReq();
  const { client } = await w.openSocket();
  client.close();          // dispara stopSession (assíncrono)
  await syncReq();         // chega durante o fechamento
  await sleep(50);
  assert.equal(w.xpub, USER, 'sessão reativada não é apagada pelo fechamento anterior');
  assert.ok(w.scanner);
  await w.stopSession();
  assert.equal(w.xpub, null);
  console.log('ok   fechar e re-sincronizar no mesmo instante não perde a sessão nova');
}

/* 7. sessão sem xpub recusa o WebSocket (objeto despejado) */
{
  const empty = new WalletWatcher(fakeState(), env);
  const res = await empty.fetch(new Request('https://watch/events', {
    headers: { Upgrade: 'websocket' }
  }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /sessão expirada/);
  console.log('ok   sessão sem xpub responde 409 para o WebSocket');
}

/* 8. o Worker amarra a consulta a uma sessão aleatória, não à xpub */
{
  const worker = (await import('../src/worker.js')).default;
  const env2 = {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
    ELECTRUM_TIMEOUT_MS: '5000'
  };
  const watcher2 = new WalletWatcher(fakeState(), env2);
  let fetches = 0;
  env2.WATCH = {
    newUniqueId: () => 'f'.repeat(64),
    idFromString: (s) => s,
    get: () => ({
      fetch: (input, init) => {
        fetches++;
        return watcher2.fetch(typeof input === 'string' ? new Request(input, init) : input);
      }
    })
  };
  const post = (body) => worker.fetch(new Request('https://x/api/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env2);

  const res = await post({ xpub: USER });
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.equal(payload.watch, true, 'a resposta avisa que o tempo real está ligado');
  assert.equal(payload.balance.detected, 9000);
  assert.match(payload.session, /^[0-9a-f]{64}$/, 'sessão é um id aleatório, não um hash da xpub');
  assert.notEqual(payload.session, USER);
  assert.ok(watcher2.subs.size > 0, 'o DO é quem segura as assinaturas');
  assert.equal(fetches, 1);

  /* a segunda consulta reaproveita a mesma sessão */
  const res2 = await post({ xpub: USER, session: payload.session });
  const payload2 = await res2.json();
  assert.equal(payload2.session, payload.session);
  assert.equal(fetches, 2);

  /* o WebSocket vai por /api/events?session=… e valida o id */
  const bad = await worker.fetch(new Request('https://x/api/events?session=xyz'), env2);
  assert.equal(bad.status, 400);

  /* taxa e PSBT reaproveitam a conexão e os endereços já derivados */
  const feesRes = await worker.fetch(new Request('https://x/api/fees?session=' + payload.session), env2);
  const fees = await feesRes.json();
  assert.equal(feesRes.status, 200);
  assert.deepEqual(fees.levels, { low: 2, medium: 6, high: 12 });

  const dest = (await deriveAddress('bip44', ua, 0, 0)).address;
  const previewRes = await worker.fetch(new Request('https://x/api/psbt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      xpub: USER, session: payload.session, address: dest,
      fee_rate: 6, preview: true
    })
  }), env2);
  const preview = await previewRes.json();
  assert.equal(previewRes.status, 200, JSON.stringify(preview));
  assert.equal(preview.available_sats, 9000);
  assert.equal(preview.max_send_sats, 9000 - preview.fee_sats_at_max);
  assert.ok(preview.max_send_sats > 0);

  /* o mesmo preview com o valor acrescenta a taxa daquele envio */
  const previewAmount = await (await worker.fetch(new Request('https://x/api/psbt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      xpub: USER, session: payload.session, address: dest,
      fee_rate: 6, preview: true, amount_sats: 5000
    })
  }), env2)).json();
  assert.equal(previewAmount.amount_sats, 5000);
  assert.ok(previewAmount.fee_sats > 0, JSON.stringify(previewAmount));
  assert.equal(previewAmount.max_send_sats, preview.max_send_sats);

  const psbtRes = await worker.fetch(new Request('https://x/api/psbt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      xpub: USER, session: payload.session, address: dest,
      amount_sats: 5000, fee_rate: 6
    })
  }), env2);
  const psbt = await psbtRes.json();
  assert.equal(psbtRes.status, 200, JSON.stringify(psbt));
  assert.equal(psbt.amount_sats, 5000);
  assert.equal(psbt.fee_sats, previewAmount.fee_sats, 'a taxa do preview é a do PSBT');
  assert.ok(psbt.change.value > 0);
  console.log('ok   Worker usa sessão aleatória, taxa e PSBT pela mesma conexão');
}

await fake.close();
console.log('\ntestes do watcher passaram');
