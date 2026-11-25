/* Teste do envio: taxa ao vivo, escolha de UTXO, PSBT sem assinatura e a
   assinatura no núcleo do Cofre BTC (btc-core). Sem rede: servidor Electrum
   falso. A carteira é derivada dos 256 bits, então as chaves privadas do
   teste são as mesmas que o Cofre BTC usaria.

   node test/psbt.test.mjs */
import assert from 'node:assert/strict';
import worker from './legacy/worker.js';
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

/* ---------------- 1. taxa ao vivo, uma opção só ---------------- */
{
  const fake = await startFakeElectrum({});
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.levels, { next: 11 },
    'o sat/vB da taxa é o exato, não arredondado');
  assert.deepEqual(r.j.sat_per_kvb, { next: 11000 },
    'BTC/kvB × 1e8 dá o sat/kvB inteiro, sem perda');
  assert.deepEqual(r.j.sat_per_vb, { next: 11 });
  assert.deepEqual(r.j.floored, { next: false });
  assert.equal(r.j.relay_min_kvb, 100);
  assert.deepEqual(r.j.targets, { next: 2 },
    'a cotação é o estimatefee(2)');
  assert.equal(r.j.source, 'electrum');
  console.log('ok   taxa ao vivo, estimatefee(2)');
  await fake.close();
}

/* ---------------- 1b. casas decimais e piso de relay só marcado ---------------- */
{
  /* 1,299 sat/vB fica exatamente assim: nada de arredondar para 2 antes de
     multiplicar pela vsize. */
  const fake = await startFakeElectrum({ fees: { 2: 0.00001299 } });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.sat_per_kvb, { next: 1299 });
  assert.deepEqual(r.j.sat_per_vb, { next: 1.299 },
    'o sat/vB é só a leitura do sat/kvB, sem arredondar');
  assert.deepEqual(r.j.floored, { next: false });
  await fake.close();

  /* 0,05 sat/vB fica abaixo do piso de relay padrão (0,1 sat/vB): `levels`
     (o que o PSBT usa) leva o valor exato e `floored` só marca. */
  const baixo = await startFakeElectrum({ fees: { 2: 0.00000050 } });
  const env2 = { ELECTRUM_SERVERS: '127.0.0.1:' + baixo.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r2 = await reqFees(env2);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.j.levels, { next: 0.05 }, 'o nível usa a estimativa exata, sem piso de relay');
  assert.deepEqual(r2.j.floored, { next: true },
    'abaixo de 100 sat/kvB o nível é marcado, mas a taxa não é trocada');
  console.log('ok   casas decimais preservadas e piso de relay só marcado');
  await baixo.close();
}

/* ---------------- 1c. sem estimativa fica null ---------------- */
{
  const fake = await startFakeElectrum({ fees: {} });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.levels, { next: null },
    'servidor que responde -1 deixa o nível sem estimativa');
  assert.deepEqual(r.j.sat_per_kvb, { next: null });
  assert.deepEqual(r.j.floored, { next: false },
    'nível sem estimativa não é nível no piso');
  console.log('ok   sem estimativa o nível vem null e a tela o desabilita');
  await fake.close();
}

/* ---------------- 1d. só o estimatefee do Core; histograma é ignorado ---------------- */
{
  /* O servidor devolve histograma e estimatefee; o projeto usa só o
     estimatefee, sem mediana nem corte. 10 sat/vB = 10 000 sat/kvB. */
  const fake = await startFakeElectrum({
    histogram: [[2.02, 300000], [2.00, 250000], [1.98, 450000]],
    fees: { 2: 0.00010000 }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await reqFees(env);
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.sat_per_kvb, { next: 10000 },
    'o histograma não entra: a taxa é o estimatefee(2)');
  assert.deepEqual(r.j.levels, { next: 10 });
  assert.deepEqual(r.j.floored, { next: false });
  assert.deepEqual(r.j.targets, { next: 2 });
  assert.equal(r.j.source, 'electrum', 'o formato da resposta não muda');
  await fake.close();

  /* Sem estimatefee, o histograma NÃO é fallback: o nível fica null. */
  const semEstimativa = await startFakeElectrum({
    histogram: [[2.02, 300000], [2.00, 250000], [1.98, 450000]],
    fees: {}
  });
  const envSem = { ELECTRUM_SERVERS: '127.0.0.1:' + semEstimativa.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const rSem = await reqFees(envSem);
  assert.equal(rSem.status, 200);
  assert.deepEqual(rSem.j.levels, { next: null },
    'sem estimatefee, o histograma não é fallback');
  assert.deepEqual(rSem.j.sat_per_kvb, { next: null });
  await semEstimativa.close();
  console.log('ok   só o estimatefee do Core; histograma é ignorado');
}

/* ---------------- 2. envio bip84 para índice alto, com origem BIP32 ---------------- */
{
  const account = parseXpub(hd.accounts.bip84.xpub);
  /* 0, 49 e 99 estendem a varredura da carteira até 149: com isso o índice
     120 entra na margem. O assinador o reconhece pela origem da entrada, não
     por varredura de contas. */
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
  assert.equal(j.locktime, 0, 'o montador usa locktime 0');
  assert.equal(j.rbf, false, 'o montador usa sequence final');
  assert.equal(j.change.value, j.total_in - 50000 - j.fee_sats);
  assert.ok(j.fee_sats >= Math.ceil(5 * j.vsize), 'taxa cobre a vsize estimada a 5 sat/vB');
  assert.ok(j.change.value >= 546, 'troco acima do pó');
  assert.equal(j.change.path, "m/84'/0'/0'/1/0");
  assert.equal(j.outputs[0].address, destination);
  assert.equal(j.outputs[0].value, 50000);
  assert.equal(j.outputs[0].own, 'externo');
  assert.equal(j.outputs[1].own, 'troco');

  /* Destino da própria carteira: o servidor reconhece o script derivado da
     xpub e não o classifica como externo. O índice 30 fica fora da varredura
     de 25 do assinador, então a origem na saída é o que permite reconhecê-lo
     sem varrer as contas. */
  const self = await deriveAddress('bip84', account, 0, 30);
  const own = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: self.address,
    amount_sats: 10000, fee_rate: 5
  }, env);
  assert.equal(own.status, 200, JSON.stringify(own.j));
  assert.equal(own.j.outputs[0].own, 'recebimento', 'destino da própria carteira não é externo');
  assert.equal(own.j.recipient.own, 'recebimento');
  const ownPsbt = BTC.parsePsbt(BTC.psbtParseInput(own.j.psbt));
  assert.ok(mapFind(ownPsbt.outputs[0], 0x02), 'destino próprio leva origem BIP32 na saída');
  const ownReview = await BTC.analyzePsbt(BTC.psbtParseInput(own.j.psbt), hd);
  assert.equal(ownReview.outputs[0].own, 'recebimento',
    'o assinador reconhece o destino próprio pela origem, sem varredura');

  /* Sem origem, a saída não é varrida: mesmo um endereço da própria carteira
     dentro da antiga janela de 25 fica externo. */
  const near = await deriveAddress('bip84', account, 0, 1);
  const nearOwn = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: near.address,
    amount_sats: 10000, fee_rate: 5
  }, env);
  assert.equal(nearOwn.status, 200, JSON.stringify(nearOwn.j));
  const nearPsbt = BTC.parsePsbt(BTC.psbtParseInput(nearOwn.j.psbt));
  nearPsbt.outputs[0] = [];
  const nearReview = await BTC.analyzePsbt(BTC.writePsbt(nearPsbt), hd);
  assert.equal(nearReview.outputs[0].own, 'externo', 'saída sem origem não é varrida');

  /* Origem interna colada num destino externo não passa na conferência do
     script: a saída continua externa. */
  const spoofed = BTC.parsePsbt(BTC.psbtParseInput(j.psbt));
  const internalOrigin = mapFind(ownPsbt.outputs[0], 0x02);
  spoofed.outputs[0].push(internalOrigin);
  const spoofedReview = await BTC.analyzePsbt(BTC.writePsbt(spoofed), hd);
  assert.equal(spoofedReview.outputs[0].own, 'externo', 'origem não cobre destino adulterado');

  const bytes = BTC.psbtParseInput(j.psbt);
  const psbt = BTC.parsePsbt(bytes);
  assert.equal(psbt.tx.inputs.length, 2);
  assert.equal(psbt.tx.outputs[1].value, BigInt(j.change.value));
  /* toda entrada leva a transação anterior inteira: é o que permite ao
     assinador conferir o valor da entrada e a taxa, inclusive no segwit */
  for (let i = 0; i < psbt.inputs.length; i++) {
    const nwu = mapFind(psbt.inputs[i], 0x00);
    assert.ok(nwu, 'entrada segwit leva non_witness_utxo');
    assert.equal(BTC.txidOf(BTC.readTx(nwu.value)), psbt.tx.inputs[i].txid,
      'non_witness_utxo corresponde ao txid da entrada');
  }
  /* a origem leva a impressão digital da conta (o que a xpub permite) */
  const fp = BTC.bytesToHex(BTC.hash160(account.pub)).slice(0, 8);
  const deriv = mapFind(psbt.inputs[0], 0x06);
  assert.equal(BTC.bytesToHex(deriv.value.subarray(0, 4)), fp);
  assert.equal(psbt.outputs[1].some(e => e.key[0] === 0x02), true, 'troco tem origem no PSBT');
  assert.equal(mapFind(psbt.outputs[0], 0x02), null, 'destino externo não leva origem no PSBT');

  /* o assinante (núcleo do Cofre BTC) acha as chaves mesmo com o índice
     120 porque a origem BIP32 da entrada está no PSBT; não há varredura. */
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

  /* Entrada segwit sem non_witness_utxo (PSBT de fora): avisa em vez de
     recusar, porque a chave (origem) continua conferível mas o valor não. */
  const semPrev = BTC.parsePsbt(bytes);
  semPrev.inputs = semPrev.inputs.map(m => m.filter(e => !(e.key.length === 1 && e.key[0] === 0x00)));
  const warned = await BTC.analyzePsbt(BTC.writePsbt(semPrev), hd);
  assert.ok(warned.warnings.some(w => /é segwit e veio sem non_witness_utxo/.test(w)),
    'entrada segwit sem a transação anterior gera aviso');

  /* O PSBT já finalizado não tem mais a origem BIP32, mas conserva UTXO e
     campos finais: dá para exibir e recusar nova assinatura. */
  const finalReview = await BTC.analyzePsbt(signed.psbt, hd);
  assert.equal(finalReview.alreadySigned, true);
  assert.equal(finalReview.inputs[0].key, null, 'a origem sai na finalização');
  assert.equal(finalReview.inputs[0].path, '');
  await assert.rejects(BTC.signPsbt(signed.psbt, hd, new Uint8Array(32)),
    /este psbt já está assinado/);

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
  assert.match(poor.j.error, /saldo disponível insuficiente/);

  const lowFee = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 0
  }, env);
  assert.equal(lowFee.status, 400);
  assert.match(lowFee.j.error, /taxa inválida/);

  /* a taxa com casas atravessa a rota inteira: o worker aceita, o PSBT usa
     sat/kvB exato, e abaixo de 1 sat/vB o valor pedido é o usado */
  const fracRate = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 1.926
  }, env);
  assert.equal(fracRate.status, 200, JSON.stringify(fracRate.j));
  assert.equal(fracRate.j.fee_rate_requested, 1.926);
  assert.equal(fracRate.j.fee_rate_kvb, 1926);
  const belowOne = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 0.97
  }, env);
  assert.equal(belowOne.status, 200, JSON.stringify(belowOne.j));
  assert.equal(belowOne.j.fee_rate_requested, 0.97);
  assert.equal(belowOne.j.fee_rate_kvb, 970, 'abaixo de 1 sat/vB não é içado');
  const bigRate = await reqPsbt({
    xpub: hd.accounts.bip84.xpub, address: destination,
    amount_sats: 50000, fee_rate: 10000.5
  }, env);
  assert.equal(bigRate.status, 400, 'taxa acima de 10 000 sat/vB é recusada');

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
  /* A transação anterior de cada UTXO é obrigatória no PSBT: o assinador
     confere o valor da entrada contra ela. */
  const prev = makeTx([{ txid: '30'.repeat(32), vout: 0 }], [{ value: 200000, script: a.script }]);
  utxos[0].txid = prev.txid;
  const destination = BTC.derive('01' + '0'.repeat(254)).addresses.p2tr;
  const limits = sendLimits({ utxos, address: destination, feeRate: 4 });
  assert.equal(limits.available_sats, 200000);
  assert.equal(limits.max_send_sats, 200000 - limits.fee_sats_at_max);
  assert.equal(limits.min_sats, 546);

  /* Saída ainda no mempool não é saldo: fica fora do disponível e da escolha
     de entradas, mesmo sendo a maior e ainda não gasta. */
  const pendingUtxo = {
    txid: '31'.repeat(32), vout: 0, value: 500000,
    script: BTC.bytesToHex(a.script), height: 0,
    row: row(a, 0, 151)
  };
  const withPending = sendLimits({
    utxos: [...utxos, pendingUtxo], address: destination, feeRate: 4
  });
  assert.equal(withPending.available_sats, 200000, 'pagamento de terceiro no mempool não entra no disponível');
  assert.equal(withPending.max_send_sats, limits.max_send_sats);
  await assert.rejects(preparePsbt({
    account, utxos: [pendingUtxo], address: destination,
    amountSats: 10000, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor: async () => null
  }), /saldo disponível insuficiente/);

  /* O troco de uma transação nossa ainda pendente é diferente: ele é saldo
     disponível (gasto encadeado) e entra no limite e na escolha, depois das
     confirmadas. */
  const ownChange = {
    txid: '32'.repeat(32), vout: 0, value: 50000,
    script: BTC.bytesToHex(a.script), height: 0, own: true,
    row: row(change, 1, 0)
  };
  const changePrev = makeTx([{ txid: '32'.repeat(32), vout: 0 }], [{ value: 50000, script: change.script }]);
  ownChange.txid = changePrev.txid;
  const rawTxFor = async txid => {
    if (txid === prev.txid) return BTC.hexToBytes(prev.raw);
    if (txid === changePrev.txid) return BTC.hexToBytes(changePrev.raw);
    return null;
  };
  const withOwnChange = sendLimits({
    utxos: [...utxos, ownChange], address: destination, feeRate: 4
  });
  assert.equal(withOwnChange.available_sats, 250000, 'o troco pendente entra no disponível');
  const chained = await preparePsbt({
    account, utxos: [ownChange], address: destination,
    amountSats: 40000, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor
  });
  assert.equal(chained.inputs.length, 1, 'o troco pendente pode ser gasto');
  assert.equal(chained.inputs[0].pending, true, 'a entrada do troco pendente é marcada');
  const preferConfirmed = await preparePsbt({
    account, utxos: [ownChange, ...utxos], address: destination,
    amountSats: 120000, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor
  });
  assert.equal(preferConfirmed.inputs.length, 1, 'confirmada é usada antes do troco pendente');
  assert.equal(preferConfirmed.inputs[0].pending, false);

  /* taxa com casas decimais: a conta é sat/kvB × vsize ÷ 1000, sem arredondar
     a taxa para inteiro antes de multiplicar (1,926 não vira 2) */
  const frac = sendLimits({
    utxos, address: destination, feeRate: 1.926, amountSats: 120000,
    changeScript: change.script
  });
  assert.equal(frac.fee_rate_kvb, 1926);
  assert.equal(frac.fee_sats, Math.ceil(1926 * frac.vsize / 1000));
  assert.ok(frac.fee_sats < Math.ceil(2 * frac.vsize), 'a taxa não é arredondada para 2 antes de multiplicar');

  /* abaixo de 1 sat/vB a taxa é usada como veio, sem piso de relay */
  const low = sendLimits({
    utxos, address: destination, feeRate: 0.97, amountSats: 120000,
    changeScript: change.script
  });
  assert.equal(low.fee_rate_kvb, 970);
  assert.equal(low.fee_sats, Math.ceil(970 * low.vsize / 1000));

  const prepared = await preparePsbt({
    account,
    utxos,
    address: destination,
    amountSats: 120000, feeRate: 4,
    changeRow: row(change, 1, 0),
    rawTxFor
  });
  /* com troco, a taxa é só a tarifa: nada foi absorvido */
  assert.equal(prepared.dust_sats, 0);
  assert.equal(prepared.fee_sats, prepared.fee_sats_at_rate);

  /* sem a transação anterior não há PSBT: o assinador não teria como
     conferir o valor da entrada. */
  await assert.rejects(preparePsbt({
    account, utxos, address: destination, amountSats: 120000, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor: async () => null
  }), /transação anterior da entrada .* não encontrada/);

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

  /* as taxas dos níveis vêm na mesma resposta, cotadas para o mesmo valor:
     é o que o seletor mostra em BTC. Nível em que o valor não cabe volta
     com fee_sats null. */
  const quoted = sendLimits({
    utxos, address: destination, feeRate: 4, amountSats: 120000,
    changeScript: change.script, quoteRates: [1, 2, 6, 12]
  });
  assert.deepEqual(quoted.quotes.map(q => q.fee_rate), [1, 2, 6, 12]);
  assert.equal(quoted.quotes[0].fee_sats, Math.ceil(1 * quoted.quotes[0].vsize));
  assert.ok(quoted.quotes[0].fee_sats < quoted.quotes[3].fee_sats, 'a taxa dos 10 min custa mais que a de 1 dia');
  const tooExpensive = sendLimits({
    utxos, address: destination, feeRate: 4, amountSats: 120000,
    changeScript: change.script, quoteRates: [10000]
  });
  assert.equal(tooExpensive.quotes[0].fee_sats, null);

  /* no máximo não sobra troco: a taxa da transação sem saída de troco é
     exatamente a devolvida pelo preview. */
  const atMax = await preparePsbt({
    account, utxos, address: destination,
    amountSats: limits.max_send_sats, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor
  });
  assert.equal(atMax.change, null);
  assert.equal(atMax.fee_sats, limits.fee_sats_at_max);
  assert.equal(atMax.total_out, limits.max_send_sats);
  assert.equal(atMax.dust_sats, 0, 'no máximo não há taxa pedida a separar: o resto é a própria tarifa');

  /* troco abaixo do pó: o valor não vira saída e a resposta separa a tarifa
     (`fee_sats_at_rate`) do resto (`dust_sats`), que é o que a tela mostra
     como pó incluído na taxa. Aqui sobram 300 sats depois da tarifa. */
  const dusty = await preparePsbt({
    account, utxos, address: destination,
    amountSats: limits.available_sats - limits.fee_sats_at_max - 300, feeRate: 4,
    changeRow: row(change, 1, 0), rawTxFor
  });
  assert.equal(dusty.change, null, 'troco abaixo de 546 não vira saída');
  assert.equal(dusty.dust_sats, 300, 'o resto não virou troco e ficou na taxa');
  assert.equal(dusty.fee_sats, dusty.fee_sats_at_rate + dusty.dust_sats);
  assert.equal(dusty.fee_sats_at_rate, limits.fee_sats_at_max);
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(prepared.psbt));
  const tap = mapFind(psbt.inputs[0], 0x16);
  assert.ok(tap, 'entrada taproot leva tap_bip32_derivation');
  assert.equal(tap.value[0], 0);

  /* Sem origem na entrada não há varredura: o assinador recusa, mesmo que o
     índice esteja dentro da antiga janela de 100. */
  const noInputOrigin = BTC.parsePsbt(BTC.psbtParseInput(prepared.psbt));
  noInputOrigin.inputs[0] = noInputOrigin.inputs[0].filter(e =>
    !(e.key.length > 0 && (e.key[0] === 0x06 || e.key[0] === 0x16)));
  await assert.rejects(BTC.analyzePsbt(BTC.writePsbt(noInputOrigin), hd),
    /não pertence às contas derivadas/);

  const signed = await BTC.signPsbt(BTC.psbtParseInput(prepared.psbt), hd, new Uint8Array(32));
  assert.equal(signed.outputs[0].value, 120000n);
  assert.ok(signed.feerate > 3.5);
  const review = await BTC.analyzePsbt(BTC.psbtParseInput(prepared.psbt), hd);
  assert.equal(review.outputs[1].own, 'troco', 'o troco taproot é reconhecido');
  console.log('ok   psbt taproot (bip86) com troco e assinatura');
}

/* ---------------- 5. a taxa cobrada nunca cai abaixo da pedida ---------------- */
{
  /* A taxa é preço × vsize ESTIMADA, e a transação só existe depois de
     assinar. Se a estimativa for curta, a taxa efetiva fica abaixo da pedida
     e, no piso de relay, a transação é recusada. Aqui cada tipo de entrada é
     montado e assinado: a estimativa tem de cobrir o tamanho real (com folga
     de no máximo 1 vB por transação de uma entrada, que é o preço do pior
     caso de assinatura) e a taxa paga tem de cobrir a real à taxa pedida. */
  const cases = [
    ['bip84', 'p2wpkh'], ['bip49', 'p2sh-p2wpkh'], ['bip44', 'p2pkh'], ['bip86', 'p2tr']
  ];
  for (const [acct, kind] of cases) {
    const account = parseXpub(hd.accounts[acct].xpub);
    const a = await deriveAddress(acct, account, 0, 0);
    const change = await deriveAddress(acct, account, 1, 0);
    const prev = makeTx([{ txid: '11'.repeat(32), vout: 0 }], [{ value: 30000, script: a.script }]);
    const rowOf = (x, chain, idx) => ({
      address: x.address, path: x.path, script: BTC.bytesToHex(x.script),
      pub: BTC.bytesToHex(x.pub), kind, account_type: acct, chain, idx
    });
    const utxos = [{
      txid: prev.txid, vout: 0, value: 30000,
      script: BTC.bytesToHex(a.script), height: 800000, row: rowOf(a, 0, 0)
    }];
    const destination = BTC.derive('10' + '0'.repeat(254)).addresses.p2wpkh;
    for (const rate of [1, 1.926]) {
      const p = await preparePsbt({
        account, utxos, address: destination, amountSats: 10000, feeRate: rate,
        changeRow: rowOf(change, 1, 0),
        rawTxFor: async () => BTC.hexToBytes(prev.raw)
      });
      const signedTx = await BTC.signPsbt(BTC.psbtParseInput(p.psbt), hd, new Uint8Array(32));
      const realVsize = signedTx.vsize;
      assert.ok(p.vsize >= realVsize,
        kind + ': estimativa (' + p.vsize + ') menor que a tx assinada (' + realVsize + ')');
      assert.ok(p.vsize - realVsize <= 1,
        kind + ': folga da estimativa acima de 1 vB (' + (p.vsize - realVsize) + ')');
      const need = Math.ceil(rate * realVsize);
      assert.ok(p.fee_sats >= need,
        kind + ': taxa ' + p.fee_sats + ' abaixo do mínimo ' + need + ' para ' + rate + ' sat/vB');
      assert.ok(p.fee_sats - need <= Math.ceil(rate), 'a folga da taxa é de no máximo 1 vB');
    }
  }
  console.log('ok   taxa paga cobre a taxa pedida nos quatro tipos, sem estimativa curta');
}

console.log('\ntestes de envio/psbt passaram');
