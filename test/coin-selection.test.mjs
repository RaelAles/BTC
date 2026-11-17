/* Teste da escolha de entradas: menor nota que cobre, sobra abaixo do pó
   virando taxa, menor par, três ou mais, desempate por tipo/confirmações/
   índice e a ordem das confirmadas antes do troco pendente. Sem rede: as
   entradas da parte de política são sintéticas (só o tipo e o valor entram na
   conta da taxa); a parte de integração monta PSBT de verdade com as
   transações anteriores feitas pelo btc-core.

   node test/coin-selection.test.mjs */
import assert from 'node:assert/strict';
import { selectCoins, sendLimits, preparePsbt, feeRateKvb } from '../src/psbt.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import BTC from '../src/btc-core.js';
import { makeTx } from './tx-fixture.mjs';

const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);

/* Destino e troco em p2wpkh: os vB esperados abaixo foram medidos com
   estimateVsize para esses mesmos scripts. */
const destination = BTC.derive('01' + '0'.repeat(254)).addresses.p2wpkh;
const destScript = BTC.scriptFromAddress(destination);
const changeScript = destScript;
const RATE = 10;

/* vsize dos arranjos usados abaixo, medidos no btc-core (uma saída para o
   destino e, quando há troco, uma segunda saída p2wpkh). */
const VSIZE_2_P2TR = { noChange: 157, change: 188 };
const VSIZE_3_P2TR = { noChange: 215, change: 246 };
const VSIZE_MIX3 = { noChange: 316, change: 347 };
const VSIZE_MIX2 = { noChange: 168, change: 199 };

function fee(vsize) { return vsize * RATE; }

/* Entrada sintética: só o que a escolha usa (valor, tipo, altura, cadeia,
   índice e outpoint). */
function note({ value, kind = 'p2tr', chain = 0, idx = 0, height = 800000, own, vout = 0 }) {
  const id = String(idx).padStart(4, '0');
  return {
    txid: (kind === 'p2pkh' ? 'aa' : kind === 'p2wpkh' ? 'bb' : 'cc') + id.repeat(30),
    vout,
    value,
    script: '00',
    height,
    ...(own ? { own: true } : {}),
    row: {
      address: 'end' + kind + idx, script: '00', pub: '00', kind,
      account_type: kind === 'p2tr' ? 'bip86' : kind === 'p2wpkh' ? 'bip84' : 'bip44',
      chain, idx, path: "m/86'/0'/0'/" + chain + '/' + idx
    }
  };
}

function pick(utxos, amountSats, rate = RATE) {
  return selectCoins(utxos, amountSats, rate, destScript, changeScript);
}

/* ---------------- 1. uma entrada: exata, com pó e com troco ---------------- */
{
  const exact = pick([note({ value: 101000 })], 100000);
  assert.equal(exact.selected.length, 1);
  assert.equal(exact.withChange, false, 'sobra zero não cria saída de troco');
  assert.equal(exact.change, 0);
  assert.equal(exact.fee, fee(100), 'a taxa é a da transação sem troco');
  assert.equal(exact.vsize, 100);

  /* 300 sats de sobra: abaixo do pó (546), então vira taxa em vez de saída. */
  const dusty = pick([note({ value: 101610 })], 100000);
  assert.equal(dusty.withChange, false, 'troco abaixo do pó não vira saída');
  assert.equal(dusty.change, 0);
  assert.equal(dusty.fee, 100000 + 1610 - 100000, 'o resto ficou na taxa');

  const withChange = pick([note({ value: 106310 })], 100000);
  assert.equal(withChange.withChange, true);
  assert.equal(withChange.change, 5000);
  assert.equal(withChange.fee, fee(131));
  assert.equal(withChange.vsize, 131);
  console.log('ok   uma entrada: exata, sobra virando pó e troco acima do pó');
}

/* ---------------- 2. menor que cobre, e sem troco na frente ---------------- */
{
  /* A menor é a exata: as outras duas deixariam sobra. */
  const smallest = pick([
    note({ value: 101400, idx: 1 }),
    note({ value: 101000, idx: 2 }),
    note({ value: 106310, idx: 3 })
  ], 100000);
  assert.equal(smallest.selected[0].value, 101000, 'a menor que cobre é a escolhida');

  /* Aqui a maior é a escolhida, porque ela não deixa troco: a menor (p2tr,
     101.910) deixaria 600 sats de troco e a p2pkh (102.300) deixa 100, que
     fica abaixo do pó. Sem troco vence antes de "menor valor". */
  const noChangeWins = pick([
    note({ value: 101910, idx: 1 }),
    note({ value: 102300, kind: 'p2pkh', idx: 2 })
  ], 100000);
  assert.equal(noChangeWins.selected[0].kind || noChangeWins.selected[0].row.kind, 'p2pkh');
  assert.equal(noChangeWins.withChange, false, 'a entrada sem troco vence a entrada menor com troco');
  assert.equal(noChangeWins.change, 0);
  console.log('ok   menor que cobre, com a variante sem troco na frente');
}

/* ---------------- 3. menor par que cobre ---------------- */
{
  const pair = pick([
    note({ value: 5500, idx: 1 }),
    note({ value: 6000, idx: 2 }),
    note({ value: 6500, idx: 3 }),
    note({ value: 7000, idx: 4 })
  ], 10000);
  assert.equal(pair.selected.length, 2, 'duas entradas quando nenhuma cobre sozinha');
  assert.deepEqual(pair.selected.map(u => u.value), [5500, 6500], 'o par de menor soma que cobre');
  assert.equal(pair.total, 12000);
  assert.equal(pair.withChange, false);
  assert.equal(pair.vsize, VSIZE_2_P2TR.noChange);
  /* Sem troco, a taxa é todo o resto: o pó (430 sats) vai junto. */
  assert.equal(pair.fee, 12000 - 10000);

  /* Nenhum par cobre: três entradas, e a passada de devolução não consegue
     tirar nenhuma. Sobra acima do pó, então há troco. */
  const three = pick([
    note({ value: 5000, idx: 1 }),
    note({ value: 5000, idx: 2 }),
    note({ value: 5000, idx: 3 }),
    note({ value: 5000, idx: 4 })
  ], 10000);
  assert.equal(three.selected.length, 3);
  assert.equal(three.withChange, true);
  assert.equal(three.vsize, VSIZE_3_P2TR.change);
  assert.equal(three.change, 15000 - 10000 - fee(VSIZE_3_P2TR.change));
  console.log('ok   menor par que cobre e três entradas quando o par não basta');
}

/* ---------------- 4. desempate: tipo, confirmações, índice ---------------- */
{
  /* Mesmo valor de sobra (400 sats nos dois), tipos diferentes: ganha o mais
     barato de gastar, o p2tr. */
  const byType = pick([
    note({ value: 101500, kind: 'p2wpkh', idx: 1 }),
    note({ value: 101400, kind: 'p2tr', idx: 2 })
  ], 100000);
  assert.equal(byType.selected[0].row.kind, 'p2tr', 'empate no valor: ganha o tipo mais barato');

  /* Mesmo valor, mesmo tipo: ganha a de mais confirmações (bloco mais
     antigo), mesmo com índice maior. */
  const byAge = pick([
    note({ value: 101400, idx: 1, height: 800100 }),
    note({ value: 101400, idx: 9, height: 800000 })
  ], 100000);
  assert.equal(byAge.selected[0].row.idx, 9, 'empate de valor e tipo: ganha a mais antiga');

  /* Mesmo valor, tipo e confirmações: ganha o menor índice de derivação. */
  const byIndex = pick([
    note({ value: 101400, idx: 7 }),
    note({ value: 101400, idx: 2 })
  ], 100000);
  assert.equal(byIndex.selected[0].row.idx, 2, 'empate total: ganha o menor índice');
  console.log('ok   desempate por tipo, confirmações e índice de derivação');
}

/* ---------------- 5. confirmadas antes do troco pendente ---------------- */
{
  const pending = note({ value: 101400, idx: 1, height: 0, own: true });
  const confirmed = note({ value: 101500, kind: 'p2wpkh', idx: 2 });

  const onlyConfirmed = pick([pending, confirmed], 100000);
  assert.equal(onlyConfirmed.selected.length, 1);
  assert.equal(onlyConfirmed.selected[0].height > 0, true, 'a confirmada é usada antes');

  /* Quando só a confirmada não basta, as duas entram. */
  const both = pick([pending, confirmed], 120000);
  assert.equal(both.selected.length, 2);
  assert.equal(both.withChange, true);
  assert.equal(both.vsize, VSIZE_MIX2.change);

  /* Carteira com apenas o troco pendente continua podendo gastar (gasto
     encadeado). */
  const chained = pick([pending], 100000);
  assert.equal(chained.selected.length, 1);
  assert.equal(chained.selected[0].height, 0);
  console.log('ok   confirmadas antes do troco pendente, e o pendente sozinho gasta');
}

/* ---------------- 6. tipos misturados e saldo insuficiente ---------------- */
{
  const mixed = pick([
    note({ value: 6500, kind: 'p2tr', idx: 1 }),
    note({ value: 6500, kind: 'p2wpkh', idx: 2 }),
    note({ value: 6500, kind: 'p2pkh', idx: 3 })
  ], 15000);
  assert.equal(mixed.selected.length, 3, 'tipos diferentes podem entrar na mesma transação');
  assert.deepEqual(mixed.selected.map(u => u.row.kind), ['p2tr', 'p2wpkh', 'p2pkh']);
  assert.equal(mixed.vsize, VSIZE_MIX3.change);
  assert.equal(mixed.change, 19500 - 15000 - fee(VSIZE_MIX3.change));

  const shuffled = pick([
    note({ value: 6500, kind: 'p2pkh', idx: 3 }),
    note({ value: 6500, kind: 'p2tr', idx: 1 }),
    note({ value: 6500, kind: 'p2wpkh', idx: 2 })
  ], 15000);
  assert.deepEqual(shuffled.selected.map(u => u.txid), mixed.selected.map(u => u.txid),
    'a ordem da lista do servidor não muda a escolha');

  assert.throws(() => pick([note({ value: 1000, idx: 1 }), note({ value: 2000, idx: 2 })], 100000),
    (e) => /saldo disponível insuficiente: disponível 3000 sats, precisa de 100000 sats \+ taxa/
      .test(e.message) && e.available === 3000 && e.needed === 100000);

  /* Entrada de terceiro no mempool não é saldo: fica fora mesmo sendo a única. */
  assert.throws(() => pick([note({ value: 500000, idx: 1, height: 0 })], 100000),
    /saldo disponível insuficiente: disponível 0 sats/);
  console.log('ok   tipos misturados, determinismo e recusa por saldo insuficiente');
}

/* ---------------- 7. integração: a escolha chega no PSBT ---------------- */
{
  const account = parseXpub(hd.accounts.bip86.xpub);
  const rows = [];
  const made = [];
  for (let i = 0; i < 4; i++) {
    const a = await deriveAddress('bip86', account, 0, i);
    const prev = makeTx([{ txid: String(i + 1).repeat(64), vout: 0 }],
      [{ value: [101000, 102000, 103000, 200][i], script: a.script }]);
    made.push({ a, prev });
    rows.push({
      txid: prev.txid, vout: 0, value: [101000, 102000, 103000, 200][i],
      script: BTC.bytesToHex(a.script), height: 800000,
      row: {
        address: a.address, path: a.path, script: BTC.bytesToHex(a.script),
        pub: BTC.bytesToHex(a.pub), kind: 'p2tr', account_type: 'bip86', chain: 0, idx: i
      }
    });
  }
  const rawTxFor = async txid => {
    const hit = made.find(m => m.prev.txid === txid);
    return hit ? BTC.hexToBytes(hit.prev.raw) : null;
  };
  const changeRow = {
    address: (await deriveAddress('bip86', account, 1, 0)).address,
    path: (await deriveAddress('bip86', account, 1, 0)).path,
    script: BTC.bytesToHex((await deriveAddress('bip86', account, 1, 0)).script),
    pub: BTC.bytesToHex((await deriveAddress('bip86', account, 1, 0)).pub),
    kind: 'p2tr', account_type: 'bip86', chain: 1, idx: 0
  };
  const limits = sendLimits({ utxos: rows, address: destination, feeRate: RATE });
  assert.equal(limits.available_sats, 306200);

  /* No máximo: gasta tudo o que compensa gastar, sem troco, e nunca cobra
     mais do que o limite anunciou. A nota de 200 sats fica para trás porque
     incluí-la custa ~580 sats de taxa a mais: o número anunciado é
     conservador (saldo menos a taxa de todas as entradas), e a transação usa
     a seleção mais barata. */
  const atMax = await preparePsbt({
    account, utxos: rows, address: destination,
    amountSats: limits.max_send_sats, feeRate: RATE,
    changeRow, rawTxFor
  });
  assert.equal(atMax.change, null, 'no máximo não sobra troco');
  assert.equal(atMax.inputs.length, 3, 'a nota que custa mais para gastar do que vale fica de fora');
  assert.ok(atMax.fee_sats <= limits.fee_sats_at_max, 'a taxa paga não passa da anunciada');
  assert.equal(atMax.total_out, limits.max_send_sats);

  /* Um valor que só duas entradas cobrem: o PSBT leva duas, com troco. */
  const two = await preparePsbt({
    account, utxos: rows, address: destination, amountSats: 150000, feeRate: RATE,
    changeRow, rawTxFor
  });
  assert.equal(two.inputs.length, 2);
  assert.ok(two.change && two.change.value > 0);
  assert.equal(two.dust_sats, 0);
  assert.equal(two.fee_sats, two.fee_sats_at_rate);

  /* A ordem das entradas não depende da ordem da lista. */
  const reversed = await preparePsbt({
    account, utxos: rows.slice().reverse(), address: destination,
    amountSats: 150000, feeRate: RATE, changeRow, rawTxFor
  });
  assert.deepEqual(reversed.inputs.map(i => i.txid), two.inputs.map(i => i.txid));
  console.log('ok   integração: máximo sem nota antieconômica e par escolhido no PSBT');
}

/* ---------------- 8. simulação: carteiras e valores aleatórios ---------------- */
{
  /* Gerador determinístico: a mesma sequência em toda execução, para o
     teste falhar no mesmo caso quando algo quebrar. */
  let seed = 20240607;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const ri = n => Math.floor(rnd() * n);
  const pickOne = list => list[ri(list.length)];
  const KINDS = ['p2tr', 'p2wpkh', 'p2sh-p2wpkh', 'p2pkh'];
  const RATES = [0.5, 1, 2, 5, 10, 50];

  const vsizeOf = (selected, scripts) => BTC.estimateVsize(selected.map(u => u.row.kind), scripts);

  function randomWallet() {
    const n = 1 + ri(6);
    const out = [];
    for (let i = 0; i < n; i++) {
      const height = rnd() < 0.25 ? 0 : 800000 + ri(100);
      out.push(note({
        value: 700 + ri(120000),
        kind: pickOne(KINDS),
        idx: i,
        height,
        own: height === 0
      }));
    }
    return out;
  }

  let covered = 0;
  let refused = 0;
  for (let t = 0; t < 300; t++) {
    const wallet = randomWallet();
    const spendable = wallet.filter(u => u.height > 0 || u.own);
    const total = spendable.reduce((s, u) => s + u.value, 0);
    /* Valor às vezes acima do saldo, para exercitar a recusa. */
    const amount = 546 + ri(Math.max(1, Math.floor(total * 1.3)));
    const rate = pickOne(RATES);
    const kvb = feeRateKvb(rate);
    const feeAll = Math.ceil(kvb * vsizeOf(spendable, [destScript]) / 1000);

    let pick;
    try {
      pick = selectCoins(wallet, amount, rate, destScript, changeScript);
    } catch (e) {
      /* Se recusou, o saldo realmente não cobria nem gastando tudo. */
      assert.ok(total < amount + feeAll,
        'recusou com saldo suficiente: total ' + total + ', valor ' + amount +
        ', taxa mínima ' + feeAll);
      assert.match(e.message, /saldo disponível insuficiente/);
      refused++;
      continue;
    }
    covered++;

    /* Entradas distintas, todas gastáveis e todas da carteira. */
    const keys = new Set();
    for (const u of pick.selected) {
      assert.ok(u.height > 0 || u.own, 'entrada não gastável escolhida');
      assert.ok(spendable.includes(u), 'entrada de fora da carteira escolhida');
      const k = u.txid + ':' + u.vout;
      assert.ok(!keys.has(k), 'entrada repetida na mesma transação');
      keys.add(k);
    }
    assert.equal(pick.total, pick.selected.reduce((s, u) => s + u.value, 0));

    /* As duas formas de candidato, conferidas contra a vsize de verdade. */
    if (pick.withChange) {
      const v = vsizeOf(pick.selected, [destScript, changeScript]);
      assert.equal(pick.vsize, v);
      assert.equal(pick.fee, Math.ceil(kvb * v / 1000));
      assert.equal(pick.change, pick.total - amount - pick.fee);
      assert.ok(pick.change >= 546, 'troco abaixo do pó virou saída');
    } else {
      const v = vsizeOf(pick.selected, [destScript]);
      assert.equal(pick.vsize, v);
      assert.equal(pick.change, 0);
      assert.equal(pick.fee, pick.total - amount, 'sem troco, a taxa é todo o resto');
      assert.ok(pick.fee >= Math.ceil(kvb * v / 1000), 'taxa abaixo da pedida');
    }

    /* Se alguma entrada confirmada cobria sozinha, a escolha tem de ter uma
       entrada só. A entrada pendente não entra nessa conta: ela só é usada
       quando as confirmadas não bastam, mesmo que cobrisse sozinha. */
    const singleCovers = pool => pool.some(u =>
      u.value >= amount + Math.ceil(kvb * vsizeOf([u], [destScript]) / 1000));
    const confirmedOnly = spendable.filter(u => u.height > 0);
    const usedPending = pick.selected.some(u => u.height === 0);
    if (singleCovers(confirmedOnly)) {
      assert.equal(pick.selected.length, 1, 'havia entrada confirmada que cobria sozinha');
    } else if (usedPending) {
      assert.equal(singleCovers(spendable), pick.selected.length === 1,
        'usou troco pendente com uma entrada só sem que ela cobrisse sozinha');
    }

    /* Confirmada só entra se as confirmadas não bastavam. */
    if (usedPending) {
      assert.throws(() => selectCoins(confirmedOnly, amount, rate, destScript, changeScript),
        /saldo disponível insuficiente/, 'usou troco pendente sem precisar');
    }

    /* Mesma escolha com a lista em outra ordem. */
    const shuffled = [...wallet].sort(() => rnd() - 0.5);
    const again = selectCoins(shuffled, amount, rate, destScript, changeScript);
    assert.deepEqual(again.selected.map(u => u.txid + ':' + u.vout).sort(),
      pick.selected.map(u => u.txid + ':' + u.vout).sort(), 'escolha depende da ordem da lista');

    /* O máximo anunciado tem de ser aceito, e sem troco. */
    const limits = sendLimits({ utxos: wallet, address: destination, feeRate: rate });
    if (limits.max_send_sats > 0) {
      const atMax = selectCoins(wallet, limits.max_send_sats, rate, destScript, changeScript);
      assert.equal(atMax.withChange, false, 'no máximo sobrou troco');
      assert.ok(atMax.total <= total);
    }
  }
  assert.ok(covered > 100 && refused > 20, 'a simulação precisa exercitar os dois lados');
  console.log('ok   300 carteiras aleatórias (' + covered + ' aceitas, ' + refused +
    ' recusadas): entradas, troco, pó, pendente, ordem e máximo');
}

/* ---------------- 9. simulação assinada: prévia e PSBT batem ---------------- */
{
  const account = parseXpub(hd.accounts.bip86.xpub);
  const values = [400, 999, 5000, 40000, 100000, 250000];
  const utxos = [];
  const byTxid = new Map();
  for (let i = 0; i < values.length; i++) {
    const a = await deriveAddress('bip86', account, 0, i);
    const prev = makeTx([{ txid: ('4' + i).repeat(32), vout: 0 }],
      [{ value: values[i], script: a.script }]);
    byTxid.set(prev.txid, prev.raw);
    utxos.push({
      txid: prev.txid, vout: 0, value: values[i],
      script: BTC.bytesToHex(a.script), height: 800000,
      row: {
        address: a.address, path: a.path, script: BTC.bytesToHex(a.script),
        pub: BTC.bytesToHex(a.pub), kind: 'p2tr', account_type: 'bip86', chain: 0, idx: i
      }
    });
  }
  const c = await deriveAddress('bip86', account, 1, 0);
  const changeRow = {
    address: c.address, path: c.path, script: BTC.bytesToHex(c.script),
    pub: BTC.bytesToHex(c.pub), kind: 'p2tr', account_type: 'bip86', chain: 1, idx: 0
  };
  const rawTxFor = async txid => (byTxid.has(txid) ? BTC.hexToBytes(byTxid.get(txid)) : null);
  const limits = sendLimits({ utxos, address: destination, feeRate: RATE });
  const amounts = [
    1000, 20000, 60000, 120000, 200000,
    limits.max_send_sats, limits.max_send_sats - 1, limits.max_send_sats - 300
  ].filter(v => v >= 546 && v <= limits.max_send_sats);

  for (const amount of amounts) {
    const preview = sendLimits({
      utxos, address: destination, feeRate: RATE, amountSats: amount,
      changeScript: BTC.scriptFromAddress((await deriveAddress('bip86', account, 1, 1)).address)
    });
    const prepared = await preparePsbt({
      account, utxos, address: destination, amountSats: amount, feeRate: RATE,
      changeRow, rawTxFor
    });
    assert.equal(preview.inputs_used, prepared.inputs.length, 'prévia e PSBT com entradas diferentes');
    assert.equal(preview.fee_sats, prepared.fee_sats, 'prévia e PSBT com taxas diferentes');
    assert.equal(preview.change_sats, prepared.change ? prepared.change.value : 0,
      'prévia e PSBT com trocos diferentes');

    const signed = await BTC.signPsbt(BTC.psbtParseInput(prepared.psbt), hd, new Uint8Array(32));
    assert.ok(prepared.vsize >= signed.vsize,
      'estimativa ' + prepared.vsize + ' menor que a transação assinada ' + signed.vsize);
    assert.ok(prepared.fee_sats >= Math.ceil(RATE * signed.vsize),
      'taxa paga abaixo da pedida sobre a vsize real');
    assert.equal(signed.inputs.length, prepared.inputs.length);
  }
  console.log('ok   prévia, PSBT e assinatura concordam em ' + amounts.length + ' valores');
}

console.log('\ntestes de escolha de entradas passaram');