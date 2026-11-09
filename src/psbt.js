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

/* Escolhe UTXOs confirmados antes dos pendentes e os maiores primeiro:
   menos entradas, menos taxa, resultado determinístico. O laço pára quando
   o saldo cobre o valor + taxa com troco acima do pó; se o troco ficaria
   pó, ele é somado à taxa (saída única). */
export function selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript) {
  const sorted = [...utxos].sort((a, b) =>
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
    const feeNoChange = Math.ceil(feeRate * vsizeNoChange);
    const feeWithChange = Math.ceil(feeRate * vsizeWithChange);
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
  const error = new Error('saldo insuficiente: disponível ' + available +
    ' sats, precisa de ' + amountSats + ' sats + taxa');
  error.available = available;
  error.needed = amountSats;
  throw error;
}

/* Monta o PSBT. `utxos` vem do scanner com a linha de origem já anexada;
   `changeRow` é o próximo endereço livre do ramo de troco; `rawTxFor` devolve
   a transação anterior crua (só o p2pkh precisa dela). */
export async function preparePsbt({
  account, utxos, address, amountSats, feeRate, changeRow, rawTxFor
}) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('valor inválido');
  }
  if (!Number.isInteger(feeRate) || feeRate < 1 || feeRate > 10000) {
    throw new Error('taxa inválida: use de 1 a 10 000 sat/vB');
  }
  if (amountSats < DUST_SATS) {
    throw new Error('valor abaixo do pó: o mínimo é ' + DUST_SATS + ' sats');
  }
  let recipientScript;
  try { recipientScript = BTC.scriptFromAddress(address); }
  catch (e) { throw new Error('endereço de destino: ' + e.message); }
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
  return {
    psbt: built.base64,
    txid: built.txid,
    vsize: built.vsize,
    fee_sats: pick.fee,
    fee_rate: pick.vsize ? pick.fee / pick.vsize : 0,
    fee_rate_requested: feeRate,
    total_in: pick.total,
    total_out: amountSats + (pick.withChange ? pick.change : 0),
    amount_sats: amountSats,
    change: pick.withChange
      ? { address: changeRow.address, value: pick.change, path: changeRow.path }
      : null,
    recipient: { address, value: amountSats },
    inputs: pick.selected.map((u, i) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      address: u.row.address, path: paths[i], type: u.row.account_type,
      pending: u.height === 0
    })),
    outputs: [
      { address, value: amountSats, own: false },
      ...(pick.withChange
        ? [{ address: changeRow.address, value: pick.change, own: true, path: changeRow.path }]
        : [])
    ]
  };
}
