/* Conta de UTXO: confirmado, troco próprio pendente e entrada de terceiro
   pendente. O troco é uma saída da mesma transação do envio e pode ser gasto
   antes de confirmar (gasto encadeado); pagamento de terceiro não.

   node test/address-totals.test.mjs */
import assert from 'node:assert/strict';
import BTC from '../src/btc-core.js';
import { totalsForScripts, utxosForScripts } from '../src/address-totals.js';
import { makeTx } from './tx-fixture.mjs';

const addr = bits => BTC.derive(bits).addresses.p2wpkh;
const A = addr('1' + '0'.repeat(255));
const B = addr('01' + '0'.repeat(254));
const C = addr('001' + '0'.repeat(253));
const X = addr('0001' + '0'.repeat(252)); // endereço de fora da carteira
const script = addr => BTC.scriptFromAddress(addr);
const ext1 = '11'.repeat(32);
const ext2 = '22'.repeat(32);

const tx1 = makeTx([{ txid: ext1, vout: 0 }], [{ value: 100000, script: script(A) }]);
const tx2 = makeTx([{ txid: tx1.txid, vout: 0 }], [
  { value: 90000, script: script(B) },   // troco (carteira)
  { value: 9000, script: script(X) }     // pagamento para fora
]);
const tx3 = makeTx([{ txid: ext2, vout: 0 }], [{ value: 5000, script: script(B) }]);
const tx4 = makeTx([{ txid: tx2.txid, vout: 0 }], [
  { value: 88000, script: script(C) },   // troco do troco (carteira)
  { value: 1000, script: script(X) }
]);

const entries = [
  { txid: tx1.txid, height: 800000, outputs: tx1.tx.outputs, inputs: tx1.tx.inputs },
  { txid: tx2.txid, height: 0, outputs: tx2.tx.outputs, inputs: tx2.tx.inputs },
  { txid: tx3.txid, height: 0, outputs: tx3.tx.outputs, inputs: tx3.tx.inputs },
  { txid: tx4.txid, height: 0, outputs: tx4.tx.outputs, inputs: tx4.tx.inputs }
];
const scripts = new Set([script(A), script(B), script(C)].map(s => BTC.bytesToHex(s)));

/* O que sobra: troco do troco (tx4 → C, nossa) e pagamento de terceiro
   (tx3 → B). O troco de tx2 foi gasto por tx4; o input de tx1 foi gasto por
   tx2. */
const utxos = utxosForScripts(entries, scripts);
const key = u => u.txid + ':' + u.vout;
const byKey = new Map(utxos.map(u => [key(u), u]));
assert.deepEqual([...byKey.keys()].sort(), [key({ txid: tx4.txid, vout: 0 }), key({ txid: tx3.txid, vout: 0 })].sort());
assert.equal(byKey.get(key({ txid: tx4.txid, vout: 0 })).value, 88000);
assert.equal(byKey.get(key({ txid: tx4.txid, vout: 0 })).own, true, 'troco do troco é gastável');
assert.equal(byKey.get(key({ txid: tx3.txid, vout: 0 })).own, false, 'pagamento de terceiro não é troco');

/* O disponível que a tela soma: confirmado ou troco próprio. */
const available = utxos.filter(u => u.height > 0 || u.own).reduce((s, u) => s + u.value, 0);
const thirdIn = utxos.filter(u => u.height === 0 && !u.own).reduce((s, u) => s + u.value, 0);
assert.equal(available, 88000);
assert.equal(thirdIn, 5000);

/* O extrato continua bruto: tx3 (terceiro) e tx4 (troco) entram como
   não confirmados nos endereços. */
const tB = totalsForScripts(entries, scripts).get(BTC.bytesToHex(script(B)));
assert.equal(tB.received, 95000);
assert.equal(tB.spent, 90000);
assert.equal(tB.unconfirmedIn, 95000);
assert.equal(tB.unconfirmedOut, 90000);

console.log('ok   utxo: confirmado, troco próprio pendente (encadeado) e entrada de terceiro');
