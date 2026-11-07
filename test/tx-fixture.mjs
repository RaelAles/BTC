/* Transações de teste montadas com o próprio btc-core (sem rede).
   `makeTx` devolve o hex cru que o servidor Electrum falso entrega em
   `blockchain.transaction.get`, e o txid que aparece no histórico. */
import BTC from '../src/btc-core.js';

export function makeTx(inputs, outputs) {
  const tx = {
    version: 2,
    inputs: (inputs || []).map(i => ({
      txid: i.txid || '00'.repeat(32),
      vout: i.vout || 0,
      scriptSig: new Uint8Array(0),
      sequence: 0xffffffff
    })),
    outputs: (outputs || []).map(o => ({ value: BigInt(o.value), script: o.script })),
    witnesses: [],
    locktime: 0,
    segwit: false
  };
  return { txid: BTC.txidOf(tx), raw: BTC.bytesToHex(BTC.writeTx(tx, false)), tx };
}

export function scriptHex(script) { return BTC.bytesToHex(script); }
