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

console.log('ok   wallet-local.js em dia e deriva o mesmo endereço do servidor');
