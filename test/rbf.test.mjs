/* Teste do RBF: a transação pendente pode ser substituída pelas mesmas
   entradas, com a taxa extra tirada do troco. Sem rede: servidor Electrum
   falso e assinatura no btc-core.

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
const externalScript2 = BTC.scriptFromAddress(BTC.derive('01' + '0'.repeat(254)).addresses.p2wpkh);

const funding = makeTx(
  [{ txid: 'a1'.repeat(32), vout: 0 }],
  [{ value: 100000, script: receive.script }]
);

function txFrom(inputs, outputs, opts = {}) {
  const tx = {
    version: 2,
    inputs: inputs.map(i => ({
      txid: i.txid, vout: i.vout,
      scriptSig: new Uint8Array(0), sequence: i.sequence
    })),
    outputs: outputs.map(o => ({ value: BigInt(o.value), script: o.script })),
    witnesses: [], locktime: opts.locktime || 0, segwit: false
  };
  return { tx, raw: BTC.bytesToHex(BTC.writeTx(tx, false)), txid: BTC.txidOf(tx) };
}

function spend(sequence, outputs, opts = {}) {
  const inputs = opts.inputs || [{ txid: funding.txid, vout: 0, sequence }];
  return txFrom(inputs, outputs, opts);
}

async function scanWith(parent, opts = {}) {
  const histories = {
    [scripthash(receive.script)]: [
      { height: opts.fundingHeight == null ? 800000 : opts.fundingHeight, tx_hash: funding.txid },
      { height: 0, tx_hash: parent.txid }
    ]
  };
  if (parent.change) {
    histories[scripthash(change.script)] = [{ height: 0, tx_hash: parent.txid }];
  }
  for (const [script, entries] of (opts.histories || [])) {
    const key = scripthash(script);
    histories[key] = (histories[key] || []).concat(entries);
  }
  const txs = {
    [funding.txid]: funding.raw,
    [parent.txid]: parent.raw,
    ...(opts.txs || {})
  };
  const fake = await startFakeElectrum({ histories, txs });
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
  await assert.rejects(scanner.prepareRbf({ txid: 'ff'.repeat(32), feeRate: 20 }),
    /não encontrada nesta carteira/);

  const target = 20;
  const j = await scanner.prepareRbf({ txid: parent.txid, feeRate: target });
  assert.equal(j.old_txid, parent.txid);
  assert.equal(j.rbf, true, 'a substituição sinaliza BIP125');
  assert.ok(j.fee_sats > 1000, 'a substituição paga mais taxa absoluta');
  assert.ok(j.fee_sats >= 1000 + j.vsize, 'a taxa extra cobre ao menos 1 sat/vB');
  assert.ok(j.fee_rate >= target - 1e-9,
    'a substituição atinge a taxa alvo: ' + j.fee_rate);

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

  /* A regra BIP125 3/4 é conferida na transação ASSINADA, com a vsize real,
     e não contra a mesma estimativa que calculou a taxa. */
  const actualFee = 100000n - final.outputs.reduce((sum, out) => sum + out.value, 0n);
  const actualVsize = BTC.vsizeOf(final);
  const parentVsize = BTC.vsizeOf(parent.tx);
  assert.equal(actualFee, BigInt(j.fee_sats), 'a taxa montada é a taxa assinada');
  assert.ok(actualFee >= 1000n + BigInt(actualVsize),
    'a taxa assinada cobre a original + 1 sat/vB da vsize real');
  assert.ok(Number(actualFee) / actualVsize > 1000 / parentVsize,
    'a taxa por vbyte assinada é maior que a da original');

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

/* ---------------- 4. troco pequeno demais para a taxa extra ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 99000, script: externalScript },
    { value: 547, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /faltam \d+ sats para \d+ sats a 20 sat\/vB/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa troco que não cobre a taxa extra');
}

/* ---------------- 5. a original já paga a taxa alvo ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 50000, script: externalScript },
    { value: 48000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 10 }),
    /já paga a taxa alvo; não há o que substituir/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa substituição sem ganho de taxa');
}

/* ---------------- 6. mais de um destino externo ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 30000, script: externalScript },
    { value: 30000, script: externalScript2 },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  const row = (await scanner.payload()).transactions.find(t => t.txid === parent.txid);
  assert.equal(row.rbf.eligible, false, 'dois externos não ganham botão de RBF');
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /mais de um destino externo/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa transação com mais de um destino externo');
}

/* ---------------- 7. entrada ainda não confirmada ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent, { fundingHeight: 0 });
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /entrada ainda não confirmada; use o CPFP/);
  await client.close();
  await fake.close();
  console.log('ok   RBF manda a entrada não confirmada para o CPFP');
}

/* ---------------- 8. saída própria já gasta ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const child = txFrom(
    [{ txid: parent.txid, vout: 1, sequence: 0xffffffff }],
    [{ value: 38000, script: externalScript }]
  );
  const { fake, client, scanner } = await scanWith(parent, {
    histories: [[change.script, [{ height: 0, tx_hash: child.txid }]]],
    txs: { [child.txid]: child.raw }
  });
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /saída própria já gasta/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa pai com troco já gasto por uma filha');
}

/* ---------------- 9. entrada de terceiro ---------------- */
{
  const foreignFunding = makeTx(
    [{ txid: 'b2'.repeat(32), vout: 0 }],
    [{ value: 50000, script: externalScript }]
  );
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 89000, script: change.script }
  ], {
    inputs: [
      { txid: funding.txid, vout: 0, sequence: 0xfffffffd },
      { txid: foreignFunding.txid, vout: 0, sequence: 0xfffffffd }
    ]
  });
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent, {
    histories: [[externalScript, [{ height: 800000, tx_hash: foreignFunding.txid }]]],
    txs: { [foreignFunding.txid]: foreignFunding.raw }
  });
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /nem todas as entradas .* substituição/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa transação com entrada que não é desta carteira');
}

/* ---------------- 10. locktime da original é mantido ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ], { locktime: 500000001 });
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  const j = await scanner.prepareRbf({ txid: parent.txid, feeRate: 20 });
  assert.equal(j.locktime, 500000001);
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(j.psbt));
  assert.equal(psbt.tx.locktime, 500000001, 'a substituição não desagenda a original');
  await client.close();
  await fake.close();
  console.log('ok   RBF preserva o locktime da original');
}

/* ---------------- 11. histórico incompleto ---------------- */
{
  const parent = spend(0xfffffffd, [
    { value: 60000, script: externalScript },
    { value: 39000, script: change.script }
  ]);
  parent.change = true;
  const { fake, client, scanner } = await scanWith(parent);
  scanner.errors = new Map([['ff'.repeat(32), 'transação ilegível']]);
  await assert.rejects(scanner.prepareRbf({ txid: parent.txid, feeRate: 20 }),
    /histórico incompleto/);
  await client.close();
  await fake.close();
  console.log('ok   RBF recusa histórico incompleto');
}

console.log('\ntestes de RBF passaram');
