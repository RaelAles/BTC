/* Fluxo sem xpub: o navegador deriva os endereços e o Worker só recebe o
   conjunto. Verifica a margem de 50, a extensão da cauda, o PSBT e o
   Durable Object usando apenas a sessão depois do primeiro /sync.

   node test/watch-mode.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/worker.js';
import { WalletWatcher } from '../src/watcher.js';
import { parseXpub, chainNode, deriveChild } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

const USER = 'xpub6CivfTixRRqAcvALesYmkkL7JHMkbjuM3dKtgUDiWzNcmpovevhPbGUisjFXVM6pWojHnYXMs4HUM8S6qTekRWatk43dGMxCt7mdY82DzDo';
const account = parseXpub(USER);
const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];
const GAP = 50;
const WALLET_ID = 'c'.repeat(64);
const FINGERPRINT = BTC.bytesToHex(BTC.hash160(account.pub)).slice(0, 8);

setConnectOverride(nodeConnect);

async function rowsFor(from, count, only) {
  const out = [];
  for (const type of TYPES) {
    for (const chain of [0, 1]) {
      if (only && (only.type !== type || only.chain !== chain)) continue;
      const node = await chainNode(account, chain);
      for (let i = from; i < from + count; i++) {
        const d = await deriveChild(type, node, chain, i);
        out.push({
          account_type: type,
          chain,
          idx: i,
          address: d.address,
          path: d.path,
          script: BTC.bytesToHex(d.script),
          pub: BTC.bytesToHex(d.pub),
        });
      }
    }
  }
  return out;
}

function bodyWallet(rows) {
  return JSON.stringify({
    watch: rows,
    wallet_id: WALLET_ID,
    fingerprint: FINGERPRINT,
    version_type: account.versionType
  });
}

async function call(path, body, env) {
  const r = await worker.fetch(new Request('https://x' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }), env);
  return { status: r.status, j: await r.json() };
}

/* ---------------- 1. varredura local: margem, extensão e PSBT ---------------- */
{
  const initial = await rowsFor(0, GAP);
  const used = initial.find(r => r.account_type === 'bip84' && r.chain === 0 && r.idx === 3);
  const tx = makeTx([{ txid: '10'.repeat(32), vout: 0 }], [{ value: 10000, script: BTC.hexToBytes(used.script) }]);
  const fake = await startFakeElectrum({
    histories: { [scripthash(BTC.hexToBytes(used.script))]: [{ height: 700000, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };

  const first = await call('/api/wallet', bodyWallet(initial), env);
  assert.equal(first.status, 200);
  assert.equal(first.j.watch, false, 'sem WATCH a consulta é avulsa');
  assert.equal(first.j.balance.total, 10000);
  assert.equal(first.j.watch_status.gap, 50, 'a margem continua 50');
  assert.equal(first.j.watch_status.complete, false, 'usado no índice 3 ainda não fechou a margem');
  const branch = first.j.watch_status.branches['bip84:0'];
  assert.equal(branch.next, 50);
  assert.equal(branch.need, 4, 'faltam 50..53 para fechar 50 vazios depois do índice 3');

  const extra = await rowsFor(branch.next, branch.need, { type: 'bip84', chain: 0 });
  const full = initial.concat(extra);
  const second = await call('/api/wallet', bodyWallet(full), env);
  assert.equal(second.status, 200);
  assert.equal(second.j.watch_status.complete, true);
  assert.equal(second.j.balance.total, 10000);
  assert.equal(second.j.detected_type, 'bip84');
  assert.equal(second.j.types.find(t => t.detected).path, "m/84'/0'/0'/0/4");

  /* transações cruas: o navegador confere UTXOs e monta o PSBT local */
  const raw = await call('/api/raw', {
    watch: full,
    wallet_id: WALLET_ID,
    fingerprint: FINGERPRINT,
    version_type: account.versionType
  }, env);
  assert.equal(raw.status, 200);
  assert.equal(raw.j.raw[tx.txid], tx.raw);

  /* o PSBT é montado sem xpub: o fingerprint vem do cliente e os scripts do
     conjunto local */
  const external = await deriveChild('bip84', await chainNode(account, 0), 0, 100);
  const psbt = await call('/api/psbt', {
    watch: full,
    wallet_id: WALLET_ID,
    fingerprint: FINGERPRINT,
    version_type: account.versionType,
    address: external.address,
    amount_sats: 5000,
    fee_rate: 2
  }, env);
  assert.equal(psbt.status, 200, JSON.stringify(psbt.j));
  assert.ok(psbt.j.psbt, 'PSBT devolvido');
  assert.equal(psbt.j.total_in, 10000);
  assert.equal(psbt.j.outputs[0].address, external.address);

  /* linha malformada é recusada antes de qualquer consulta */
  const bad = await call('/api/wallet', {
    watch: [Object.assign({}, initial[0], { path: "m/84'/0'/0'/0/999" })],
    wallet_id: WALLET_ID,
    fingerprint: FINGERPRINT,
    version_type: account.versionType
  }, env);
  assert.equal(bad.status, 400);
  assert.match(bad.j.error, /caminho de derivação inválido/);

  await fake.close();
  console.log('ok   watch: margem de 50, extensão da cauda e PSBT sem xpub');
}

/* ---------------- 2. Durable Object sem xpub ---------------- */
{
  const initial = await rowsFor(0, GAP);
  const used = initial.find(r => r.account_type === 'bip84' && r.chain === 0 && r.idx === 3);
  const tx = makeTx([{ txid: '11'.repeat(32), vout: 0 }], [{ value: 9000, script: BTC.hexToBytes(used.script) }]);
  const fake = await startFakeElectrum({
    histories: { [scripthash(BTC.hexToBytes(used.script))]: [{ height: 700001, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const watcher = new WalletWatcher({ id: { name: 'watch-test' } }, env);

  const sync = await watcher.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyWallet(initial)
  }));
  assert.equal(sync.status, 200);
  const payload = await sync.json();
  assert.equal(payload.balance.total, 9000);
  assert.equal(payload.watch_status.gap, 50);
  assert.equal(watcher.xpub, null, 'o Durable Object não guarda xpub neste fluxo');
  assert.equal(watcher.watchMode, true);

  /* transações cruas também saem só pela sessão */
  const raw = await watcher.fetch(new Request('https://watch/raw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }));
  assert.equal(raw.status, 200);
  assert.equal((await raw.json()).raw[tx.txid], tx.raw);

  /* a próxima rota usa só a sessão: não manda xpub nem watch */
  const external = await deriveChild('bip84', await chainNode(account, 0), 0, 100);
  const prepare = await watcher.fetch(new Request('https://watch/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: external.address,
      amountSats: 4000,
      feeRate: 2
    })
  }));
  const prepared = await prepare.json();
  assert.equal(prepare.status, 200, JSON.stringify(prepared));
  assert.ok(prepared.psbt, 'PSBT montado só com o estado da sessão');
  assert.equal(prepared.total_in, 9000);

  const wrong = await watcher.fetch(new Request('https://watch/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bodyWallet(initial).replace(WALLET_ID, 'd'.repeat(64))
  }));
  assert.equal(wrong.status, 409);
  assert.match((await wrong.json()).error, /outra carteira/);

  await watcher.stopSession();
  const gone = await watcher.fetch(new Request('https://watch/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: external.address, amountSats: 4000, feeRate: 2 })
  }));
  assert.equal(gone.status, 409, 'sessão sem carteira pede recarga, não 400');
  await fake.close();
  console.log('ok   watch: Durable Object usa só a sessão, sem xpub');
}

/* guarda de regressão: a tela não pode voltar a mandar a xpub ao Worker */
{
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /body\s*=\s*\{\s*xpub\s*:/);
  assert.doesNotMatch(app, /xpub:\s*state\.xpub/);
  assert.doesNotMatch(app, /fetchJson\('\/api\/psbt'/);
  assert.doesNotMatch(app, /fetchJson\('\/api\/cpfp'/);
  assert.match(app, /fetchJson\('\/api\/raw'/);
  console.log('ok   app.js não monta corpo com xpub e monta o PSBT localmente');
}

console.log('\ntestes do modo watch passaram');
