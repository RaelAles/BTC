/* Totais por endereço a partir das transações cruas.

   É a mesma conta que o Electrum e o Sparrow fazem: o saldo de um script é
   a soma das saídas que pagam esse script menos as que já foram gastas;
   `received` é a soma de todas as saídas e `spent` a soma das gastas.
   A altura vem do histórico do servidor (0 = mempool), então o que está
   pendente fica separado do confirmado.

   Entrada:
     entries = [{ txid, height, outputs: [{value, script}], inputs: [{txid, vout}] }]
     scripts = Set de scriptPubKey em hex que pertencem à carteira
   Saída: Map<hexScript, {received, spent, balance, confirmed, unconfirmed, txCount}> */
import BTC from './btc-core.js';

function hex(bytes) { return BTC.bytesToHex(bytes); }

export function totalsForScripts(entries, scripts) {
  const acc = new Map();
  const ensure = script => {
    let a = acc.get(script);
    if (!a) {
      a = { received: 0, spent: 0, receivedConfirmed: 0, spentConfirmed: 0, txids: new Set() };
      acc.set(script, a);
    }
    return a;
  };

  // 1. todas as saídas que pagam um script nosso (o mesmo outpoint pode ser
  //    referenciado por uma transação que aparece antes na lista).
  const ownOutputs = new Map();
  for (const tx of entries) {
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const script = hex(tx.outputs[vout].script);
      if (!scripts.has(script)) continue;
      const value = Number(tx.outputs[vout].value) || 0;
      const a = ensure(script);
      a.received += value;
      if (tx.height > 0) a.receivedConfirmed += value;
      a.txids.add(tx.txid);
      ownOutputs.set(tx.txid + ':' + vout, { script, value });
    }
  }

  // 2. entradas que gastam uma saída nossa (o valor está na transação de origem)
  for (const tx of entries) {
    for (const input of tx.inputs) {
      const prev = ownOutputs.get(input.txid + ':' + input.vout);
      if (!prev) continue;
      const a = ensure(prev.script);
      a.spent += prev.value;
      if (tx.height > 0) a.spentConfirmed += prev.value;
      a.txids.add(tx.txid);
    }
  }

  const out = new Map();
  for (const [script, a] of acc) {
    const balance = a.received - a.spent;
    const confirmed = a.receivedConfirmed - a.spentConfirmed;
    out.set(script, {
      received: a.received,
      spent: a.spent,
      balance,
      confirmed,
      unconfirmed: balance - confirmed,
      txCount: a.txids.size
    });
  }
  return out;
}

/* Saídas ainda não gastas que pagam um script da carteira.

   Mesma entrada de totalsForScripts. Uma saída nossa só deixa de ser UTXO
   quando alguma transação conhecida (do histórico dos nossos scripts) a
   gasta; é o mesmo conjunto de transações que fecha o saldo, então os dois
   números não divergem. `height` 0 é mempool. */
export function utxosForScripts(entries, scripts) {
  const own = new Map();
  for (const tx of entries) {
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const out = tx.outputs[vout];
      const script = hex(out.script);
      if (!scripts.has(script)) continue;
      const key = tx.txid + ':' + vout;
      own.set(key, {
        txid: tx.txid, vout, value: Number(out.value) || 0,
        script, height: tx.height || 0
      });
    }
  }
  const spent = new Set();
  for (const tx of entries) {
    for (const input of tx.inputs) {
      const key = input.txid + ':' + input.vout;
      if (own.has(key)) spent.add(key);
    }
  }
  return [...own.entries()]
    .filter(([key]) => !spent.has(key))
    .map(([, utxo]) => utxo)
    .sort((a, b) => (a.height === 0 ? 1 : 0) - (b.height === 0 ? 1 : 0) || b.value - a.value);
}
