/* Proxy de produção: o Worker só fala Electrum por scripthash/txid e
   transmite a transação assinada. Não há rotas de carteira. */
import assert from 'node:assert/strict';
import worker from '../src/worker-proxy.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { parseXpub, deriveAddress } from '../src/derivation.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const account = parseXpub(USER);
const row = await deriveAddress('bip84', account, 0, 0);
const sh = scripthash(row.script);
const tx = makeTx([{ txid: 'aa'.repeat(32), vout: 0 }], [{ value: 10000, script: row.script }]);

setConnectOverride(nodeConnect);
const fake = await startFakeElectrum({
  histories: { [sh]: [{ height: 700000, tx_hash: tx.txid }] },
  txs: { [tx.txid]: tx.raw }
});
const env = {
  ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp',
  ELECTRUM_TIMEOUT_MS: '5000'
};

async function post(path, body) {
  const r = await worker.fetch(new Request('https://x' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
  return { status: r.status, j: await r.json(), headers: r.headers };
}

/* ---------------- 1. lote de leitura por scripthash/txid ---------------- */
{
  const r = await post('/api/proxy', { items: [
    { method: 'blockchain.scripthash.get_history', params: [sh] },
    { method: 'blockchain.scripthash.get_mempool', params: [sh] },
    { method: 'blockchain.transaction.get', params: [tx.txid] }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.results[0][0].tx_hash, tx.txid);
  assert.deepEqual(r.j.results[1], []);
  assert.equal(r.j.results[2], tx.raw);
  assert.deepEqual(r.j.errors, [null, null, null]);
  assert.ok(r.headers.get('Content-Security-Policy'), 'proxy mantém a CSP');

  const bad = await post('/api/proxy', { items: [
    { method: 'blockchain.scripthash.get_history', params: ['nao-e-hash'] }
  ] });
  assert.equal(bad.status, 400);
  const forbidden = await post('/api/proxy', { items: [
    { method: 'blockchain.transaction.get', params: [tx.txid] },
    { method: 'server.version', params: [] }
  ] });
  assert.equal(forbidden.status, 400);
  assert.match(forbidden.j.error, /método não permitido/);
  console.log('ok   proxy aceita só leitura por scripthash/txid e recusa o resto');
}

/* ---------------- 2. broadcast assinado ---------------- */
{
  const r = await post('/api/proxy', { items: [
    { method: 'blockchain.transaction.broadcast', params: [tx.raw] }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.results[0], tx.txid);
  assert.equal(fake.broadcasts.length, 1);
  const bad = await post('/api/proxy', { items: [
    { method: 'blockchain.transaction.broadcast', params: ['xyz'] }
  ] });
  assert.equal(bad.status, 400);
  console.log('ok   proxy transmite só uma transação assinada e válida');
}

/* ---------------- 3. taxa de uma ou mais fontes ---------------- */
{
  const r = await worker.fetch(new Request('https://x/api/fees'), env);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.ok(j.levels.next > 0);
  assert.ok(Array.isArray(j.sources) && j.sources.length === 1);
  assert.equal(j.source, undefined, 'a taxa não publica host como legenda');
  assert.equal(j.sources[0].source, 'electrum');
  console.log('ok   taxa volta com nível e limites, sem host como legenda');
}

/* ---------------- 4. rotas de carteira não existem ---------------- */
{
  for (const rota of ['/api/wallet', '/api/raw', '/api/psbt', '/api/cpfp', '/api/broadcast']) {
    const r = await worker.fetch(new Request('https://x' + rota, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }), env);
    assert.equal(r.status, 404, rota + ' não deve existir');
  }
  console.log('ok   rotas de carteira antigas não existem no proxy');
}

/* ---------------- 5. sessão e health ---------------- */
{
  const session = 'b'.repeat(64);
  const env2 = Object.assign({}, env, {
    WATCH: {
      newUniqueId: () => ({ toString: () => session }),
      idFromString: () => ({}),
      get: () => ({ fetch: async () => new Response(null, { status: 101 }) })
    }
  });
  const r = await worker.fetch(new Request('https://x/api/session', { method: 'POST' }), env2);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).session, session);
  const health = await worker.fetch(new Request('https://x/api/health'), env2);
  const h = await health.json();
  assert.equal(h.storage, 'nenhum');
  assert.equal(h.realtime, true);
  console.log('ok   sessão do WebSocket e health sem estado');
}

assert.equal(fake.count('server.version'), 1, 'a conexão Electrum é reaproveitada');
await fake.close();
console.log('ok   conexão Electrum reaproveitada entre lotes, taxa e broadcast');
console.log('\ntestes do proxy passaram');
