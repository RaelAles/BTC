/* Superfície HTTP: caminho desconhecido não pode voltar 200 só porque a SPA
   fallback entrega o index.html, o site de leitura só aceita GET/HEAD no
   asset layer e cabeçalho de reescrita de caminho não é aceito do cliente.
   Tudo sem rede.

   node test/http-surface.test.mjs */
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function envComAssets(chamadas) {
  return {
    ASSETS: {
      fetch: async (request) => {
        chamadas.push(new URL(request.url).pathname);
        return new Response('<!doctype html><title>app</title>', {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=0, must-revalidate'
          }
        });
      }
    }
  };
}

/* ---------------- 1. SPA fallback vira 404 ---------------- */
{
  const chamadas = [];
  const env = envComAssets(chamadas);
  const r = await worker.fetch(new Request('https://x/qualquer'), env);
  assert.equal(r.status, 404, 'caminho desconhecido responde 404');
  assert.match(await r.text(), /<title>app<\/title>/, 'o corpo é o index.html (tela 404 do app)');
  assert.equal(r.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(r.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff', 'cabeçalhos continuam aplicados');
  assert.deepEqual(chamadas, ['/qualquer'], 'o caminho chega ao asset layer sem reescrita');
  console.log('ok   caminho desconhecido devolve o app com status 404');
}

/* ---------------- 2. páginas publicadas continuam 200 ---------------- */
{
  for (const path of ['/', '/cofre-btc', '/cofre-btc.html']) {
    const env = envComAssets([]);
    const r = await worker.fetch(new Request('https://x' + path), env);
    assert.equal(r.status, 200, path + ' continua 200');
  }
  console.log('ok   /, /cofre-btc e /cofre-btc.html continuam 200');
}

/* ---------------- 3. só GET/HEAD chegam ao asset layer ---------------- */
{
  for (const method of ['PUT', 'PATCH', 'DELETE', 'COPY', 'LOCK', 'PROPFIND', 'OPTIONS']) {
    const chamadas = [];
    const r = await worker.fetch(new Request('https://x/qualquer', { method }), envComAssets(chamadas));
    assert.equal(r.status, 405, method + ' responde 405');
    assert.equal(r.headers.get('Allow'), 'GET, HEAD', method + ' informa os métodos aceitos');
    assert.deepEqual(chamadas, [], method + ' não chega ao asset layer');
  }
  const head = await worker.fetch(new Request('https://x/qualquer', { method: 'HEAD' }), envComAssets([]));
  assert.equal(head.status, 404, 'HEAD segue o mesmo caminho do GET');
  console.log('ok   métodos fora de GET/HEAD respondem 405 sem tocar no ASSETS');
}

/* ---------------- 4. a API mantém os próprios métodos ---------------- */
{
  const nada = await worker.fetch(new Request('https://x/api/nada'), {});
  assert.equal(nada.status, 404, 'rota de API desconhecida continua 404');
  assert.match((await nada.json()).error, /rota não encontrada/);

  const wallet = await worker.fetch(new Request('https://x/api/wallet', { method: 'GET' }), {});
  assert.equal(wallet.status, 405, 'GET em /api/wallet continua 405');
  assert.match((await wallet.json()).error, /use POST/);
  console.log('ok   API preserva 404/405 existentes');
}

/* ---------------- 5. cabeçalho de reescrita de caminho ---------------- */
{
  for (const name of ['x-original-url', 'x-rewrite-url', 'x-forwarded-prefix']) {
    const chamadas = [];
    const r = await worker.fetch(new Request('https://x/', {
      headers: { [name]: '/.git' }
    }), envComAssets(chamadas));
    assert.equal(r.status, 400, name + ' é recusado');
    assert.match((await r.json()).error, /reescrita/);
    assert.deepEqual(chamadas, [], name + ' não chega ao asset layer');
  }
  console.log('ok   cabeçalho de reescrita de caminho responde 400 sem tocar no ASSETS');
}

console.log('\ntestes da superfície HTTP passaram');
