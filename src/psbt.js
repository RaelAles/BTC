/* Montagem do PSBT de envio (v0, sem assinatura).

   O lado watch-only só tem a xpub: escolhe UTXOs, calcula a taxa pela vsize
   estimada, deriva o troco e escreve o PSBT com a origem BIP32 de cada
   entrada. A chave privada nunca chega aqui; quem assina é o projeto 1
   (chave-btc.html), offline.

   A origem leva a impressão digital da CONTA, e não a da raiz: é o máximo
   que a xpub permite conhecer. O caminho continua completo (m/84'/0'/0'/0/i)
   e o assinante confere a chave e o script antes de usar, então a origem é
   uma dica de derivação, não uma prova de identidade. */
import BTC from './btc-core.js';

/* Abaixo disso a saída de troco vira pó e é mais barato somar à taxa. O
   valor é conservador: cobre p2pkh (546) e fica acima do pó de p2wpkh e
   p2tr, que é menor. */
const DUST_SATS = 546;

/* Faixa aceita para a taxa, em sat/vB. O estimador responde em sat/kvB, então
   a taxa pode ter casas decimais; a conta é feita em sat/kvB inteiro e só o
   valor final da taxa vira satoshi inteiro (ver `feeSats`). */
export const FEE_RATE_MIN = 1;
export const FEE_RATE_MAX = 10000;

/* sat/vB (com casas, se vier do estimador) → sat/kvB inteiro, que é a unidade
   exata do dado. Recusa o que está fora da faixa ou não é número. */
export function feeRateKvb(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n < FEE_RATE_MIN || n > FEE_RATE_MAX) {
    throw new Error('taxa inválida: use de 1 a 10 000 sat/vB');
  }
  return Math.round(n * 1000);
}

/* Taxa em satoshis: sat/kvB × vsize ÷ 1000, arredondada para cima só aqui.
   O produto (kvb ≤ 1e7, vsize de alguns milhares) é exato em double, e manter
   a taxa sem arredondar evita pagar a mais: 1,926 sat/vB em 141 vB custa 272
   sats, e não os 282 que 2 sat/vB custariam. */
export function feeSats(kvb, vsize) {
  return Math.ceil(kvb * vsize / 1000);
}

function hex(bytes) { return BTC.bytesToHex(bytes); }

/* Endereço de troco → linha do scanner (já derivada), no mesmo formato das
   entradas. */
function rowOrigin(row, fingerprint) {
  return {
    fingerprint,
    path: row.path,
    pub: BTC.hexToBytes(row.pub)
  };
}

function utxoInput(utxo, fingerprint) {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    value: utxo.value,
    script: BTC.hexToBytes(utxo.script),
    kind: utxo.row.kind,
    pub: BTC.hexToBytes(utxo.row.pub),
    path: utxo.row.path,
    fingerprint
  };
}

function estimateFor(selected, scripts) {
  return BTC.estimateVsize(
    selected.map(u => u.row.kind),
    scripts
  );
}

/* Entram na escolha a saída confirmada e o troco de uma transação nossa
   ainda pendente (gasto encadeado). O que está no mempool por pagamento de
   terceiro não é saldo, então fica de fora do envio e do limite. */
function spendableUtxos(utxos) {
  return (utxos || []).filter(u => Number(u.height) > 0 || u.own);
}

/* Escolhe as confirmadas antes do troco pendente e, em cada grupo, as maiores
   primeiro: menos entradas, menos taxa, resultado determinístico. O laço pára
   quando o saldo cobre o valor + taxa com troco acima do pó; se o troco
   ficaria pó, ele é somado à taxa (saída única). */
export function selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript) {
  const rateKvb = feeRateKvb(feeRate);
  const sorted = spendableUtxos(utxos).sort((a, b) =>
    (a.height === 0 ? 1 : 0) - (b.height === 0 ? 1 : 0) || b.value - a.value
  );
  const selected = [];
  let total = 0;
  for (const utxo of sorted) {
    selected.push(utxo);
    total += utxo.value;
    const noChange = [recipientScript];
    const withChange = [recipientScript, changeScript];
    const vsizeNoChange = estimateFor(selected, noChange);
    const vsizeWithChange = estimateFor(selected, withChange);
    const feeNoChange = feeSats(rateKvb, vsizeNoChange);
    const feeWithChange = feeSats(rateKvb, vsizeWithChange);
    if (total < amountSats + feeNoChange) continue;
    const change = total - amountSats - feeWithChange;
    if (change >= DUST_SATS) {
      return {
        selected, total, fee: feeWithChange, change,
        vsize: vsizeWithChange, withChange: true
      };
    }
    return {
      selected, total, fee: total - amountSats, change: 0,
      vsize: vsizeNoChange, withChange: false
    };
  }
  const available = sorted.reduce((s, u) => s + u.value, 0);
  const error = new Error('saldo disponível insuficiente: disponível ' + available +
    ' sats, precisa de ' + amountSats + ' sats + taxa' +
    ' (entrada de terceiro no mempool só conta depois de confirmada)');
  error.available = available;
  error.needed = amountSats;
  throw error;
}

/* Limite de envio para a taxa escolhida: o máximo é o total disponível
   (confirmado + troco nosso ainda pendente) menos a taxa da transação que
   gasta todas as entradas e manda todo o resto ao destino (sem troco). É
   exatamente o maior valor que selectCoins aceita; abaixo dele sempre existe
   uma seleção válida.
   Com `quoteRates`, devolve também `quotes`: a taxa de cada nível estimado
   para o mesmo valor, que a legenda do seletor mostra em BTC. */
export function sendLimits({ utxos, address, feeRate, amountSats, changeScript, quoteRates }) {
  const rateKvb = feeRateKvb(feeRate);
  const recipientScript = BTC.scriptFromAddress(address);
  const spendable = spendableUtxos(utxos);
  const available = spendable.reduce((sum, u) => sum + u.value, 0);
  const vsize = BTC.estimateVsize(spendable.map(u => u.row.kind), [recipientScript]);
  const feeAtMax = feeSats(rateKvb, vsize);
  const max = available - feeAtMax;
  const limits = {
    recipient: address,
    available_sats: available,
    min_sats: DUST_SATS,
    max_send_sats: max >= DUST_SATS ? max : 0,
    fee_sats_at_max: feeAtMax,
    vsize_at_max: vsize,
    fee_rate: feeRate,
    fee_rate_kvb: rateKvb
  };
  /* Com o valor em mãos, o preview devolve a taxa (e o troco) exatos da
     seleção que o PSBT usaria, para a tela mostrar a taxa ao lado do valor
     antes de montar qualquer coisa. Valor que não couber fica sem taxa. */
  if (Number.isInteger(amountSats) && amountSats > 0 && changeScript) {
    limits.amount_sats = amountSats;
    try {
      const pick = selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript);
      limits.fee_sats = pick.fee;
      limits.change_sats = pick.change;
      limits.vsize = pick.vsize;
      limits.inputs_used = pick.selected.length;
    } catch (e) {
      limits.fee_sats = null;
      limits.change_sats = null;
      limits.vsize = null;
      limits.inputs_used = null;
    }
  }
  /* Custo de cada nível para o mesmo valor: uma seleção de entradas por
     taxa, na mesma regra do PSBT. Nível em que o valor não cabe fica com
     `fee_sats: null`, e a tela escreve `—`. */
  if (Array.isArray(quoteRates) && quoteRates.length && Number.isInteger(amountSats) &&
    amountSats > 0 && changeScript) {
    limits.quotes = quoteRates.map(rate => {
      try {
        const pick = selectCoins(utxos, amountSats, rate, recipientScript, changeScript);
        return { fee_rate: rate, fee_sats: pick.fee, vsize: pick.vsize };
      } catch (e) {
        return { fee_rate: rate, fee_sats: null, vsize: null };
      }
    });
  }
  return limits;
}

/* Monta o PSBT. `utxos` vem do scanner com a linha de origem já anexada;
   `changeRow` é o próximo endereço livre do ramo de troco; `rawTxFor` devolve
   a transação anterior crua (só o p2pkh precisa dela). `ownScripts` é o mapa
   de scripts derivados da xpub: é o que distingue um destino externo de um
   recebimento para a própria carteira. */
export async function preparePsbt({
  account, utxos, address, amountSats, feeRate, changeRow, rawTxFor, ownScripts
}) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('valor inválido');
  }
  const rateKvb = feeRateKvb(feeRate);
  if (amountSats < DUST_SATS) {
    throw new Error('valor abaixo do pó: o mínimo é ' + DUST_SATS + ' sats');
  }
  let recipientScript;
  try { recipientScript = BTC.scriptFromAddress(address); }
  catch (e) { throw new Error('endereço de destino: ' + e.message); }
  const recipientOwn = !!(ownScripts && ownScripts.has(hex(recipientScript)));
  const recipientKind = recipientOwn ? 'recebimento' : 'externo';
  if (!changeRow) throw new Error('endereço de troco indisponível');
  const changeScript = BTC.hexToBytes(changeRow.script);
  const fingerprint = hex(BTC.hash160(account.pub)).slice(0, 8);

  const pick = selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript);

  const inputs = [];
  for (const utxo of pick.selected) {
    const origin = utxoInput(utxo, fingerprint);
    if (utxo.row.kind === 'p2pkh') {
      if (!rawTxFor) throw new Error('entrada p2pkh sem acesso à transação anterior');
      const raw = await rawTxFor(utxo.txid);
      if (!raw) throw new Error('transação anterior da entrada ' + utxo.txid + ' não encontrada');
      origin.rawTx = raw;
    }
    inputs.push(origin);
  }

  const outputs = [{ value: amountSats, script: recipientScript }];
  if (pick.withChange) {
    outputs.push({
      value: pick.change,
      script: changeScript,
      origin: rowOrigin(changeRow, fingerprint)
    });
  }

  const built = BTC.buildPsbt({ inputs, outputs });
  const paths = pick.selected.map(u => u.row.path);
  /* A taxa paga (`fee_sats`) é a da transação montada. `fee_sats_at_rate` é a
     que a tarifa pedida sozinha cobraria nela; a diferença é o valor que
     sobrou e não virou troco — porque o troco ficaria abaixo do pó (546) ou
     porque criar a saída custaria mais do que esse resto — e que a transação
     paga de taxa. Com troco, os dois números são iguais. */
  const feeAtRate = feeSats(rateKvb, pick.vsize);
  return {
    psbt: built.base64,
    txid: built.txid,
    vsize: built.vsize,
    fee_sats: pick.fee,
    fee_sats_at_rate: feeAtRate,
    dust_sats: pick.fee - feeAtRate,
    fee_rate: pick.vsize ? pick.fee / pick.vsize : 0,
    fee_rate_requested: feeRate,
    fee_rate_kvb: rateKvb,
    total_in: pick.total,
    total_out: amountSats + (pick.withChange ? pick.change : 0),
    amount_sats: amountSats,
    change: pick.withChange
      ? { address: changeRow.address, value: pick.change, path: changeRow.path }
      : null,
    recipient: { address, value: amountSats, own: recipientKind },
    inputs: pick.selected.map((u, i) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      address: u.row.address, path: paths[i], type: u.row.account_type,
      pending: u.height === 0
    })),
    outputs: [
      { address, value: amountSats, own: recipientKind },
      ...(pick.withChange
        ? [{ address: changeRow.address, value: pick.change, own: 'troco', path: changeRow.path }]
        : [])
    ]
  };
}
