/* Manifestos ARD publicados em public/.well-known/. `ard.json` é o caminho
   que a especificação atual manda o consumidor buscar; `ai-catalog.json` é o
   caminho anterior, que ainda pode ser consultado. Os dois precisam ser o
   mesmo manifesto, senão consumidores antigos e novos leem catálogos
   diferentes.

   node test/well-known-manifest.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/* ---------------- 1. os dois caminhos publicam o mesmo JSON ---------------- */
{
  const ard = read('public/.well-known/ard.json');
  const anterior = read('public/.well-known/ai-catalog.json');
  assert.equal(ard, anterior, 'ard.json e ai-catalog.json são o mesmo manifesto');

  const manifesto = JSON.parse(ard);
  assert.equal(manifesto.specVersion, '1.0');
  assert.ok(Array.isArray(manifesto.entries), 'o manifesto tem o array entries');
  assert.equal(typeof manifesto.host.displayName, 'string', 'host.displayName é texto');
  console.log('ok   ard.json e ai-catalog.json são o mesmo manifesto válido');
}

/* ---------------- 2. a página anuncia o manifesto ---------------- */
{
  const html = read('public/index.html');
  assert.match(html, /<link rel="ard" href="\/\.well-known\/ard\.json">/,
    'index.html anuncia o manifesto com rel="ard"');
  console.log('ok   index.html anuncia /.well-known/ard.json');
}

/* ---------------- 3. o namespace .well-known passa pelo Worker ---------------- */
{
  /* Sem isso, um manifesto ausente volta como 200 com o index.html da SPA
     fallback, e o cliente que espera JSON reporta "malformed JSON". */
  const wrangler = read('wrangler.jsonc');
  const rwf = wrangler.match(/"run_worker_first":\s*\[([^\]]*)\]/);
  assert.ok(rwf, 'wrangler.jsonc declara run_worker_first');
  assert.ok(rwf[1].includes('"/.well-known/*"'),
    'run_worker_first cobre /.well-known/*');

  /* Os dois manifestos são lidos por agentes de outra origem. */
  const headers = read('public/_headers');
  for (const arquivo of ['ai-catalog.json', 'ard.json']) {
    assert.match(headers, new RegExp('/\\.well-known/' + arquivo.replace('.', '\\.') +
      '\\n\\s+Access-Control-Allow-Origin: \\*'),
    'public/_headers libera ' + arquivo + ' para outra origem');
  }
  console.log('ok   /.well-known/* vai ao Worker e os manifestos têm CORS');
}

console.log('\ntestes dos manifestos públicos passaram');
