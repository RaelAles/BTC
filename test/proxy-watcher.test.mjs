/* Durable Object de notificações: recebe só scripthashes, assina no Electrum
   e devolve o scripthash alterado. Não guarda carteira. */
import assert from 'node:assert/strict';
import { ProxyWatcher } from '../src/proxy-watcher.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { parseXpub, deriveAddress } from '../src/derivation.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

class FakeSocket {
  constructor() {
    this.other = null;
    this.messages = [];
    this.listeners = new Map();
    this.closed = false;
  }
  accept() {}
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(data) { if (!this.closed) this.other.messages.push(data); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.other.closed = true;
    this.fire('close');
    this.other.fire('close');
  }
  fire(type, ev) { for (const fn of (this.listeners.get(type) || [])) fn(ev || { type }); }
}
let lastPair = null;
globalThis.WebSocketPair = class {
  constructor() {
    const a = new FakeSocket();
    const b = new FakeSocket();
    a.other = b;
    b.other = a;
    this[0] = a;
    this[1] = b;
    lastPair = this;
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const row = await deriveAddress('bip84', parseXpub(USER), 0, 0);
const sh = scripthash(row.script);
const tx = makeTx([{ txid: 'ee'.repeat(32), vout: 0 }], [{ value: 10000, script: row.script }]);
const fake = await startFakeElectrum({
  histories: { [sh]: [{ height: 700000, tx_hash: tx.txid }] },
  txs: { [tx.txid]: tx.raw }
});
setConnectOverride(nodeConnect);
const watcher = new ProxyWatcher({}, {
  ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
  ELECTRUM_TIMEOUT_MS: '5000'
});

const pair = watcher.connectSocket();
const server = pair.server;
const client = pair.client;
server.fire('message', { data: JSON.stringify({ type: 'subscribe', scripthashes: [sh] }) });
await sleep(200);
assert.ok(watcher.subs.has(sh), 'assinatura registrada');
assert.equal(fake.count('blockchain.scripthash.subscribe'), 1);

/* O DO também executa lotes do proxy na mesma conexão da assinatura. */
const batch = await watcher.fetch(new Request('https://watch/proxy', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [
    { method: 'blockchain.scripthash.get_history', params: [sh] },
    { method: 'blockchain.scripthash.get_mempool', params: [sh] }
  ] })
}));
assert.equal(batch.status, 200);
const batchJson = await batch.json();
assert.equal(batchJson.results[0][0].tx_hash, tx.txid);
assert.equal(fake.count('server.version'), 1, 'a mesma conexão serve assinatura e proxy');

fake.notify(sh);
await sleep(100);
const messages = client.messages.map(m => JSON.parse(m));
assert.ok(messages.some(m => m.type === 'scripthash' && m.scripthash === sh),
  'aviso devolve só o scripthash');

assert.equal(watcher.xpub, undefined, 'o objeto não tem xpub');
assert.equal(watcher.scanner, undefined, 'o objeto não tem scanner de carteira');
assert.equal(watcher.subs.size, 1, 'só mantém a assinatura');
server.close();
await watcher.stop();
await fake.close();
console.log('ok   ProxyWatcher só transporta scripthashes');
