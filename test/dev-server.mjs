/* Servidor de desenvolvimento sem Cloudflare e sem rede: sobe um servidor
   Electrum falso em 127.0.0.1 com um cenário fixo, injeta o transporte no
   lugar de `cloudflare:sockets` e serve o Worker + a UI.

   node test/dev-server.mjs  →  http://127.0.0.1:8787/ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';

/* Cenário: bip86 com duas entradas e um gasto; bip84 com uma entrada. */
const ua = parseXpub(USER);
const t86a = await deriveAddress('bip86', ua, 0, 0);
const t86b = await deriveAddress('bip86', ua, 0, 1);
const t84a = await deriveAddress('bip84', ua, 0, 0);

const txA = makeTx([{ txid: '11'.repeat(32), vout: 0 }], [{ value: 11100, script: t86a.script }]);
const txB = makeTx([{ txid: '12'.repeat(32), vout: 0 }], [{ value: 4000, script: t86b.script }]);
const txC = makeTx([{ txid: txA.txid, vout: 0 }], [
  { value: 3000, script: t84a.script },
  { value: 8000, script: t86b.script }
]);

const histories = {
  [scripthash(t86a.script)]: [{ height: 700000, tx_hash: txA.txid }],
  [scripthash(t86b.script)]: [
    { height: 700100, tx_hash: txB.txid },
    { height: 700200, tx_hash: txC.txid }
  ],
  [scripthash(t84a.script)]: [{ height: 700200, tx_hash: txC.txid }]
};
const txs = { [txA.txid]: txA.raw, [txB.txid]: txB.raw, [txC.txid]: txC.raw };

const fake = await startFakeElectrum({ histories, txs });
setConnectOverride(nodeConnect);

const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const headers = {};
      if (body) headers['Content-Type'] = req.headers['content-type'] || 'application/json';
      const request = new Request('http://localhost' + u.pathname + u.search, {
        method: req.method, headers, body: body || undefined
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'application/json; charset=utf-8' });
      res.end(await response.text());
      return;
    }
    const file = u.pathname === '/' ? '/index.html' : u.pathname;
    const full = path.join(pub, file);
    if (!full.startsWith(pub) || !fs.existsSync(full)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String((e && e.stack) || e));
  }
});

server.listen(8787, '127.0.0.1', () => console.log('dev http://127.0.0.1:8787/ (electrum falso na porta ' + fake.port + ')'));
