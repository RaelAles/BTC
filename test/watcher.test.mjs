/* Teste do Durable Object de tempo real sem Cloudflare: servidor Electrum
   falso que empurra notificações, D1 em memória e um par de WebSocket
   mínimo. Verifica assinatura, aviso → atualização incremental → push, e
   o encerramento quando não há tela aberta.

   node test/watcher.test.mjs */
import assert from 'node:assert/strict';
import { WalletWatcher } from '../src/watcher.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { MemoryDB } from './memory-db.mjs';
import { makeTx } from './tx-fixture.mjs';
import { sha256Hex } from '../src/config.js';

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
class FakeStorage {
  constructor() { this.alarmAt = null; }
  async setAlarm(t) { this.alarmAt = t; }
  async getAlarm() { return this.alarmAt; }
  async deleteAlarm() { this.alarmAt = null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const ua = parseXpub(USER);
const hash = await sha256Hex(USER);

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

const db = new MemoryDB();
const env = {
  DB: db,
  ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
  ELECTRUM_TIMEOUT_MS: '5000'
};
const storage = new FakeStorage();
const state = { id: { name: hash }, storage };
const watcher = new WalletWatcher(state, env);

/* 1. sincronização inicial + assinaturas */
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
  const subs = fake.count('blockchain.scripthash.subscribe');
  assert.ok(subs >= 160, 'assina todos os endereços conhecidos (' + subs + ')');
  assert.equal(fake.count('blockchain.transaction.get'), 1);
  console.log('ok   sync inicial e assinatura de todos os scripthashes (' + subs + ')');
}

/* 2. WebSocket recebe o estado atual na abertura */
const { client } = await watcher.openSocket();
assert.equal(client.messages.length, 1);
assert.equal(JSON.parse(client.messages[0]).type, 'payload');
assert.ok(storage.alarmAt, 'keepalive agendado com tela aberta');

/* 3. notificação → atualização incremental → push */
{
  const tx2 = makeTx([{ txid: tx1.txid, vout: 0 }], [{ value: 9000, script: a1.script }]);
  fake.txs.set(tx2.txid, tx2.raw);
  fake.histories.get(sh0).push({ height: 700100, tx_hash: tx2.txid });
  fake.histories.set(sh1, [{ height: 700100, tx_hash: tx2.txid }]);

  fake.notify(sh0);
  fake.notify(sh1);
  await sleep(30);
  assert.ok(storage.alarmAt, 'aviso agenda o alarme (debounce)');

  const subsBefore = fake.count('blockchain.scripthash.subscribe');
  await watcher.alarm();

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
  assert.equal(pushed.payload.receive.path, "m/84'/0'/0'/0/2", 'índice avançou');

  assert.ok(fake.count('blockchain.scripthash.subscribe') > subsBefore,
    'endereços novos da cauda de gap foram assinados');
  assert.equal(fake.count('blockchain.transaction.get'), 2, 'só a transação nova foi baixada');

  const saved = db.addresses.find(a => a.address === a1.address && a.account_type === 'bip84');
  assert.equal(saved.balance, 9000, 'D1 atualizado pelo DO');
  console.log('ok   notificação atualiza só o endereço afetado, avança o índice e empurra pelo WebSocket');
}

/* 4. sem tela aberta o objeto para de monitorar e libera para dormir */
{
  client.close();
  await sleep(10);
  assert.equal(watcher.sockets.size, 0);
  await watcher.alarm();
  assert.equal(watcher.client, null, 'conexão Electrum fechada');
  assert.equal(storage.alarmAt, null, 'sem alarme: o DO pode hibernar');
  console.log('ok   sem tela aberta fecha a conexão e remove o alarme');
}

/* 5. o Worker encaminha para o Durable Object quando o binding existe */
{
  const worker = (await import('../src/worker.js')).default;
  const db2 = new MemoryDB();
  const env2 = {
    DB: db2,
    ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
    ELECTRUM_TIMEOUT_MS: '5000'
  };
  const storage2 = new FakeStorage();
  const watcher2 = new WalletWatcher({ id: { name: hash }, storage: storage2 }, env2);
  env2.WATCH = {
    idFromName: (name) => name,
    get: (id) => ({
      // imita o stub do Durable Object: aceita string ou Request
      fetch: (input, init) => watcher2.fetch(typeof input === 'string' ? new Request(input, init) : input)
    })
  };
  const res = await worker.fetch(new Request('https://x/api/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpub: USER })
  }), env2);
  const payload = await res.json();
  assert.equal(res.status, 200);
  assert.equal(payload.watch, true, 'a resposta avisa que o tempo real está ligado');
  assert.equal(payload.balance.detected, 9000);
  assert.ok(watcher2.subs.size > 0, 'o DO é quem segura as assinaturas');

  const bad = await worker.fetch(new Request('https://x/api/events?hash=xyz'), env2);
  assert.equal(bad.status, 400);
  console.log('ok   Worker encaminha /api/wallet para o DO e valida o hash do WebSocket');
}

await fake.close();
console.log('\ntestes do watcher passaram');
