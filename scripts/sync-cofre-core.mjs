#!/usr/bin/env node
/* Regenera o núcleo criptográfico embutido em public/cofre-btc.html a partir
   de src/btc-core.js — a fonte única da lógica de PSBT.

   Uso:
     node scripts/sync-cofre-core.mjs          # reescreve o bloco no HTML
     node scripts/sync-cofre-core.mjs --check  # só compara; sai 1 se difere

   O bloco é o IIFE `var BTC = (function () { … })();` até a linha de
   `module.exports`. O Cofre é um arquivo standalone (abre sem servidor), por
   isso a cópia existe; este script mantém as duas iguais.
   As mensagens de erro em português não são alteradas por ele. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corePath = join(root, 'src', 'btc-core.js');
const htmlPath = join(root, 'public', 'cofre-btc.html');

export const START = 'var BTC = (function () {';
export const MARKER = "if (typeof module !== 'undefined' && module.exports) module.exports = BTC;";

export function generatedCore() {
  const source = readFileSync(corePath, 'utf8');
  const start = source.indexOf(START);
  if (start < 0) throw new Error('IIFE `var BTC` não encontrado em src/btc-core.js');
  const tail = source.slice(start).replace(/\nexport default BTC;\s*$/, '\n' + MARKER + '\n');
  if (!tail.endsWith(MARKER + '\n')) {
    throw new Error('`export default BTC;` não encontrado no fim de src/btc-core.js');
  }
  return tail;
}

export function embeddedCore(html) {
  const start = html.indexOf(START);
  const end = html.indexOf(MARKER, start);
  if (start < 0 || end < start) throw new Error('núcleo embutido não encontrado em public/cofre-btc.html');
  return html.slice(start, end + MARKER.length) + '\n';
}

export function currentDifferences() {
  const html = readFileSync(htmlPath, 'utf8');
  const want = generatedCore();
  const have = embeddedCore(html);
  return { html, want, have, same: have === want };
}

function main() {
  const { html, want, have, same } = currentDifferences();
  if (process.argv.includes('--check')) {
    if (same) {
      console.log('cofre-btc.html: núcleo embutido igual a src/btc-core.js');
      return;
    }
    console.error('cofre-btc.html: núcleo embutido DIFERENTE de src/btc-core.js');
    console.error('rode `node scripts/sync-cofre-core.mjs` para regenerar');
    process.exitCode = 1;
    return;
  }
  if (same) {
    console.log('cofre-btc.html: nada a fazer, núcleo já sincronizado');
    return;
  }
  const start = html.indexOf(START);
  const end = html.indexOf(MARKER, start) + MARKER.length;
  writeFileSync(htmlPath, html.slice(0, start) + want.trimEnd() + html.slice(end), 'utf8');
  console.log('cofre-btc.html: núcleo embutido regenerado a partir de src/btc-core.js');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
