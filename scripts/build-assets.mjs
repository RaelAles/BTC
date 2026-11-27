#!/usr/bin/env node
/* Gera os assets minificados de public/dist e atualiza o SRI no index.html.

   O index publicado aponta para os arquivos de dist. A folha de fontes é
   ligada antes da folha de estilo, como no sistema ASCII UI, para a primeira
   pintura já usar as métricas da fonte embutida.

   Uso:
     node scripts/build-assets.mjs
     node scripts/build-assets.mjs --check */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(publicDir, 'dist');
const indexPath = path.join(publicDir, 'index.html');

const assets = [
  { source: 'fontes.css', out: 'fontes.min.css', loader: 'css', kind: 'style' },
  { source: 'style.css', out: 'style.min.css', loader: 'css', kind: 'style' },
  { source: 'wallet-local.js', out: 'wallet-local.min.js', loader: 'js', kind: 'script' },
  { source: 'app.js', out: 'app.min.js', loader: 'js', kind: 'script' }
];

function minify(source, loader) {
  return transformSync(source, {
    loader,
    minify: true,
    legalComments: 'none',
    ...(loader === 'js' ? { target: 'es2020' } : {})
  }).code;
}

function sriOf(text) {
  return 'sha384-' + createHash('sha384').update(text).digest('base64');
}

function read(file) {
  return fs.readFileSync(path.join(publicDir, file), 'utf8');
}

function buildOutputs() {
  const outputs = new Map();
  for (const asset of assets) {
    outputs.set(asset.out, minify(read(asset.source), asset.loader));
  }
  return outputs;
}

function tagFor(asset, outputs) {
  if (asset.kind === 'remove') return '';
  const url = '/dist/' + asset.out;
  const integrity = sriOf(outputs.get(asset.out));
  if (asset.kind === 'style') {
    return `<link rel="stylesheet" href="${url}" integrity="${integrity}">`;
  }
  return `<script src="${url}" defer integrity="${integrity}"></script>`;
}

/* O index é arquivo do repositório, mas o build não precisa apostar nisso
   para achar as tags: um regex de tag corta errado um atributo que contenha
   ">" e ignora variações aceitas pelo navegador. O leitor abaixo vai até o
   ">" fora de aspas e só então extrai o atributo. */
function tagEnd(html, start) {
  let quote = '';
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i + 1;
    }
  }
  return -1;
}

function findTag(html, from) {
  const lower = html.toLowerCase();
  let best = -1;
  let name = '';
  for (const candidate of ['<link', '<script']) {
    let at = lower.indexOf(candidate, from);
    /* <linkage> e <scriptsrc> não são as tags que interessam. */
    while (at >= 0 && /[a-z0-9-]/.test(lower[at + candidate.length] || '')) {
      at = lower.indexOf(candidate, at + candidate.length);
    }
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
      name = candidate;
    }
  }
  if (best < 0) return null;
  const end = tagEnd(html, best);
  if (end < 0) return null;
  return { start: best, end, name, tag: html.slice(best, end) };
}

const ATTRIBUTE = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function attribute(tag, name) {
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4];
  }
  return null;
}

function buildIndex(html, outputs) {
  let out = '';
  let at = 0;
  const lower = html.toLowerCase();
  for (let tag = findTag(html, 0); tag; tag = findTag(html, tag.end)) {
    const url = attribute(tag.tag, 'href') ?? attribute(tag.tag, 'src');
    const base = url ? path.posix.basename(url) : '';
    const asset = assets.find((item) => base === item.source || base === item.out);
    if (!asset) continue;
    /* tagFor já devolve o </script>: só o script vazio, como antes. */
    if (tag.name === '<script' && lower.slice(tag.end, tag.end + 9) !== '</script>') continue;

    const replacement = tagFor(asset, outputs);
    let from = tag.start;
    let to = tag.name === '<script' ? tag.end + 9 : tag.end;
    if (!replacement) {
      /* Tag removida sozinha na linha: leva o recuo e a quebra junto. */
      while (from > 0 && (html[from - 1] === ' ' || html[from - 1] === '\t')) from -= 1;
      if (from > 0 && html[from - 1] !== '\n') from = tag.start;
      while (to < html.length && (html[to] === ' ' || html[to] === '\t')) to += 1;
      if (html.startsWith('\r\n', to)) to += 2;
      else if (html[to] === '\n') to += 1;
    }
    out += html.slice(at, from) + replacement;
    at = to;
  }
  return out + html.slice(at);
}

const outputs = buildOutputs();
const currentIndex = fs.readFileSync(indexPath, 'utf8');
const nextIndex = buildIndex(currentIndex, outputs);
const check = process.argv.includes('--check');

if (check) {
  let ok = true;
  for (const [name, code] of outputs) {
    const file = path.join(distDir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== code) {
      console.error('desatualizado: public/dist/' + name);
      ok = false;
    }
  }
  if (nextIndex !== currentIndex) {
    console.error('desatualizado: public/index.html (caminhos ou SRI)');
    ok = false;
  }
  if (!ok) {
    console.error('rode npm run build');
    process.exit(1);
  }
  console.log('ok   public/dist e SRI do index em dia');
} else {
  fs.mkdirSync(distDir, { recursive: true });
  for (const [name, code] of outputs) {
    fs.writeFileSync(path.join(distDir, name), code);
  }
  fs.writeFileSync(indexPath, nextIndex);
  console.log('ok   public/dist gerado e SRI do index atualizado');
}
