/* Gera public/wallet-local.js a partir dos módulos puros do projeto.

   O navegador roda o scanner completo (derivação, gap, saldo, histórico,
   UTXOs, PSBT e CPFP) e usa o Worker só como proxy do Electrum. O núcleo já
   é browser-compatible (Web Crypto, sem DOM); este script remove as bordas
   ESM, injeta as dependências entre módulos e expõe window.LocalWallet. O
   arquivo gerado é commitado e um teste confere que ele continua igual às
   fontes.

   node scripts/sync-browser-core.mjs [--check] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => path.join(root, 'src', name);
const outPath = path.join(root, 'public/wallet-local.js');

function moduleSource(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/^import .*?;\s*$/gm, '')
    .replace(/^export /gm, '');
}

export function buildBrowserCore() {
  const core = fs.readFileSync(read('btc-core.js'), 'utf8')
    .replace(/\nexport default BTC;\s*$/, '\n');
  const electrum = moduleSource(read('electrum.js'));
  const deriv = moduleSource(read('derivation.js'));
  const totals = moduleSource(read('address-totals.js'));
  const psbt = moduleSource(read('psbt.js'));
  const broadcast = moduleSource(read('broadcast.js'));
  const wallet = moduleSource(read('wallet-sync.js'));
  return `/* Gerado por scripts/sync-browser-core.mjs; não edite à mão.\n` +
    `   Scanner, UTXOs, PSBT e CPFP locais; o Worker é só proxy. */\n` +
    `(function (global) {\n'use strict';\n${core}\n` +
    `var __electrum = (function (BTC) {\n${electrum}\n` +
    `return {\n` +
    `  historiesMany: historiesMany, transactionsMany: transactionsMany,\n` +
    `  estimateFees: estimateFees, scripthash: scripthash,\n` +
    `  RELAY_MIN_KVB: RELAY_MIN_KVB\n` +
    `};\n})(BTC);\n` +
    `var __deriv = (function (BTC) {\n${deriv}\n` +
    `return {\n` +
    `  parseXpub: parseXpub, chainNode: chainNode, deriveChild: deriveChild,\n` +
    `  deriveAddress: deriveAddress, addressForType: addressForType,\n` +
    `  scriptForType: scriptForType, pathFor: pathFor, TYPE_INFO: TYPE_INFO\n` +
    `};\n})(BTC);\n` +
    `var __totals = (function (BTC) {\n${totals}\n` +
    `return { totalsForScripts: totalsForScripts, utxosForScripts: utxosForScripts };\n})(BTC);\n` +
    `var __psbt = (function (BTC) {\n${psbt}\n` +
    `return {\n` +
    `  DUST_SATS: DUST_SATS, feeRateKvb: feeRateKvb, feeSats: feeSats,\n` +
    `  selectCoins: selectCoins, sendLimits: sendLimits,\n` +
    `  preparePsbt: preparePsbt, prepareCpfpPsbt: prepareCpfpPsbt\n` +
    `};\n})(BTC);\n` +
    `var __broadcast = (function (BTC, DUST_SATS, RELAY_MIN_KVB) {\n${broadcast}\n` +
    `return {\n` +
    `  inspectSignedPsbt: inspectSignedPsbt, previewSignedPsbt: previewSignedPsbt,\n` +
    `  broadcastSignedPsbt: broadcastSignedPsbt\n` +
    `};\n})(BTC, __psbt.DUST_SATS, __electrum.RELAY_MIN_KVB);\n` +
    `var __wallet = (function (BTC, chainNode, deriveChild, TYPE_INFO,\n` +
    `  historiesMany, transactionsMany, totalsForScripts, utxosForScripts,\n` +
    `  preparePsbt, sendLimits, prepareCpfpPsbt, feeRateKvb, feeSats, DUST_SATS) {\n${wallet}\n` +
    `return { WalletScanner: WalletScanner };\n` +
    `})(BTC, __deriv.chainNode, __deriv.deriveChild, __deriv.TYPE_INFO,\n` +
    `  __electrum.historiesMany, __electrum.transactionsMany,\n` +
    `  __totals.totalsForScripts, __totals.utxosForScripts,\n` +
    `  __psbt.preparePsbt, __psbt.sendLimits, __psbt.prepareCpfpPsbt,\n` +
    `  __psbt.feeRateKvb, __psbt.feeSats, __psbt.DUST_SATS);\n` +
    `function hex(value) { return BTC.bytesToHex(value); }\n` +
    `function fingerprintOf(account) {\n` +
    `  return hex(BTC.hash160(account.pub)).slice(0, 8);\n` +
    `}\n` +
    `function rowOf(type, chain, index, derived) {\n` +
    `  return {\n` +
    `    account_type: type, chain: chain, idx: index,\n` +
    `    address: derived.address, path: derived.path,\n` +
    `    script: hex(derived.script), pub: hex(derived.pub),\n` +
    `    kind: (__deriv.TYPE_INFO[type] || {}).kind || 'p2wpkh'\n` +
    `  };\n` +
    `}\n` +
    `async function deriveRows(account, type, chain, from, count) {\n` +
    `  if (!Number.isInteger(from) || from < 0 || from >= 0x80000000) {\n` +
    `    throw new Error('índice inválido');\n` +
    `  }\n` +
    `  if (!Number.isInteger(count) || count < 1 || count > 500) {\n` +
    `    throw new Error('quantidade de endereços inválida');\n` +
    `  }\n` +
    `  var node = await __deriv.chainNode(account, chain);\n` +
    `  var out = [];\n` +
    `  for (var i = 0; i < count; i++) {\n` +
    `    var index = from + i;\n` +
    `    out.push(rowOf(type, chain, index,\n` +
    `      await __deriv.deriveChild(type, node, chain, index)));\n` +
    `  }\n` +
    `  return out;\n` +
    `}\n` +
    `global.LocalWallet = {\n` +
    `  parseXpub: __deriv.parseXpub, deriveRows: deriveRows,\n` +
    `  fingerprintOf: fingerprintOf, TYPE_INFO: __deriv.TYPE_INFO,\n` +
    `  scripthash: __electrum.scripthash, WalletScanner: __wallet.WalletScanner,\n` +
    `  inspectSignedPsbt: __broadcast.inspectSignedPsbt,\n` +
    `  previewSignedPsbt: __broadcast.previewSignedPsbt,\n` +
    `  broadcastSignedPsbt: __broadcast.broadcastSignedPsbt,\n` +
    `  totalsForScripts: __totals.totalsForScripts,\n` +
    `  utxosForScripts: __totals.utxosForScripts,\n` +
    `  DUST_SATS: __psbt.DUST_SATS, feeRateKvb: __psbt.feeRateKvb,\n` +
    `  feeSats: __psbt.feeSats, selectCoins: __psbt.selectCoins,\n` +
    `  sendLimits: __psbt.sendLimits, preparePsbt: __psbt.preparePsbt,\n` +
    `  prepareCpfpPsbt: __psbt.prepareCpfpPsbt,\n` +
    `  readTx: BTC.readTx, vsizeOf: BTC.vsizeOf, scriptKind: BTC.scriptKind,\n` +
    `  estimateVsize: BTC.estimateVsize,\n` +
    `  bytesToHex: BTC.bytesToHex, hexToBytes: BTC.hexToBytes\n` +
    `};\n` +
    `})(typeof window !== 'undefined' ? window : globalThis);\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = buildBrowserCore();
  const check = process.argv.includes('--check');
  if (check) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (current !== generated) {
      console.error('public/wallet-local.js está desatualizado; rode npm run sync:browser-core');
      process.exit(1);
    }
    console.log('ok   public/wallet-local.js confere com as fontes');
  } else {
    fs.writeFileSync(outPath, generated);
    console.log('ok   public/wallet-local.js gerado (' + generated.length + ' bytes)');
  }
}
