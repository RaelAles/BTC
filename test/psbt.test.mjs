/* Teste do envio: taxa ao vivo, escolha de UTXO, PSBT sem assinatura e a
   assinatura no núcleo do projeto 1 (btc-core). Sem rede: servidor Electrum
   falso. A carteira é derivada dos 256 bits, então as chaves privadas do
   teste são as mesmas que o projeto 1 usaria.

   node test/psbt.test.mjs */
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { preparePsbt, sendLimits } from '../src/psbt.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

setConnectOverride(nodeConnect);

const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);

async function reqPsbt(body, env) {
  const r = await worker.fetch(new Request('https://x/api/psbt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), env);
  return { status: r.status, j: await r.json() };
}
async function reqFees(env) {
  const r = await worker.fetch(new Request('https://x/api/fees'), env);
  return { status: r.status, j: await r.json() };
}
function mapFind(map, type) {
  return map.find(e => e.key.length > 0 && e.key[0] === type) || null;
}

/* ---------------- 1. taxa ao vivo em três níveis ---------------- */
{
  const fake = await startFakeElectrum({});
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.levels, { low: 2, medium: 6, high: 12 }, 'BTC/kvB → sat/vB inteiro');
  assert.deepEqual(r.j.targets, { low: 144, medium: 6, high: 1 });
  assert.equal(r.j.source, 'electrum');
  console.log('ok   taxa ao vivo em três níveis (baixa, média, alta)');
  await fake.close();
}

/* ---------------- 1b. níveis que o teto inteiro iguala ---------------- */
{
  /* 1,003 e 1,299 sat/vB viram 2 os dois no teto: a alta sobe para 3 para a
     escada continuar distinta. A baixa, 0,113 sat/vB, continua em 1. */
  const fake = await startFakeElectrum({
    fees: { 1: 0.00001299, 6: 0.00001003, 144: 0.00000113 }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.levels, { low: 1, medium: 2, high: 3 },
    'estimativas distintas não repetem o mesmo sat/vB');
  console.log('ok   níveis distintos mesmo quando o teto inteiro os iguala');
  await fake.close();
}

/* ---------------- 2. envio bip84 acima da varredura do assinante ---------------- */
{
  const account = parseXpub(hd.accounts.bip84.xpub);
  /* 0, 49 e 99 estendem a varredura até 149: com isso o índice 120 entra na
     margem e o PSBT pode ser assinado mesmo fora do fallback de 100 do
     assinante. */
  const addrIdx = [0, 49, 99, 120];
  const rows = [];
  const histories = {};
  const txs = {};
  for (let i = 0; i < addrIdx.length; i++) {
    const a = await deriveAddress('bip84', account, 0, addrIdx[i]);
    const tx = makeTx([{ txid: String(i + 10).repeat(2).padEnd(64, '0'), vout: 0 }],
      [{ value: 30000, script: a.script }]);
    histories[scripthash(a.script)] = [{ height: 800000 + i, tx_hash: tx.txid }];
    txs[tx.txid] = tx.raw;
    rows.push(a);
  }
  const fake = await startFakeElectrum({ histories, txs });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const other = BTC.derive('10' + '0'.repeat(254));
  const destination = other.addresses.p2wpkh;

  /* 30 000 + 30 000: enviar 50 000 obriga duas entradas. */
  const r = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 5
  }, env);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const j = r.j;
  assert.equal(j.inputs.length, 2, 'duas entradas para cobrir 50 000 sats');
  assert.equal(j.total_in, 60000);
  assert.equal(j.change.value, j.total_in - 50000 - j.fee_sats);
  assert.ok(j.fee_sats >= Math.ceil(5 * j.vsize), 'taxa cobre a vsize estimada a 5 sat/vB');
  assert.ok(j.change.value >= 546, 'troco acima do pó');
  assert.equal(j.change.path, "m/84'/0'/0'/1/0");
  assert.equal(j.outputs[0].address, destination);
  assert.equal(j.outputs[0].value, 50000);
  assert.equal(j.outputs[1].own, true);

  const bytes = BTC.psbtParseInput(j.psbt);
  const psbt = BTC.parsePsbt(bytes);
  assert.equal(psbt.tx.inputs.length, 2);
  assert.equal(psbt.tx.outputs[1].value, BigInt(j.change.value));
  /* a origem leva a impressão digital da conta (o que a xpub permite) */
  const fp = BTC.bytesToHex(BTC.hash160(account.pub)).slice(0, 8);
  const deriv = mapFind(psbt.inputs[0], 0x06);
  assert.equal(BTC.bytesToHex(deriv.value.subarray(0, 4)), fp);
  assert.equal(psbt.outputs[1].some(e => e.key[0] === 0x02), true, 'troco tem origem no PSBT');

  /* o assinante (núcleo do chave-btc.html) acha as chaves mesmo com o índice
     120, que fica fora da varredura de 100 do fallback. */
  const signed = await BTC.signPsbt(bytes, hd, new Uint8Array(32));
  assert.equal(signed.txid, BTC.txidOf(BTC.readTx(BTC.hexToBytes(signed.txHex))));
  const final = BTC.readTx(BTC.hexToBytes(signed.txHex));
  assert.equal(final.inputs.length, 2);
  assert.equal(final.outputs[0].value, 50000n);
  assert.equal(final.outputs[1].value, BigInt(j.change.value));
  assert.equal(BTC.addressFromScript(final.outputs[0].script), destination);
  assert.equal(signed.fee, BigInt(j.fee_sats));
  assert.ok(signed.vsize > 0);
  assert.ok(signed.feerate > 4.5, 'taxa efetiva perto dos 5 sat/vB pedidos');

  const review = await BTC.analyzePsbt(bytes, hd);
  assert.equal(review.outputs[1].own, 'troco', 'o assinante reconhece o troco');

  /* erros claros antes de qualquer assinatura */
  const badAddr = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: 'bc1qnaoexiste',
    amount_sats: 50000, fee_rate: 5
  }, env);
  assert.equal(badAddr.status, 400);
  assert.match(badAddr.j.error, /endereço de destino/);

  const poor = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 200000, fee_rate: 5
  }, env);
  assert.equal(poor.status, 400);
  assert.match(poor.j.error, /saldo insuficiente/);

  const lowFee = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 0
  }, env);
  assert.equal(lowFee.status, 400);
  assert.match(lowFee.j.error, /taxa inválida/);

  console.log('ok   psbt bip84 com troco, origem da conta e assinatura no btc-core');
  await fake.close();
}

/* ---------------- 3. p2pkh com non_witness_utxo ---------------- */
{
  const account = parseXpub(hd.accounts.bip44.xpub);
  const a = await deriveAddress('bip44', account, 0, 0);
  const tx = makeTx([{ txid: '20'.repeat(32), vout: 0 }], [{ value: 90000, script: a.script }]);
  const fake = await startFakeElectrum({
    histories: { [scripthash(a.script)]: [{ height: 800100, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const other = BTC.derive('11' + '0'.repeat(254));
  const destination = other.addresses.p2pkh;
  const r = await reqPsbt({
    xpub: hd.accounts.bip44.xpub, address: destination,
    amount_sats: 70000, fee_rate: 3
  }, env);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(r.j.psbt));
  const nwu = mapFind(psbt.inputs[0], 0x00);
  assert.ok(nwu, 'p2pkh leva non_witness_utxo');
  assert.equal(BTC.txidOf(BTC.readTx(nwu.value)), tx.txid);
  const signed = await BTC.signPsbt(BTC.psbtParseInput(r.j.psbt), hd, new Uint8Array(32));
  assert.ok(signed.txHex.length > 0);
  assert.equal(signed.outputs[0].value, 70000n);
  console.log('ok   psbt p2pkh com non_witness_utxo e assinatura');
  await fake.close();
}

/* ---------------- 4. taproot direto no montador ---------------- */
{
  const account = parseXpub(hd.accounts.bip86.xpub);
  const a = await deriveAddress('bip86', account, 0, 150);
  const change = await deriveAddress('bip86', account, 1, 0);
  const row = (x, chain, idx) => ({
    address: x.address, path: x.path, script: BTC.bytesToHex(x.script),
    pub: BTC.bytesToHex(x.pub), kind: 'p2tr', account_type: 'bip86', chain, idx
  });
  const utxos = [{
    txid: '30'.repeat(32), vout: 0, value: 200000,
    script: BTC.bytesToHex(a.script), height: 800200,
    row: row(a, 0, 150)
  }];
  const destination = BTC.derive('01' + '0'.repeat(254)).addresses.p2tr;
  const limits = sendLimits({ utxos, address: destination, feeRate: 4 });
  assert.equal(limits.available_sats, 200000);
  assert.equal(limits.max_send_sats, 200000 - limits.fee_sats_at_max);
  assert.equal(limits.min_sats, 546);

  const prepared = await preparePsbt({
    account,
    utxos,
    address: destination,
    amountSats: 120000, feeRate: 4,
    changeRow: row(change, 1, 0),
    rawTxFor: async () => null
  });

  /* preview com o valor: devolve a taxa e o troco exatos do PSBT, para a tela
     mostrar a taxa ao lado do valor antes de montar qualquer coisa. */
  const atAmount = sendLimits({
    utxos, address: destination, feeRate: 4, amountSats: 120000,
    changeScript: change.script
  });
  assert.equal(atAmount.amount_sats, 120000);
  assert.equal(atAmount.fee_sats, prepared.fee_sats);
  assert.equal(atAmount.change_sats, prepared.change.value);
  assert.equal(atAmount.inputs_used, 1);

  /* valor acima do máximo fica sem taxa no preview (a tela já mostra o erro) */
  const overMax = sendLimits({
    utxos, address: destination, feeRate: 4, amountSats: 200000,
    changeScript: change.script
  });
  assert.equal(overMax.fee_sats, null);

  /* no máximo não sobra troco: a taxa da transação sem saída de troco é
     exatamente a devolvida pelo preview. */
  const atMax = await preparePsbt({
    account, utxos, address: destination,
    amountSats: limits.max_send_sats, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor: async () => null
  });
  assert.equal(atMax.change, null);
  assert.equal(atMax.fee_sats, limits.fee_sats_at_max);
  assert.equal(atMax.total_out, limits.max_send_sats);
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(prepared.psbt));
  const tap = mapFind(psbt.inputs[0], 0x16);
  assert.ok(tap, 'entrada taproot leva tap_bip32_derivation');
  assert.equal(tap.value[0], 0);
  const signed = await BTC.signPsbt(BTC.psbtParseInput(prepared.psbt), hd, new Uint8Array(32));
  assert.equal(signed.outputs[0].value, 120000n);
  assert.ok(signed.feerate > 3.5);
  const review = await BTC.analyzePsbt(BTC.psbtParseInput(prepared.psbt), hd);
  assert.equal(review.outputs[1].own, 'troco', 'o troco taproot é reconhecido');
  console.log('ok   psbt taproot (bip86) com troco e assinatura');
}

console.log('\ntestes de envio/psbt passaram');
