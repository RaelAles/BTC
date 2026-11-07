/* Testes do cliente Electrum: scripthash, lista de servidores, pipelining,
   fallback entre servidores, timeout, erro de método e fechamento.
   Roda sem rede e sem Cloudflare: node test/electrum.test.mjs */
import assert from 'node:assert/strict';
import {
  scripthash, parseServerList, openElectrum, setConnectOverride, statsMany
} from '../src/electrum.js';
import { startFakeElectrum, nodeConnect, deadPort } from './fake-electrum.mjs';

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

/* 3. statsMany: 3 scripts em 6 pedidos numa conexão, na ordem. */
{
  const scripts = [
    Uint8Array.from([0x76, 0xa9, 0x14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0x88, 0xac]),
    Uint8Array.from([0x00, 0x14, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39]),
    Uint8Array.from([0x51, 0x20, ...new Array(32).fill(7)])
  ];
  const shs = scripts.map(scripthash);
  const fake = await startFakeElectrum({
    balances: { [shs[0]]: 10665, [shs[1]]: 4200 },
    histories: { [shs[0]]: 3, [shs[1]]: 0 }
  });
  setConnectOverride(nodeConnect);
  const client = await openElectrum({
    servers: [{ host: fake.host, port: fake.port, secure: false }], timeoutMs: 4000
  });
  assert.equal(client.name, '127.0.0.1:' + fake.port);
  assert.deepEqual(client.version, ['fake-electrum 1.0', '1.4']);
  const stats = await statsMany(client, scripts);
  assert.deepEqual(stats.map(s => s.balance), [10665, 4200, 0]);
  assert.deepEqual(stats.map(s => s.txCount), [3, 0, 0]);
  assert.deepEqual(stats.map(s => s.scripthash), shs);
  assert.equal(stats[0].funded, null);
  assert.equal(fake.requests.length, 1 + 6, 'um server.version e dois pedidos por script');
  const bal = await client.balance(shs[0]);
  assert.deepEqual(bal, { confirmed: 10665, unconfirmed: 0, total: 10665 });
  const empty = await client.history(shs[2]);
  assert.deepEqual(empty, []);
  await client.close();
  await fake.close();
  ok('statsMany responde saldo e tx_count em lote na mesma conexão');
}

/* 4. Fallback: primeiro servidor morto, segundo responde. */
{
  const port = await deadPort();
  const fake = await startFakeElectrum({ balances: {} });
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

/* 5. Timeout de requisição e erro de método. */
{
  const silent = await startFakeElectrum({ silent: true });
  const fake = await startFakeElectrum({ balances: {} });
  setConnectOverride(nodeConnect);
  const client = await openElectrum({
    servers: [{ host: silent.host, port: silent.port, secure: false }],
    timeoutMs: 300, connectTimeoutMs: 2000
  }).catch(() => null);
  assert.equal(client, null, 'server.version sem resposta deve estourar o timeout');

  const c2 = await openElectrum({
    servers: [{ host: fake.host, port: fake.port, secure: false }], timeoutMs: 300
  });
  await assert.rejects(() => c2.request('blockchain.transaction.get', ['00']), /método desconhecido/);
  const dead = await startFakeElectrum({ silent: true });
  await c2.close();
  await assert.rejects(() => c2.balance('00'), /fechada/);
  await silent.close();
  await fake.close();
  await dead.close();
  ok('timeout, erro de método e uso após close são erros claros');
}

/* 6. Sem transporte disponível (Node sem override) → erro claro, não crash. */
{
  setConnectOverride(null);
  const err = await openElectrum({ servers: [{ host: '127.0.0.1', port: 1, secure: false }] })
    .then(() => null, e => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /TCP indisponível|nenhum servidor Electrum/);
  ok('sem cloudflare:sockets o erro é explícito');
}

console.log('\n' + passed + ' grupos de teste passaram');
