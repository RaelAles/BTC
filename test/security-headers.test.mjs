/* Cabeçalhos de segurança: as duas cópias (Worker e public/_headers) têm
   que sair iguais, o hash do script inline do tema e o SRI (integrity) de
   app.js/folhas de estilo têm que estar em dia e nenhuma resposta pode
   escapar sem os nove cabeçalhos.

   node test/security-headers.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { SECURITY_HEADERS } from '../src/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const NOMES = [
  'strict-transport-security',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy'
];

/* Lê o bloco `/*` de public/_headers (o formato do Cloudflare: linha de
   caminho, depois cabeçalhos indentados; `#` é comentário). */
function blocoDeHeaders(text) {
  const out = {};
  let dentro = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '/*') { dentro = true; continue; }
    if (!dentro) continue;
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.+)$/);
    assert.ok(m, 'linha inválida em public/_headers: ' + line);
    out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

/* ---------------- 1. as duas cópias batem ---------------- */
{
  const arquivo = blocoDeHeaders(read('public/_headers'));
  assert.deepEqual(
    Object.keys(SECURITY_HEADERS).map(k => k.toLowerCase()).sort(),
    [...NOMES].sort(),
    'SECURITY_HEADERS tem exatamente os nove cabeçalhos'
  );
  for (const nome of NOMES) {
    assert.equal(arquivo[nome], SECURITY_HEADERS[
      Object.keys(SECURITY_HEADERS).find(k => k.toLowerCase() === nome)
    ], 'public/_headers e src/config.js iguais em ' + nome);
  }
  console.log('ok   public/_headers e SECURITY_HEADERS iguais nos nove cabeçalhos');
}

/* ---------------- 2. hash do script inline do tema ---------------- */
{
  const html = read('public/index.html');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inline, 'index.html mantém o script inline do tema');
  const hash = createHash('sha256').update(inline[1], 'utf8').digest('base64');
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.ok(csp.includes("'sha256-" + hash + "'"),
    'o hash da CSP acompanha o script inline do tema');
  assert.ok(!/style-src[^;]*'unsafe-inline'/.test(csp),
    "style-src dispensa 'unsafe-inline'");
  assert.ok(!/script-src[^;]*'unsafe-(inline|eval)'/.test(csp),
    "script-src dispensa 'unsafe-inline' e 'unsafe-eval'");
  assert.ok(!/\sstyle="/.test(html), 'index.html não usa atributo style=');
  assert.ok(!/<style[\s>]/.test(html), 'index.html não usa <style> inline');
  console.log('ok   hash do tema, sem unsafe-inline e sem style inline no HTML');
}

/* ---------------- 3. todas as respostas levam os cabeçalhos ---------------- */
{
  const env = {
    ELECTRUM_SERVERS: 'off',
    ASSETS: {
      fetch: async () => new Response('<!doctype html>', {
        status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
  };
  const confere = (r, rotulo) => {
    for (const nome of NOMES) {
      assert.equal(r.headers.get(nome), SECURITY_HEADERS[
        Object.keys(SECURITY_HEADERS).find(k => k.toLowerCase() === nome)
      ], rotulo + ' leva ' + nome);
    }
  };
  const asset = await worker.fetch(new Request('https://x/'), env);
  confere(asset, 'estático');
  assert.equal(asset.headers.get('Content-Type'), 'text/html; charset=utf-8', 'preserva o Content-Type');
  assert.equal(await asset.text(), '<!doctype html>', 'preserva o corpo');
  const api = await worker.fetch(new Request('https://x/api/health'), env);
  confere(api, 'API');
  const erro = await worker.fetch(new Request('https://x/api/nada'), env);
  confere(erro, 'erro');
  console.log('ok   estático, API e erro levam os nove cabeçalhos');
}

/* ---------------- 4. SRI nos scripts e folhas de estilo ---------------- */
{
  const html = read('public/index.html');
  const alvos = [];
  for (const [tag] of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const src = /\ssrc="([^"]+)"/.exec(tag);
    const href = /\shref="([^"]+)"/.exec(tag);
    const rel = /\srel="([^"]+)"/.exec(tag);
    const url = src ? src[1]
      : (rel && rel[1] === 'stylesheet' && href ? href[1] : '');
    // só recursos da própria origem; data:, manifest e ícones não levam SRI
    if (!url || !url.startsWith('/') || url.startsWith('//')) continue;
    alvos.push({ tag, url });
  }
  assert.equal(alvos.length, 3,
    'SRI cobre app.js e as duas folhas de estilo (achou ' + alvos.length + ')');
  for (const { tag, url } of alvos) {
    const file = path.join(root, 'public', url.slice(1));
    assert.ok(fs.existsSync(file), 'SRI: arquivo existe ' + url);
    const esperado = 'sha384-' +
      createHash('sha384').update(fs.readFileSync(file)).digest('base64');
    const m = /\sintegrity="([^"]+)"/.exec(tag);
    assert.ok(m, 'SRI: ' + url + ' tem integrity na tag');
    assert.equal(m[1], esperado,
      'SRI: integrity de ' + url + ' acompanha o arquivo (novo hash: ' + esperado + ')');
  }
  console.log('ok   SRI confere em app.js, style.css e fontes.css');
}

/* ---------------- 5. o 101 do WebSocket passa intacto ---------------- */
{
  const upgrade = { status: 101, webSocket: null };
  const env = {
    WATCH: {
      idFromString: () => ({}),
      get: () => ({ fetch: async () => upgrade })
    }
  };
  const r = await worker.fetch(new Request(
    'https://x/api/events?session=' + 'a'.repeat(64)), env);
  assert.equal(r, upgrade, 'o handshake 101 não é recriado');
  console.log('ok   handshake 101 do WebSocket passa intacto');
}

console.log('\ntestes dos cabeçalhos de segurança passaram');
