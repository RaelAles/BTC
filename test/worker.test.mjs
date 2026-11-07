/* Teste de ponta a ponta do Worker sem rede: servidor Electrum falso +
   D1 em memória. Verifica a conta de saldo/recebido/enviado por endereço,
   o próximo endereço, o cache de transações e a ausência de outra fonte.

   node test/worker.test.mjs */
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { startFakeElectrum, nodeConnect, deadPort } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';
import { MemoryDB as DB } from './memory-db.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const ua = parseXpub(USER);

/* ---------------- helpers ---------------- */
function req(xpub) {
  return new Request('https://x/api/wallet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xpub })
  });
}
async function run(xpub, db, env) {
  const r = await worker.fetch(req(xpub), Object.assign({ DB: db }, env || {}));
  return { status: r.status, j: await r.json() };
}
const sh = async (type, chain, idx) => scripthash((await deriveAddress(type, ua, chain, idx)).script);
async function addr(type, chain, idx) { return await deriveAddress(type, ua, chain, idx); }

setConnectOverride(nodeConnect);

/* ---------------- 1. saldo, recebido, enviado e próximo endereço ---------------- */
{
  const a0 = await addr('bip84', 0, 0);
  const a1 = await addr('bip84', 0, 1);
  const [sh0, sh1] = [scripthash(a0.script), scripthash(a1.script)];
  const tx1 = makeTx([{ txid: '00'.repeat(32), vout: 0 }], [{ value: 10000, script: a0.script }]);
  const tx2 = makeTx([{ txid: tx1.txid, vout: 0 }], [{ value: 9000, script: a1.script }]);

  const fake = await startFakeElectrum({
    histories: {
      [sh0]: [{ height: 700000, tx_hash: tx1.txid }, { height: 700100, tx_hash: tx2.txid }],
      [sh1]: [{ height: 700100, tx_hash: tx2.txid }]
    },
    txs: { [tx1.txid]: tx1.raw, [tx2.txid]: tx2.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const db = new DB();

  const r = await run(USER, db, env);
  assert.equal(r.status, 200);
  assert.equal(r.j.detected_type, 'bip84');
  assert.match(r.j.source, /electrum/);
  assert.equal(r.j.balance.detected, 9000);
  assert.equal(r.j.balance.total, 9000);
  assert.equal(r.j.balance.extras, 0);
  assert.deepEqual(r.j.extras, []);

  const used = r.j.addresses;
  assert.equal(used.length, 2, 'só os endereços usados vão para a resposta');
  const row0 = used.find(x => x.address === a0.address);
  const row1 = used.find(x => x.address === a1.address);
  assert.deepEqual(
    { received: row0.received, spent: row0.spent, balance: row0.balance, tx: row0.tx_count },
    { received: 10000, spent: 10000, balance: 0, tx: 2 }
  );
  assert.deepEqual(
    { received: row1.received, spent: row1.spent, balance: row1.balance, tx: row1.tx_count },
    { received: 9000, spent: 0, balance: 9000, tx: 1 }
  );
  assert.equal(r.j.receive.address, (await addr('bip84', 0, 2)).address, 'próximo = último usado + 1');
  assert.equal(r.j.receive.path, "m/84'/0'/0'/0/2");
  assert.equal(fake.count('blockchain.transaction.get'), 2, 'uma busca por transação');

  const before = fake.count('blockchain.transaction.get');
  const r2 = await run(USER, db, env);
  assert.equal(r2.j.balance.total, 9000);
  assert.equal(fake.count('blockchain.transaction.get'), before, 'transação já está no cache do D1');
  assert.equal(db.txCount(), 2);

  /* gasto novo: a1 manda 8500 de volta para a0 */
  const tx3 = makeTx([{ txid: tx2.txid, vout: 0 }], [{ value: 8500, script: a0.script }]);
  fake.txs.set(tx3.txid, tx3.raw);
  fake.histories.get(sh0).push({ height: 700200, tx_hash: tx3.txid });
  fake.histories.get(sh1).push({ height: 700200, tx_hash: tx3.txid });

  const r3 = await run(USER, db, env);
  const u0 = r3.j.addresses.find(x => x.address === a0.address);
  const u1 = r3.j.addresses.find(x => x.address === a1.address);
  assert.equal(u0.received, 18500);
  assert.equal(u0.spent, 10000);
  assert.equal(u0.balance, 8500);
  assert.equal(u0.tx_count, 3);
  assert.equal(u1.received, 9000);
  assert.equal(u1.spent, 9000);
  assert.equal(u1.balance, 0);
  assert.equal(r3.j.balance.total, 8500);
  assert.equal(db.txCount(), 3);

  console.log('ok   saldo/recebido/enviado por endereço, próximo índice e cache de transações');
  await fake.close();
}

/* ---------------- 2. união dos tipos + prioridade da detecção ---------------- */
{
  const t86 = await addr('bip86', 0, 0);
  const t84 = await addr('bip84', 0, 3);
  const txA = makeTx([{ txid: '01'.repeat(32), vout: 0 }], [{ value: 5000, script: t86.script }]);
  const txB = makeTx([{ txid: '02'.repeat(32), vout: 0 }], [{ value: 7000, script: t84.script }]);
  const fake = await startFakeElectrum({
    histories: {
      [scripthash(t86.script)]: [{ height: 700000, tx_hash: txA.txid }],
      [scripthash(t84.script)]: [{ height: 700000, tx_hash: txB.txid }]
    },
    txs: { [txA.txid]: txA.raw, [txB.txid]: txB.raw }
  });
  const db = new DB();
  const r = await run(USER, db, {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000'
  });
  assert.equal(r.j.detected_type, 'bip86', 'com xpub: bip44 → bip86 → bip84 → bip49');
  assert.equal(r.j.balance.detected, 5000);
  const extra = r.j.extras.find(e => e.type === 'bip84');
  assert.ok(extra, 'o outro tipo com histórico entra nos extras');
  assert.equal(extra.balance, 7000);
  assert.equal(r.j.balance.total, 12000);
  assert.equal(r.j.receive.path, "m/86'/0'/0'/0/1");
  assert.equal(r.j.extras.find(e => e.type === 'bip84').address, (await addr('bip84', 0, 4)).address);

  /* mempool entra no saldo */
  const memTx = makeTx([{ txid: '03'.repeat(32), vout: 0 }], [{ value: 1234, script: t86.script }]);
  fake.txs.set(memTx.txid, memTx.raw);
  fake.mempool.set(scripthash(t86.script), [{ height: 0, tx_hash: memTx.txid }]);
  const r2 = await run(USER, db, {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000'
  });
  assert.equal(r2.j.balance.detected, 6234, 'transação no mempool conta no saldo');
  const u86 = r2.j.addresses.find(x => x.address === t86.address);
  assert.equal(u86.tx_count, 2);

  console.log('ok   união dos quatro tipos, prioridade de detecção e mempool');
  await fake.close();
}

/* ---------------- 3. sem Electrum não há outra fonte ---------------- */
{
  const db = new DB();
  const r = await run(USER, db, {
    ELECTRUM_SERVERS: '127.0.0.1:' + (await deadPort()) + ':tcp', ELECTRUM_TIMEOUT_MS: '800'
  });
  assert.equal(r.status, 502, 'erro explícito em vez de cair para Esplora');
  assert.match(r.j.error, /Electrum indisponível/);
  assert.equal(db.addresses.length, 0);

  const off = await run(USER, new DB(), { ELECTRUM_SERVERS: 'off' });
  assert.equal(off.status, 503);

  console.log('ok   sem Electrum a resposta é erro claro (nenhum fallback)');
}

console.log('\ntestes do worker passaram');
