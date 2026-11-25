/* Gera public/wallet-local.js a partir de src/btc-core.js e src/derivation.js.

   O navegador precisa derivar a xpub localmente para o Worker nunca receber
   a chave. O núcleo já é browser-compatible (Web Crypto, sem DOM); este
   script só remove as bordas ESM e expõe uma API pequena em
   window.LocalWallet. O arquivo gerado é commitado e um teste confere que
   ele continua igual às fontes.

   node scripts/sync-browser-core.mjs [--check] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corePath = path.join(root, 'src/btc-core.js');
const derivPath = path.join(root, 'src/derivation.js');
const outPath = path.join(root, 'public/wallet-local.js');

export function buildBrowserCore() {
  const core = fs.readFileSync(corePath, 'utf8')
    .replace(/\nexport default BTC;\s*$/, '\n');
  const deriv = fs.readFileSync(derivPath, 'utf8')
    .replace(/^import BTC from '\.\/btc-core\.js';\s*/m, '')
    .replace(/^export /gm, '');
  return `/* Gerado por scripts/sync-browser-core.mjs; não edite à mão.\n` +
    `   Derivação pública local para o Worker nunca receber a xpub. */\n` +
    `(function (global) {\n'use strict';\n${core}\n${deriv}\n` +
    `function hex(value) { return BTC.bytesToHex(value); }\n` +
    `function fingerprintOf(account) {\n` +
    `  return hex(BTC.hash160(account.pub)).slice(0, 8);\n` +
    `}\n` +
    `function rowOf(type, chain, index, derived) {\n` +
    `  return {\n` +
    `    account_type: type, chain: chain, idx: index,\n` +
    `    address: derived.address, path: derived.path,\n` +
    `    script: hex(derived.script), pub: hex(derived.pub),\n` +
    `    kind: (TYPE_INFO[type] || {}).kind || 'p2wpkh'\n` +
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
    `  var node = await chainNode(account, chain);\n` +
    `  var out = [];\n` +
    `  for (var i = 0; i < count; i++) {\n` +
    `    var index = from + i;\n` +
    `    out.push(rowOf(type, chain, index, await deriveChild(type, node, chain, index)));\n` +
    `  }\n` +
    `  return out;\n` +
    `}\n` +
    `global.LocalWallet = {\n` +
    `  parseXpub: parseXpub, deriveRows: deriveRows, fingerprintOf: fingerprintOf,\n` +
    `  TYPE_INFO: TYPE_INFO, bytesToHex: BTC.bytesToHex, hexToBytes: BTC.hexToBytes\n` +
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
    console.log('ok   public/wallet-local.js confere com src/btc-core.js e src/derivation.js');
  } else {
    fs.writeFileSync(outPath, generated);
    console.log('ok   public/wallet-local.js gerado (' + generated.length + ' bytes)');
  }
}
