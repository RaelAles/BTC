/* Teste de ponta a ponta do Worker sem rede: servidor Electrum falso.
   Verifica a conta de saldo/recebido/enviado por endereço, o próximo
   endereço, a margem fixa de 50 e a ausência de outra fonte. Não existe D1:
   o env dos testes é só Electrum, então qualquer tentativa de gravar
   quebraria o teste.

   node test/worker.test.mjs */
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride, openElectrum } from '../src/electrum.js';
import { WalletScanner } from '../src/wallet-sync.js';
import { startFakeElectrum, nodeConnect, deadPort } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const ua = parseXpub(USER);

/* ---------------- helpers ---------------- */
function req(xpub, session) {
  const body = { xpub };
  if (session) body.session = session;
  return new Request('https://x/api/wallet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}
async function run(xpub, env) {
  const r = await worker.fetch(req(xpub), env || {});
  return { status: r.status, j: await r.json() };
}
async function addr(type, chain, idx) { return await deriveAddress(type, ua, chain, idx); }

setConnectOverride(nodeConnect);

/* ---------------- 1. saldo, recebido, enviado e próximo endereço ---------------- */
{
  const a0 = await addr('bip84', 0, 0);
  const a1 = await addr('bip84', 0, 1);
  const [sh0, sh1] = [scripthash(a0.script), scripthash(a1.script)];
  const tx1 = makeTx([{ txid: '00'.repeat(32), vout: 0 }], [{ value: 10000, script: a0.script }]);
  const tx2 = makeTx([{ txid: tx1.txid, vout: 0 }], [{ value: 9000, script: a1.script }]);

  const fake = await startFakeElectrum({
    histories: {
      [sh0]: [{ height: 700000, tx_hash: tx1.txid }, { height: 700100, tx_hash: tx2.txid }],
      [sh1]: [{ height: 700100, tx_hash: tx2.txid }]
    },
    txs: { [tx1.txid]: tx1.raw, [tx2.txid]: tx2.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };

  const r = await run(USER, env);
  assert.equal(r.status, 200);
  assert.equal(r.j.detected_type, 'bip84');
  assert.equal(r.j.watch, false, 'sem binding WATCH a consulta é avulsa');
  assert.equal(r.j.xpub_hash, undefined, 'a resposta não carrega identificador da xpub');
  assert.equal(r.j.balance.detected, 9000);
  assert.equal(r.j.balance.total, 9000);

  const used = r.j.addresses;
  assert.equal(used.length, 2, 'só os endereços usados vão para a resposta');
  assert.deepEqual(used.map(x => x.address), [a1.address, a0.address],
    'ordem do uso mais recente: a1 e a0 dividem a altura 700100, e o índice maior vem antes');
  assert.deepEqual(used.map(x => x.last_height), [700100, 700100]);
  assert.deepEqual(used.map(x => x.pending), [false, false]);
  const row0 = used.find(x => x.address === a0.address);
  const row1 = used.find(x => x.address === a1.address);
  assert.deepEqual(
    { received: row0.received, spent: row0.spent, balance: row0.balance, tx: row0.tx_count },
    { received: 10000, spent: 10000, balance: 0, tx: 2 }
  );
  assert.deepEqual(
    { received: row1.received, spent: row1.spent, balance: row1.balance, tx: row1.tx_count },
    { received: 9000, spent: 0, balance: 9000, tx: 1 }
  );
  const det = r.j.types.find(t => t.detected);
  assert.equal(det.address, (await addr('bip84', 0, 2)).address, 'próximo = último usado + 1');
  assert.equal(det.path, "m/84'/0'/0'/0/2");
  assert.equal(det.change_address, (await addr('bip84', 1, 0)).address,
    'troco = próximo do ramo /1, mesmo tipo');
  assert.equal(det.change_path, "m/84'/0'/0'/1/0");
  assert.equal(fake.count('blockchain.transaction.get'), 2, 'uma busca por transação');

  /* sem cache durável, uma nova consulta refaz a varredura e o download */
  const before = fake.count('blockchain.transaction.get');
  const r2 = await run(USER, env);
  assert.equal(r2.j.balance.total, 9000);
  assert.equal(fake.count('blockchain.transaction.get'), before + 2, 'nada foi cacheado entre consultas');

  /* gasto novo: a1 manda 8500 de volta para a0 */
  const tx3 = makeTx([{ txid: tx2.txid, vout: 0 }], [{ value: 8500, script: a0.script }]);
  fake.txs.set(tx3.txid, tx3.raw);
  fake.histories.get(sh0).push({ height: 700200, tx_hash: tx3.txid });
  fake.histories.get(sh1).push({ height: 700200, tx_hash: tx3.txid });

  const r3 = await run(USER, env);
  const u0 = r3.j.addresses.find(x => x.address === a0.address);
  const u1 = r3.j.addresses.find(x => x.address === a1.address);
  assert.equal(u0.received, 18500);
  assert.equal(u0.spent, 10000);
  assert.equal(u0.balance, 8500);
  assert.equal(u0.tx_count, 3);
  assert.equal(u1.received, 9000);
  assert.equal(u1.spent, 9000);
  assert.equal(u1.balance, 0);
  assert.equal(r3.j.balance.total, 8500);
  assert.equal(r3.j.addresses[0].last_height, 700200, 'o gasto também conta como uso do endereço');
  assert.deepEqual(r3.j.addresses.map(x => x.address), [a1.address, a0.address],
    'os dois passaram pelo bloco 700200 e o índice maior desempata');

  console.log('ok   saldo/recebido/enviado por endereço, próximo índice, sem cache entre consultas');
  await fake.close();
}

/* ---------------- 2. união dos tipos + prioridade da detecção ---------------- */
{
  const t86 = await addr('bip86', 0, 0);
  const t84 = await addr('bip84', 0, 3);
  const txA = makeTx([{ txid: '01'.repeat(32), vout: 0 }], [{ value: 5000, script: t86.script }]);
  const txB = makeTx([{ txid: '02'.repeat(32), vout: 0 }], [{ value: 7000, script: t84.script }]);
  const fake = await startFakeElectrum({
    histories: {
      [scripthash(t86.script)]: [{ height: 700000, tx_hash: txA.txid }],
      [scripthash(t84.script)]: [{ height: 700000, tx_hash: txB.txid }]
    },
    txs: { [txA.txid]: txA.raw, [txB.txid]: txB.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await run(USER, env);
  assert.equal(r.j.detected_type, 'bip86', 'com xpub: bip44 → bip86 → bip84 → bip49');
  assert.equal(r.j.balance.detected, 5000);
  const extra = r.j.types.find(t => t.type === 'bip84');
  assert.equal(extra.balance, 7000, 'o outro tipo com histórico entra nos types');
  assert.equal(r.j.balance.total, 12000);
  assert.equal(r.j.types.find(t => t.detected).path, "m/86'/0'/0'/0/1");
  assert.equal(extra.address, (await addr('bip84', 0, 4)).address);

  /* mempool entra no saldo */
  const memTx = makeTx([{ txid: '03'.repeat(32), vout: 0 }], [{ value: 1234, script: t86.script }]);
  fake.txs.set(memTx.txid, memTx.raw);
  fake.mempool.set(scripthash(t86.script), [{ height: 0, tx_hash: memTx.txid }]);
  const r2 = await run(USER, env);
  assert.equal(r2.j.balance.detected, 6234, 'transação no mempool conta no saldo');
  const u86 = r2.j.addresses.find(x => x.address === t86.address);
  assert.equal(u86.tx_count, 2);
  assert.equal(u86.pending, true, 'transação no mempool marca o endereço como pendente');
  assert.equal(u86.last_height, 700000, 'o mempool não inventa altura');
  assert.equal(r2.j.addresses[0].address, t86.address, 'pendente vem antes de qualquer bloco confirmado');

  console.log('ok   união dos quatro tipos, prioridade de detecção e mempool');
  await fake.close();
}

/* ---------------- 3. sem Electrum não há outra fonte ---------------- */
{
  const r = await run(USER, {
    ELECTRUM_SERVERS: '127.0.0.1:' + (await deadPort()) + ':tcp', ELECTRUM_TIMEOUT_MS: '800'
  });
  assert.equal(r.status, 502, 'erro explícito em vez de cair para Esplora');
  assert.match(r.j.error, /Electrum indisponível/);

  const off = await run(USER, { ELECTRUM_SERVERS: 'off' });
  assert.equal(off.status, 503);

  console.log('ok   sem Electrum a resposta é erro claro (nenhum fallback)');
}

/* ---------------- 4. entrada recusada: endereço, xprv, lixo ---------------- */
{
  const address = await run('1BER6NT4aokSqpPXeWookR9z95huQ2qHwy');
  assert.equal(address.status, 400);
  assert.match(address.j.error, /endereço Bitcoin, não uma xpub/);

  const xprv = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
  const priv = await run(xprv);
  assert.equal(priv.status, 400);
  assert.match(priv.j.error, /chave privada/);

  const junk = await run('minha chave 123');
  assert.equal(junk.status, 400);
  assert.match(junk.j.error, /xpub, zpub ou ypub/);

  console.log('ok   entrada recusada antes de consultar (endereço, xprv, texto solto)');
}

/* ---------------- 5. margem fixa de 50, sem teto de carteira ---------------- */
{
  const fake = await startFakeElectrum({});
  const env5 = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const r = await run(USER, env5);
  assert.equal(r.status, 200);
  assert.equal(fake.count('blockchain.scripthash.get_history'), 400, 'carteira vazia: 8 ramos × 50');
  assert.equal(r.j.types.find(t => t.detected).path, "m/86'/0'/0'/0/0");

  // atividade no índice 2 de bip84/0: ramo vai até 2 + 50 = 52
  const a2 = await addr('bip84', 0, 2);
  const tx = makeTx([{ txid: '04'.repeat(32), vout: 0 }], [{ value: 1234, script: a2.script }]);
  const fake2 = await startFakeElectrum({
    histories: { [scripthash(a2.script)]: [{ height: 700000, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const r2 = await run(USER, {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake2.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000'
  });
  // 8 ramos × 50 + 3 da extensão do ramo usado (índices 50..52)
  assert.equal(fake2.count('blockchain.scripthash.get_history'), 403, 'índice 2 usado + 50 de cauda = 0..52');
  const used = r2.j.addresses.find(a => a.address === a2.address);
  assert.equal(used.balance, 1234);
  assert.equal(r2.j.types.find(t => t.detected).address, (await addr('bip84', 0, 3)).address);

  /* scripthashes observados: usados + cauda de gap. Com gap 5, o ramo
     bip84/0 derivou 0..7 e o índice 2 é o único usado; 0 e 1 ficam de fora. */
  const client = await openElectrum({
    servers: [{ host: '127.0.0.1', port: fake2.port, secure: false }], timeoutMs: 5000
  });
  const scanner = await new WalletScanner({ env: {}, xpub: USER, account: ua, client, gap: 5 }).init();
  await scanner.fullSync();
  assert.equal(scanner.byScript.size, 43, 'gap 5: 8 ramos × 5 + 3 da extensão');
  assert.equal(scanner.scriptsForWatch().length, 41, 'não assina 0 e 1, vazios fora da cauda');
  await client.close();

  console.log('ok   margem fixa de 50 por ramo, sem teto de 400');
  await fake.close();
  await fake2.close();
}

/* ---------------- 6. uso além do antigo teto de 400 ---------------- */
{
  /* Uso a cada 50 endereços até o 500: a margem nunca fecha antes e a
     varredura precisa passar do antigo teto de 400 para achar o saldo. */
  const usedIdx = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
  const addrs = [];
  for (const i of usedIdx) addrs.push(await addr('bip84', 0, i));
  const tx = makeTx([{ txid: '05'.repeat(32), vout: 0 }],
    addrs.map(a => ({ value: 1000, script: a.script })));
  const histories = {};
  for (const a of addrs) histories[scripthash(a.script)] = [{ height: 700000, tx_hash: tx.txid }];
  const fake6 = await startFakeElectrum({ histories, txs: { [tx.txid]: tx.raw } });
  const r = await run(USER, {
    ELECTRUM_SERVERS: '127.0.0.1:' + fake6.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000'
  });
  assert.equal(r.status, 200);
  assert.equal(r.j.balance.total, 11000, 'soma os 11 endereços usados');
  assert.ok(r.j.addresses.some(a => a.address === addrs[addrs.length - 1].address),
    'o endereço 500 aparece');
  assert.equal(r.j.types.find(t => t.detected).path, "m/84'/0'/0'/0/501");
  assert.ok(fake6.count('blockchain.scripthash.get_history') > 400,
    'a varredura passa do antigo teto de 400');
  console.log('ok   varredura passa do antigo teto de 400 e encontra o índice 500');
  await fake6.close();
}

console.log('\ntestes do worker passaram');
