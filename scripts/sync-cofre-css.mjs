#!/usr/bin/env node
/* Injeta o estilo.css da skill ASCII UI no bloco copiado de
   public/cofre-btc.html. A cópia é verbatim: o script troca só o trecho
   entre os marcadores @copia-estilo.css e grava no marcador o sha256 do
   bloco normalizado, para o teste detectar edição manual sem sincronizar.

   Uso:
     node scripts/sync-cofre-css.mjs [caminho/do/estilo.css]

   Sem argumento, lê o estilo.css da skill instalada em
   ~/.pi/agent/skills/ascii-ui/estilo.css. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HTML_PATH = new URL('../public/cofre-btc.html', import.meta.url);
export const DEFAULT_SOURCE = path.join(homedir(), '.pi/agent/skills/ascii-ui/estilo.css');
export const BLOCK_RE = /([ \t]*\/\* @copia-estilo\.css begin sha256=)([0-9a-f]{64})( \*\/\n)([\s\S]*?)(\n[ \t]*\/\* @copia-estilo\.css end \*\/)/;

/* A comparação ignora CRLF e linhas em branco no fim: o conteúdo é o mesmo
   bloco, com ou sem a quebra final que o editor acrescenta. */
export function normalizeCss(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
}

export function cssHash(text) {
  return createHash('sha256').update(normalizeCss(text)).digest('hex');
}

export function extractCssBlock(html) {
  const match = html.match(BLOCK_RE);
  if (!match) {
    throw new Error('marcadores @copia-estilo.css não encontrados em public/cofre-btc.html');
  }
  return { hash: match[2], css: normalizeCss(match[4]) };
}

export function replaceCssBlock(html, css) {
  if (!BLOCK_RE.test(html)) {
    throw new Error('marcadores @copia-estilo.css não encontrados em public/cofre-btc.html');
  }
  const source = normalizeCss(css);
  const hash = cssHash(source);
  return html.replace(BLOCK_RE, function (_, begin, _oldHash, afterBegin, _body, end) {
    return begin + hash + afterBegin + source.replace(/\n$/, '') + end;
  });
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const sourcePath = process.argv[2] || process.env.ASCII_UI_ESTILO || DEFAULT_SOURCE;
  const source = readFileSync(sourcePath, 'utf8');
  const html = readFileSync(HTML_PATH, 'utf8');
  const updated = replaceCssBlock(html, source);
  writeFileSync(HTML_PATH, updated);
  console.log('ok   bloco @copia-estilo.css sincronizado com ' + sourcePath);
  console.log('     sha256 ' + cssHash(source));
}
