/* Teste do RBF: a transação pendente que sinaliza BIP125 pode ser
   substituída pelas mesmas entradas, com a taxa extra tirada do troco.
   Sem rede: servidor Electrum falso e assinatura no btc-core.

   node test/rbf.test.mjs */
import assert from 'node:assert/strict';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, openElectrum, setConnectOverride } from '../src/electrum.js';
import { WalletScanner } from '../src/wallet-sync.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

setConnectOverride(nodeConnect);

const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);
const account = parseXpub(hd.accounts.bip84.xpub);
const receive = await deriveAddress('bip84', account, 0, 0);
const change = await deriveAddress('bip84', account, 1, 0);
const destination = BTC.derive('10' + '0'.repeat(254)).addresses.p2wpkh;
const externalScript = BTC.scriptFromAddress(destination);

const funding = makeTx(
  [{ txid: 'a1'.repeat(32), vout: 0 }],
  [{ value: 100000, script: receive.script }]
);

function spend(sequence, outputs) {
  const tx = {
    version: 2,
    inputs: [{
      txid: funding.txid, vout: 0,
      scriptSig: new Uint8Array(0), sequence
    }],
    outputs: outputs.map(o => ({ value: BigInt(o.value), script: o.script })),
    witnesses: [], locktime: 0, segwit: false
  };
  return { tx, raw: BTC.bytesToHex(BTC.writeTx(tx, false)), txid: BTC.txidOf(tx) };
}

async function scanWith(parent) {
  const histories = {
    [scripthash(receive.script)]: [
      { height: 800000, tx_hash: funding.txid },
      { height: 0, tx_hash: parent.txid }
    ]
  };
  if (parent.change) {
    histories[scripthash(change.script)] = [{ height: 0, tx_hash: parent.txid }];
  }
  const fake = await startFakeElectrum({
    histories,
    txs: {
      [funding.txid]: funding.raw,
      [parent.txid]: parent.raw
    }
  });
  const client = await openElectrum({
    servers: [{ host: '127.0.0.1', port: fake.port, secure: false }],
    timeoutMs: 5000
  });
  const scanner = await new WalletScanner({
    xpub: hd.accounts.bip84.xpub, account, client
  }).init();
  await scanner.fullSync();
  return { fake, client, scanner };
}

/* ---------------- 1. substituição válida ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  const row = (await scanner.payload()).transactions.find(t => t.txid === parent.txid);
  assert.ok(row, 'a transação pendente está no extrato');
  assert.equal(row.rbf.eligible, true, 'a transação sinaliza RBF e tem troco');
  assert.equal(row.rbf.signals, true);

  await assert.rejects(scanner.prepareRbf({ txid: funding.txid, feeRate: 20 }),
    /já foi confirmada/);

  const target = 20;
  const j = await scanner.prepareRbf({ txid: parent.txid, feeRate: target });
  assert.equal(j.old_txid, parent.txid);
  assert.equal(j.rbf, true, 'a substituição sinaliza BIP125');
  assert.ok(j.fee_sats > 1000, 'a substituição paga mais taxa absoluta');
  assert.ok(j.fee_sats >= 1000 + j.vsize, 'a taxa extra cobre ao menos 1 sat/vB');
  assert.ok(j.fee_rate >= target - 1e-9,
    'a substituição atinge a taxa alvo: ' + j.fee_rate);
  assert.ok(j.fee_rate > 1000 / BTC.vsizeOf(parent.tx),
    'a taxa por vbyte é maior que a da original');

  const psbt = BTC.parsePsbt(BTC.psbtParseInput(j.psbt));
  assert.equal(psbt.tx.inputs.length, 1);
  assert.equal(psbt.tx.inputs[0].txid, funding.txid);
  assert.equal(psbt.tx.inputs[0].vout, 0);
  assert.equal(psbt.tx.inputs[0].sequence, 0xfffffffd);
  assert.equal(psbt.tx.outputs.length, 2);
  assert.equal(psbt.tx.outputs[0].value, 60000n, 'o destino externo não muda');
  assert.equal(psbt.tx.outputs[1].value, BigInt(39000 - (j.fee_sats - 1000)),
    'a taxa extra sai do troco');
  assert.ok(psbt.outputs[1].some(e => e.key[0] === 0x02),
    'o troco mantém a origem BIP32');
  const review = await BTC.analyzePsbt(BTC.psbtParseInput(j.psbt), hd);
  assert.equal(review.outputs[0].own, 'externo');
  assert.equal(review.outputs[1].own, 'troco');

  const signed = await BTC.signPsbt(BTC.psbtParseInput(j.psbt), hd, new Uint8Array(32));
  assert.equal(signed.txid, j.txid);
  const final = BTC.readTx(BTC.hexToBytes(signed.txHex));
  assert.equal(final.inputs[0].sequence, 0xfffffffd);
  assert.equal(final.outputs[0].value, 60000n);
  assert.equal(Number(final.outputs[1].value), 39000 - (j.fee_sats - 1000));

  await client.close();
  await fake.close();
  console.log('ok   RBF monta, assina e mantém o destino; a taxa sai do troco');
}

/* ---------------- 2. transação antiga, sem sinal BIP125 ---------------- */
{
  const parent = spend(0xffffffff, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  const row = (await scanner.payload()).transactions.find(t => t.txid === parent.txid);
  assert.equal(row.rbf.eligible, true, 'a substituição também é oferecida sem sinal');
  assert.equal(row.rbf.signals, false);
  const j = await scanner.prepareRbf({ txid: parent.txid, feeRate: 20 });
  assert.equal(j.rbf, true, 'a substituição sinaliza BIP125');
  await client.close();
  await fake.close();
  console.log('ok   transação antiga sem sinal também pode ser substituída (full RBF)');
}

/* ---------------- 3. sem troco para pagar a taxa extra ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 99000, script: externalScript }
  ]);
  const { fake, client, scanner } = await scanWith(parent);
  const row = (await scanner.payload()).transactions.find(t => t.txid === parent.txid);
  assert.equal(row.rbf.eligible, false, 'sem troco não há botão de RBF');
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /não tem troco/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa transação sem troco');
}

console.log('\ntestes de RBF passaram');
