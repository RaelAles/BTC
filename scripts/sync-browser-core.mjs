/* Gera public/wallet-local.js a partir do núcleo BTC, da derivação, da conta
   de UTXO e do montador de PSBT.

   O navegador precisa derivar a xpub e montar o PSBT localmente para o Worker
   não receber nem a chave estendida nem a escolha de moedas. O núcleo já é
   browser-compatible (Web Crypto, sem DOM); este script remove as bordas ESM
   e expõe uma API pequena em window.LocalWallet. O arquivo gerado é commitado
   e um teste confere que ele continua igual às fontes.

   node scripts/sync-browser-core.mjs [--check] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePath = path.join(root, 'src/btc-core.js');
const derivPath = path.join(root, 'src/derivation.js');
const totalsPath = path.join(root, 'src/address-totals.js');
const psbtPath = path.join(root, 'src/psbt.js');
const outPath = path.join(root, 'public/wallet-local.js');

function moduleSource(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/^import .*?;\s*$/gm, '')
    .replace(/^export /gm, '');
}

export function buildBrowserCore() {
  const core = fs.readFileSync(corePath, 'utf8')
    .replace(/\nexport default BTC;\s*$/, '\n');
  const deriv = moduleSource(derivPath);
  const totals = moduleSource(totalsPath);
  const psbt = moduleSource(psbtPath);
  return `/* Gerado por scripts/sync-browser-core.mjs; não edite à mão.\n` +
    `   Derivação, UTXOs e PSBT locais para o Worker não receber a xpub. */\n` +
    `(function (global) {\n'use strict';\n${core}\n` +
    `var __deriv = (function () {\n${deriv}\n` +
    `return {\n` +
    `  parseXpub: parseXpub, chainNode: chainNode, deriveChild: deriveChild,\n` +
    `  deriveAddress: deriveAddress, addressForType: addressForType,\n` +
    `  scriptForType: scriptForType, pathFor: pathFor, TYPE_INFO: TYPE_INFO\n` +
    `};\n})();\n` +
    `var __totals = (function () {\n${totals}\n` +
    `return { totalsForScripts: totalsForScripts, utxosForScripts: utxosForScripts };\n})();\n` +
    `var __psbt = (function () {\n${psbt}\n` +
    `return {\n` +
    `  DUST_SATS: DUST_SATS, feeRateKvb: feeRateKvb, feeSats: feeSats,\n` +
    `  selectCoins: selectCoins, sendLimits: sendLimits,\n` +
    `  preparePsbt: preparePsbt, prepareCpfpPsbt: prepareCpfpPsbt\n` +
    `};\n})();\n` +
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
    `/* Deriva uma cauda de cada vez: a UI mantém a margem de 50 e pede mais\n` +
    `   quando o servidor informa que o último usado chegou perto do fim. */\n` +
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
