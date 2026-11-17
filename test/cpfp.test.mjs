/* Teste do CPFP: a aba histórico agrupa por txid e a rota /api/cpfp monta a
   transação filha que gasta uma saída própria do pai e devolve o resto para a
   carteira. Sem rede: servidor Electrum falso e assinatura no btc-core, o
   mesmo núcleo do Cofre BTC.

   node test/cpfp.test.mjs */
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

setConnectOverride(nodeConnect);

const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);
const account = parseXpub(hd.accounts.bip84.xpub);
const other = BTC.derive('10' + '0'.repeat(254));

function postJson(path, body, env) {
  return worker.fetch(new Request('https://x' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), env).then(async r => ({ status: r.status, j: await r.json() }));
}

/* Carteira com uma saída confirmada (100 000 sats) e uma transação pai
   pendente que manda 60 000 para fora e 39 000 para o troco; a diferença de
   1 000 sats é a taxa do pai. */
const a0 = await deriveAddress('bip84', account, 0, 0);
const change0 = await deriveAddress('bip84', account, 1, 0);
const funding = makeTx([{ txid: 'a1'.repeat(32), vout: 0 }],
  [{ value: 100000, script: a0.script }]);
const dest = other.addresses.p2wpkh;
const parent = makeTx(
  [{ txid: funding.txid, vout: 0 }],
  [
    { value: 60000, script: BTC.scriptFromAddress(dest) },
    { value: 39000, script: change0.script }
  ]
);
const fake = await startFakeElectrum({
  histories: {
    [scripthash(a0.script)]: [
      { height: 800000, tx_hash: funding.txid },
      { height: 0, tx_hash: parent.txid }
    ],
    [scripthash(change0.script)]: [{ height: 0, tx_hash: parent.txid }]
  },
  txs: {
    [funding.txid]: funding.raw,
    [parent.txid]: parent.raw
  }
});
const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
const xpub = hd.accounts.bip84.xpub;

/* ---------------- 1. histórico agrupado por txid ---------------- */
{
  const r = await postJson('/api/wallet', { xpub }, env);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const txs = r.j.transactions || [];
  assert.equal(txs.length, 2, 'duas transações: a que financia e a que gasta');
  const grouped = new Map();
  txs.forEach(t => grouped.set(t.txid, (grouped.get(t.txid) || 0) + 1));
  assert.deepEqual([...grouped.values()], [1, 1], 'cada txid aparece uma vez');
  const p = txs.find(t => t.txid === parent.txid);
  assert.ok(p, 'a transação pai está no extrato');
  assert.equal(p.pending, true);
  assert.equal(p.direction, 'out');
  assert.equal(p.sent_sats, 60000, 'o valor enviado é a saída externa');
  assert.equal(p.received_sats, 39000, 'o troco é a saída própria');
  assert.equal(p.fee_sats, 1000, 'a taxa do pai é entradas - saídas');
  assert.equal(p.cpfp.eligible, true, 'há troco próprio não gasto para acelerar');
  assert.equal(p.cpfp.output.address, change0.address);
  assert.equal(p.addresses.length, 2, 'entrada e troco agrupados no mesmo txid');
  console.log('ok   histórico agrupado por txid e CPFP elegível');
}

/* ---------------- 2. /api/cpfp monta a filha e o pacote ---------------- */
{
  const target = 20;
  const r = await postJson('/api/cpfp', {
    xpub, txid: parent.txid, fee_rate: target
  }, env);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const j = r.j;
  assert.equal(j.parent.txid, parent.txid);
  assert.equal(j.parent.fee_sats, 1000);
  assert.equal(j.parent.vsize, BTC.vsizeOf(parent.tx));
  assert.ok(j.fee_sats > 0, 'a filha paga uma taxa extra');
  assert.equal(j.input.txid, parent.txid);
  assert.equal(j.input.vout, 1);
  assert.equal(j.output.value, 39000 - j.fee_sats, 'o retorno sai do troco do pai');
  assert.equal(j.output.own, 'troco');
  assert.equal(j.output.address, (await deriveAddress('bip84', account, 1, 1)).address,
    'o retorno vai para o próximo endereço de troco');
  assert.equal(j.package.fee_sats, j.parent.fee_sats + j.fee_sats);
  assert.equal(j.package.vsize, j.parent.vsize + j.vsize);
  assert.ok(j.package.fee_rate >= target - 1e-9,
    'a taxa do pacote atinge o alvo: ' + j.package.fee_rate);
  assert.equal(j.rbf, false, 'a filha não sinaliza RBF');

  const psbt = BTC.parsePsbt(BTC.psbtParseInput(j.psbt));
  assert.equal(psbt.tx.inputs.length, 1);
  assert.equal(psbt.tx.inputs[0].txid, parent.txid);
  assert.equal(psbt.tx.inputs[0].vout, 1);
  assert.equal(psbt.tx.outputs.length, 1);
  assert.equal(Number(psbt.tx.outputs[0].value), j.output.value);
  assert.ok(psbt.inputs[0].some(e => e.key[0] === 0x00),
    'a entrada leva non_witness_utxo (a transação pai)');
  assert.ok(psbt.outputs[0].some(e => e.key[0] === 0x02),
    'a saída de retorno leva origem BIP32');
  const review = await BTC.analyzePsbt(BTC.psbtParseInput(j.psbt), hd);
  assert.equal(review.outputs[0].own, 'troco',
    'o núcleo do Cofre reconhece a saída da filha como troco');
  assert.equal(review.inputs[0].outpoint, parent.txid + ':1');

  /* A filha assinada é aceita pelo conferidor do Monitor: a entrada é um
     UTXO conhecido (o troco pendente) e a saída é da carteira. */
  const signed = await BTC.signPsbt(BTC.psbtParseInput(j.psbt), hd, new Uint8Array(32));
  const preview = await postJson('/api/broadcast', {
    xpub, psbt: signed.psbtBase64, preview: true
  }, env);
  assert.equal(preview.status, 200, JSON.stringify(preview.j));
  assert.equal(preview.j.inputs[0].outpoint, parent.txid + ':1');
  assert.equal(preview.j.outputs[0].own, 'troco');
  assert.equal(fake.broadcasts.length, 0, 'o preview não transmite');
  console.log('ok   psbt da filha montado, assinado e conferido (pacote e retorno)');
}

/* ---------------- 3. recusas ---------------- */
{
  const confirmed = await postJson('/api/cpfp', {
    xpub, txid: funding.txid, fee_rate: 20
  }, env);
  assert.equal(confirmed.status, 400);
  assert.match(confirmed.j.error, /já foi confirmada/);

  const low = await postJson('/api/cpfp', {
    xpub, txid: parent.txid, fee_rate: 1
  }, env);
  assert.equal(low.status, 400);
  assert.match(low.j.error, /já paga a taxa alvo/);

  const missing = await postJson('/api/cpfp', {
    xpub, txid: 'f'.repeat(64), fee_rate: 20
  }, env);
  assert.equal(missing.status, 400);
  assert.match(missing.j.error, /não encontrada/);
  console.log('ok   CPFP recusa confirmada, taxa já coberta e txid desconhecido');
}

/* ---------------- 4. pacote com ancestral pendente ---------------- */
{
  const change1 = await deriveAddress('bip84', account, 1, 1);
  const fund2 = makeTx([{ txid: 'b2'.repeat(32), vout: 0 }],
    [{ value: 100000, script: a0.script }]);
  const parentA = makeTx([{ txid: fund2.txid, vout: 0 }], [
    { value: 30000, script: BTC.scriptFromAddress(dest) },
    { value: 69000, script: change0.script }
  ]);
  const parentB = makeTx([{ txid: parentA.txid, vout: 1 }], [
    { value: 60000, script: BTC.scriptFromAddress(dest) },
    { value: 8000, script: change1.script }
  ]);
  const fake2 = await startFakeElectrum({
    histories: {
      [scripthash(a0.script)]: [
        { height: 800000, tx_hash: fund2.txid },
        { height: 0, tx_hash: parentA.txid }
      ],
      [scripthash(change0.script)]: [
        { height: 0, tx_hash: parentA.txid },
        { height: 0, tx_hash: parentB.txid }
      ],
      [scripthash(change1.script)]: [{ height: 0, tx_hash: parentB.txid }]
    },
    txs: {
      [fund2.txid]: fund2.raw,
      [parentA.txid]: parentA.raw,
      [parentB.txid]: parentB.raw
    }
  });
  const env2 = { ELECTRUM_SERVERS: '127.0.0.1:' + fake2.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await postJson('/api/cpfp', {
    xpub, txid: parentB.txid, fee_rate: 20
  }, env2);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.package.ancestors, 1, 'o pacote inclui a transação A');
  assert.equal(r.j.package.fee_sats, 2000 + r.j.fee_sats,
    'a taxa do pacote soma A, B e a filha');
  assert.equal(r.j.package.vsize,
    BTC.vsizeOf(parentA.tx) + BTC.vsizeOf(parentB.tx) + r.j.vsize);
  assert.ok(r.j.package.fee_rate >= 20 - 1e-9, 'o pacote inteiro atinge o alvo');
  await fake2.close();
  console.log('ok   pacote CPFP soma o pai e o ancestral ainda no mempool');
}

await fake.close();
console.log('\ntestes do CPFP passaram');
