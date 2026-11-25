/* O arquivo public/wallet-local.js é gerado do núcleo e da derivação. Este
   teste confere que ele está em dia e que deriva o mesmo endereço do módulo
   Node; sem isso, a tela poderia mandar ao Worker um conjunto diferente do
   que o servidor/testes esperam.

   node test/browser-core.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildBrowserCore } from '../scripts/sync-browser-core.mjs';
import { parseXpub, deriveAddress } from '../src/derivation.js';
import { preparePsbt, prepareCpfpPsbt } from '../src/psbt.js';
import { makeTx } from './tx-fixture.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';

const generated = buildBrowserCore();
const current = fs.readFileSync(new URL('../public/wallet-local.js', import.meta.url), 'utf8');
assert.equal(current, generated,
  'public/wallet-local.js está desatualizado; rode npm run sync:browser-core');

const window = {};
const context = {
  window,
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  console
};
vm.runInNewContext(current, context, { filename: 'wallet-local.js' });
assert.ok(window.LocalWallet, 'window.LocalWallet exposto');
const local = window.LocalWallet;
const account = local.parseXpub(USER);
assert.equal(account.versionType, 'xpub');

const [browserRow, nodeRow] = await Promise.all([
  local.deriveRows(account, 'bip84', 0, 0, 1),
  deriveAddress('bip84', parseXpub(USER), 0, 0)
]);
assert.equal(browserRow[0].address, nodeRow.address);
assert.equal(browserRow[0].script, Buffer.from(nodeRow.script).toString('hex'));
assert.equal(browserRow[0].path, "m/84'/0'/0'/0/0");
assert.equal(local.fingerprintOf(account).length, 8);

/* A montagem do PSBT também precisa ser idêntica: o navegador escolhe UTXOs,
   troco e taxa; o servidor só confere a assinatura depois. */
{
  const nodeAccount = parseXpub(USER);
  const receive = await deriveAddress('bip84', nodeAccount, 0, 0);
  const change = await deriveAddress('bip84', nodeAccount, 1, 0);
  const external = await deriveAddress('bip84', nodeAccount, 0, 100);
  const browserReceive = (await local.deriveRows(account, 'bip84', 0, 0, 1))[0];
  const browserChange = (await local.deriveRows(account, 'bip84', 1, 0, 1))[0];
  const tx = makeTx([{ txid: 'ab'.repeat(32), vout: 0 }],
    [{ value: 10000, script: receive.script }]);
  const utxo = {
    txid: tx.txid, vout: 0, value: 10000, script: browserReceive.script,
    height: 700000, own: true, row: browserReceive
  };
  const ownScripts = new Map([[browserReceive.script, browserReceive]]);
  const args = {
    fingerprint: local.fingerprintOf(account),
    utxos: [utxo],
    address: external.address,
    amountSats: 5000,
    feeRate: 2,
    changeRow: browserChange,
    ownScripts,
    rawTxFor: async () => local.hexToBytes(tx.raw)
  };
  const browser = await local.preparePsbt(args);
  const node = await preparePsbt({
    ...args,
    utxos: [{
      txid: tx.txid, vout: 0, value: 10000, script: Buffer.from(receive.script).toString('hex'),
      height: 700000, own: true, row: { ...browserReceive, pub: Buffer.from(receive.pub).toString('hex'), script: Buffer.from(receive.script).toString('hex') }
    }],
    rawTxFor: async () => Buffer.from(tx.raw, 'hex'),
    ownScripts: new Map([[Buffer.from(receive.script).toString('hex'), { ...browserReceive, script: Buffer.from(receive.script).toString('hex'), pub: Buffer.from(receive.pub).toString('hex') }]]),
    changeRow: { ...browserChange, script: Buffer.from(change.script).toString('hex'), pub: Buffer.from(change.pub).toString('hex') }
  });
  assert.equal(browser.psbt, node.psbt);
  assert.equal(browser.txid, node.txid);
  assert.equal(browser.fee_sats, node.fee_sats);
  assert.equal(browser.change.value, node.change.value);

  /* A filha de CPFP também é montada localmente; comparar com o módulo Node
     garante que o bundle não divergiu do servidor. */
  const parent = makeTx([{ txid: 'cd'.repeat(32), vout: 0 }],
    [{ value: 10000, script: receive.script }]);
  const cpfpArgs = {
    fingerprint: local.fingerprintOf(account),
    spend: {
      txid: parent.txid, vout: 0, value: 10000,
      script: browserReceive.script, row: browserReceive
    },
    changeRow: browserChange,
    childFee: 1000,
    feeRate: 2,
    parent: { txid: parent.txid, vsize: 200, fee_sats: 1000, fee_rate: 5 },
    packageBefore: { fee_sats: 1000, vsize: 200, count: 1 },
    rawTxFor: async () => local.hexToBytes(parent.raw)
  };
  const browserCpfp = await local.prepareCpfpPsbt(cpfpArgs);
  const nodeCpfp = await prepareCpfpPsbt({
    ...cpfpArgs,
    spend: {
      ...cpfpArgs.spend,
      script: Buffer.from(receive.script).toString('hex'),
      row: { ...browserReceive, pub: Buffer.from(receive.pub).toString('hex'), script: Buffer.from(receive.script).toString('hex') }
    },
    changeRow: { ...browserChange, script: Buffer.from(change.script).toString('hex'), pub: Buffer.from(change.pub).toString('hex') },
    rawTxFor: async () => Buffer.from(parent.raw, 'hex')
  });
  assert.equal(browserCpfp.psbt, nodeCpfp.psbt);
  assert.equal(browserCpfp.txid, nodeCpfp.txid);
  assert.equal(browserCpfp.fee_sats, nodeCpfp.fee_sats);
}
console.log('ok   wallet-local.js em dia, deriva e monta os mesmos PSBTs do servidor');
