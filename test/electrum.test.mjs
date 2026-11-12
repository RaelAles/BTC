/* Testes do cliente Electrum: scripthash, lista de servidores, histórico em
   lote, transações cruas, fallback, timeout e erros.
   Roda sem rede e sem Cloudflare: node test/electrum.test.mjs */
import assert from 'node:assert/strict';
import {
  scripthash, parseServerList, openElectrum, setConnectOverride,
  historiesMany, transactionsMany
} from '../src/electrum.js';
import { startFakeElectrum, nodeConnect, deadPort } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

let passed = 0;
function ok(label) { passed++; console.log('ok   ' + label); }

/* 1. scripthash do p2pkh do endereço 1BER6NT4aokSqpPXeWookR9z95huQ2qHwy
   (script 76a914…88ac). Vetor gerado localmente, sem relação com carteira real. */
{
  const script = Uint8Array.from(Buffer.from('76a914703ac6dd730e73588b200570a39d37db62321c5e88ac', 'hex'));
  assert.equal(scripthash(script), '7db075455a711aea13f16bdb7ba3a99b6ef82a40eff1273ec75d9e25ef44c9a4');
  ok('scripthash p2pkh = sha256(script) invertido');
}

/* 2. Lista de servidores. */
{
  const s = parseServerList('a.example:50002,b.example:50001,c.example:5010:tcp,d.example:50002:tls');
  assert.deepEqual(s, [
    { host: 'a.example', port: 50002, secure: true },
    { host: 'b.example', port: 50001, secure: false },
    { host: 'c.example', port: 5010, secure: false },
    { host: 'd.example', port: 50002, secure: true }
  ]);
  assert.throws(() => parseServerList(''));
  assert.throws(() => parseServerList('sem-porta'));
  assert.throws(() => parseServerList('a:50002:ssl'));
  ok('parseServerList aceita host:porta[:tls|:tcp] e recusa inválidos');
}

/* 3. historiesMany: histórico + mempool por script, numa conexão. */
{
  const s1 = Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(1), 0x88, 0xac]);
  const s2 = Uint8Array.from([0x00, 0x14, ...new Array(20).fill(2)]);
  const s3 = Uint8Array.from([0x51, 0x20, ...new Array(32).fill(3)]);
  const [sh1, sh2, sh3] = [s1, s2, s3].map(scripthash);
  const txA = makeTx([{ txid: '11'.repeat(32), vout: 0 }], [{ value: 1000, script: s1 }]);
  const txB = makeTx([{ txid: txA.txid, vout: 0 }], [{ value: 900, script: s2 }]);
  const txC = makeTx([{ txid: '22'.repeat(32), vout: 1 }], [{ value: 5000, script: s1 }]);

  const fake = await startFakeElectrum({
    histories: {
      [sh1]: [{ height: 700000, tx_hash: txA.txid }, { height: 700100, tx_hash: txB.txid }],
      [sh2]: [{ height: 700100, tx_hash: txB.txid }]
    },
    mempool: {},
    txs: { [txA.txid]: txA.raw, [txB.txid]: txB.raw }
  });
  // txC entra no histórico e no mempool do s1: tem que contar uma vez só
  fake.histories.get(sh1).push({ height: 0, tx_hash: txC.txid });
  fake.mempool.set(sh1, [{ height: 0, tx_hash: txC.txid }]);
  fake.txs.set(txC.txid, txC.raw);

  setConnectOverride(nodeConnect);
  const client = await openElectrum({
    servers: [{ host: fake.host, port: fake.port, secure: false }], timeoutMs: 4000
  });
  const hist = await historiesMany(client, [s1, s2, s3]);
  assert.equal(hist[0].txCount, 3);
  assert.equal(hist[0].heights.get(txA.txid), 700000);
  assert.equal(hist[0].heights.get(txB.txid), 700100);
  assert.equal(hist[0].heights.get(txC.txid), 0, 'mempool entra com altura 0');
  assert.equal(hist[1].txCount, 1);
  assert.equal(hist[2].txCount, 0);
  assert.deepEqual(hist[2].txids, []);

  const raw = await transactionsMany(client, [txA.txid, txB.txid, 'ff'.repeat(32)]);
  assert.equal(raw.raw.get(txA.txid), txA.raw);
  assert.equal(raw.raw.get(txB.txid), txB.raw);
  assert.ok(raw.errors.has('ff'.repeat(32)), 'txid ausente vira erro do item, não do lote');

  await client.close();
  await fake.close();
  ok('historiesMany junta histórico e mempool; transactionsMany tolera txid ausente');
}

/* 4. Fallback: primeiro servidor morto, segundo responde. */
{
  const port = await deadPort();
  const fake = await startFakeElectrum({});
  setConnectOverride(nodeConnect);
  const client = await openElectrum({
    servers: [
      { host: '127.0.0.1', port, secure: false },
      { host: fake.host, port: fake.port, secure: false }
    ],
    timeoutMs: 3000, connectTimeoutMs: 2000
  });
  assert.equal(client.server.port, fake.port);
  await client.close();
  await fake.close();
  ok('openElectrum cai para o próximo servidor quando o primeiro não conecta');
}

/* 5. Timeout, erro de método e uso depois de close. */
{
  const silent = await startFakeElectrum({ silent: true });
  const fake = await startFakeElectrum({});
  setConnectOverride(nodeConnect);
  const none = await openElectrum({
    servers: [{ host: silent.host, port: silent.port, secure: false }],
    timeoutMs: 300, connectTimeoutMs: 2000
  }).catch(() => null);
  assert.equal(none, null, 'server.version sem resposta deve estourar o timeout');

  const c2 = await openElectrum({
    servers: [{ host: fake.host, port: fake.port, secure: false }], timeoutMs: 300
  });
  await assert.rejects(() => c2.request('server.banner', []), /método desconhecido/);
  await assert.rejects(() => c2.request('blockchain.transaction.broadcast', ['00']), /TX decode failed/);
  await c2.close();
  await assert.rejects(() => c2.request('server.ping', []), /fechada/);
  await silent.close();
  await fake.close();
  ok('timeout, erro de método e uso após close são erros claros');
}

/* 6. Sem transporte disponível (Node sem override) → erro claro, sem crash. */
{
  setConnectOverride(null);
  const err = await openElectrum({ servers: [{ host: '127.0.0.1', port: 1, secure: false }] })
    .then(() => null, e => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /TCP indisponível|nenhum servidor Electrum/);
  ok('sem cloudflare:sockets o erro é explícito');
}

console.log('\n' + passed + ' grupos de teste passaram');
