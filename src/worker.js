import { parseXpub, chainNode, deriveChild, TYPE_INFO } from './derivation.js';
import {
  DEFAULT_SERVERS, openElectrum, parseServerList, historiesMany, transactionsMany
} from './electrum.js';
import { totalsForScripts } from './address-totals.js';
import BTC from './btc-core.js';

/* Projeto 2 — Worker + D1 com fonte única Electrum.

   - a xpub é a credencial (hash SHA-256 no D1);
   - o Worker deriva os endereços públicos, guarda endereço + scriptPubKey
     no D1 e guarda as transações cruas num cache (nunca mudam);
   - saldo e histórico vêm do servidor Electrum do mesmo jeito que o
     Electrum e o Sparrow fazem: por scripthash, `get_history` +
     `get_mempool` + `transaction.get` (crua), com o parse e a conta de
     UTXO feitos aqui;
   - não existe outra fonte de dados (sem Esplora, sem blockchain.info);
   - o próximo endereço é `último usado + 1` (convenção BIP), e a varredura
     para depois de 20 endereços seguidos sem uso.

   Sem chave privada em lugar nenhum. */

const GAP = 20;            // endereços seguidos sem uso para parar a varredura
const TX_CACHE_CHUNK = 80; // txids por consulta no D1
const HIST_CONCURRENCY = 100; // pedidos de histórico em voo por rodada
const TX_CONCURRENCY = 20;   // transações cruas em voo
const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];

function now() { return new Date().toISOString(); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function fail(message, status = 400) { return json({ error: String(message) }, status); }

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ELECTRUM_SERVERS="host:porta[:tls|:tcp],..." (off desliga), ELECTRUM_TIMEOUT_MS */
function electrumConfig(env) {
  const raw = env && env.ELECTRUM_SERVERS;
  const text = raw == null ? '' : String(raw).trim();
  if (/^(off|0|false|no)$/i.test(text)) return null;
  let servers;
  try { servers = text ? parseServerList(text) : DEFAULT_SERVERS; }
  catch (e) { return null; }
  return {
    servers,
    timeoutMs: Number((env && env.ELECTRUM_TIMEOUT_MS) || 8000),
    maxScan: Math.max(GAP, Number((env && env.SCAN_MAX) || 400))
  };
}

/* ---------- D1 ---------- */

async function getWallet(env, hash) {
  return await env.DB.prepare('SELECT * FROM wallets WHERE xpub_hash = ?').bind(hash).first();
}
async function insertWallet(env, hash, xpub, account, type) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO wallets (xpub_hash, xpub, version_type, account_type, next_receive, next_change, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).bind(hash, xpub, account.versionType, type, t, t).run();
  return await getWallet(env, hash);
}
async function setWallet(env, hash, type, nextReceive, nextChange, balance) {
  await env.DB.prepare(
    'UPDATE wallets SET account_type = ?, next_receive = ?, next_change = ?, balance = ?, updated_at = ? WHERE xpub_hash = ?'
  ).bind(type, nextReceive, nextChange, balance, now(), hash).run();
}

function rowKey(type, chain) { return type + ':' + chain; }

function emptyRow(row) {
  return {
    account_type: row.account_type,
    chain: Number(row.chain),
    idx: Number(row.idx),
    address: row.address,
    script: row.script,
    used: Number(row.used) || 0,
    balance: Number(row.balance) || 0,
    received: Number(row.received) || 0,
    spent: Number(row.spent) || 0,
    tx_count: Number(row.tx_count) || 0,
    heights: new Map(),
    txids: [],
    stale: false,
    _orig: {
      used: Number(row.used) || 0,
      balance: Number(row.balance) || 0,
      received: Number(row.received) || 0,
      spent: Number(row.spent) || 0,
      tx_count: Number(row.tx_count) || 0
    }
  };
}

async function loadRows(env, hash) {
  const res = await env.DB.prepare('SELECT * FROM addresses WHERE xpub_hash = ?').bind(hash).all();
  const map = new Map();
  for (const row of (res.results || [])) {
    if (!row.script) continue; // linha de schema antigo: será derivada de novo
    const key = rowKey(row.account_type, row.chain);
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(Number(row.idx), emptyRow(row));
  }
  return map;
}

function needsWrite(r) {
  const o = r._orig;
  if (!o) return true;
  return o.used !== (r.used ? 1 : 0) || o.balance !== r.balance ||
    o.received !== r.received || o.spent !== r.spent || o.tx_count !== r.tx_count;
}

async function saveRows(env, hash, rows) {
  const stmts = [];
  const t = now();
  for (const r of rows) {
    if (!needsWrite(r)) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO addresses (xpub_hash, account_type, chain, idx, address, script, used, balance, received, spent, tx_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (xpub_hash, account_type, chain, idx) DO UPDATE SET
         address = excluded.address, script = excluded.script, used = excluded.used,
         balance = excluded.balance, received = excluded.received, spent = excluded.spent,
         tx_count = excluded.tx_count, updated_at = excluded.updated_at`
    ).bind(hash, r.account_type, r.chain, r.idx, r.address, r.script,
      r.used ? 1 : 0, r.balance, r.received, r.spent, r.tx_count, t));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

async function loadCachedTx(ctx, txids) {
  const out = new Map();
  for (let i = 0; i < txids.length; i += TX_CACHE_CHUNK) {
    const chunk = txids.slice(i, i + TX_CACHE_CHUNK);
    const sql = 'SELECT txid, raw FROM transactions WHERE xpub_hash = ? AND txid IN (' +
      chunk.map(() => '?').join(',') + ')';
    const res = await ctx.env.DB.prepare(sql).bind(ctx.hash, ...chunk).all();
    for (const row of (res.results || [])) out.set(row.txid, row.raw);
  }
  return out;
}

async function saveTxs(env, hash, items) {
  const stmts = [];
  for (const it of items) {
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO transactions (xpub_hash, txid, raw) VALUES (?, ?, ?)')
      .bind(hash, it.txid, it.raw));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/* ---------- varredura ---------- */

async function chainNodeCached(ctx, account, chain) {
  const key = 'chain:' + chain;
  if (!ctx.chainNodes.has(key)) ctx.chainNodes.set(key, await chainNode(account, chain));
  return ctx.chainNodes.get(key);
}

async function makeRow(ctx, account, type, chain, idx) {
  const cn = await chainNodeCached(ctx, account, chain);
  const a = await deriveChild(type, cn, chain, idx);
  return {
    account_type: type, chain, idx, address: a.address, path: a.path,
    script: BTC.bytesToHex(a.script),
    used: 0, balance: 0, received: 0, spent: 0, tx_count: 0,
    heights: new Map(), txids: [], stale: false, _orig: null
  };
}

/* Histórico + mempool dos endereços, tudo em uma rodada (um lote). */
async function queryRows(ctx, rows) {
  if (!rows.length) return;
  const hist = await historiesMany(ctx.client, rows.map(r => BTC.hexToBytes(r.script)),
    { concurrency: HIST_CONCURRENCY });
  rows.forEach((r, i) => {
    const h = hist[i];
    r.heights = h.heights;
    r.txids = h.txids;
    r.tx_count = h.txCount;
    r.used = h.txCount > 0 ? 1 : 0;
  });
}

function lastUsedOf(rows) {
  let lastUsed = -1;
  let maxIdx = -1;
  for (const r of rows.values()) {
    if (r.idx > maxIdx) maxIdx = r.idx;
    if (r.used && r.idx > lastUsed) lastUsed = r.idx;
  }
  return { lastUsed, maxIdx };
}

/* Consulta o que já está no D1 e estende cada ramo até GAP endereços sem uso.
   As extensões de todos os ramos vão numa rodada só. */
async function scanAll(ctx, account) {
  if (!ctx.rows.size) {
    for (const type of TYPES) for (const chain of [0, 1]) ctx.rows.set(rowKey(type, chain), new Map());
  }
  await queryRows(ctx, flattenRows(ctx));

  for (let round = 0; round < 64; round++) {
    const fresh = [];
    for (const type of TYPES) {
      for (const chain of [0, 1]) {
        const rows = ctx.rows.get(rowKey(type, chain));
        const { lastUsed, maxIdx } = lastUsedOf(rows);
        if (maxIdx - lastUsed >= GAP) continue;
        const from = maxIdx + 1;
        const to = Math.min(lastUsed + GAP, ctx.maxScan - 1);
        if (from > to) {
          ctx.warnings.push('ramo ' + type + '/' + chain + ' parou no teto de ' +
            ctx.maxScan + ' endereços (último usado: ' + lastUsed + ')');
          continue;
        }
        for (let i = from; i <= to; i++) {
          const row = await makeRow(ctx, account, type, chain, i);
          rows.set(i, row);
          fresh.push(row);
        }
      }
    }
    if (!fresh.length) break;
    await queryRows(ctx, fresh);
  }
}

/* Próximo endereço de cada ramo: último usado + 1 (convenção BIP). */
function branchOf(ctx, type, chain) {
  const rows = ctx.rows.get(rowKey(type, chain));
  const { lastUsed } = lastUsedOf(rows);
  const next = lastUsed + 1;
  const row = rows.get(next);
  return {
    chain, next, lastUsed,
    address: row ? row.address : null,
    path: row ? row.path : null
  };
}

/* Saldo/recebido/enviado de todos os scripts a partir das transações cruas.
   Cache no D1: transação confirmada nunca muda, então só as novas são baixadas. */
async function computeTotals(ctx) {
  const heights = new Map();
  const scripts = new Set();
  for (const rows of ctx.rows.values()) {
    for (const r of rows.values()) {
      if (!r.txids.length) continue;
      scripts.add(r.script);
      for (const [txid, h] of r.heights) if (!heights.has(txid)) heights.set(txid, h);
    }
  }
  if (!heights.size) return { totals: new Map(), errors: new Map() };

  const cached = await loadCachedTx(ctx, [...heights.keys()]);
  const missing = [...heights.keys()].filter(t => !cached.has(t));
  const fetched = missing.length
    ? await transactionsMany(ctx.client, missing, { concurrency: TX_CONCURRENCY })
    : { raw: new Map(), errors: new Map() };

  for (const [txid, raw] of fetched.raw) ctx.newTxs.push({ txid, raw });

  const errors = new Map(fetched.errors);
  const entries = [];
  for (const [txid, raw] of [...cached, ...fetched.raw]) {
    try {
      const tx = BTC.readTx(BTC.hexToBytes(raw));
      entries.push({ txid, height: heights.get(txid) || 0, outputs: tx.outputs, inputs: tx.inputs });
    } catch (e) {
      errors.set(txid, 'transação ilegível');
    }
  }
  return { totals: totalsForScripts(entries, scripts), errors };
}

function applyTotals(ctx, totals, errors) {
  for (const rows of ctx.rows.values()) {
    for (const r of rows.values()) {
      if (r.txids.some(t => errors.has(t))) {
        // sem a transação não dá para fechar a conta: mantém o último valor gravado
        r.stale = true;
        r.used = r.txids.length ? 1 : 0;
        r.tx_count = r.txids.length;
        continue;
      }
      const t = totals.get(r.script);
      r.received = t ? t.received : 0;
      r.spent = t ? t.spent : 0;
      r.balance = t ? t.balance : 0;
      r.tx_count = t ? t.txCount : 0;
      r.confirmed = t ? t.confirmed : 0;
      r.unconfirmed = t ? t.unconfirmed : 0;
      r.used = r.tx_count ? 1 : 0;
    }
  }
}

function flattenRows(ctx) {
  const out = [];
  for (const rows of ctx.rows.values()) for (const r of rows.values()) out.push(r);
  return out;
}

/* Tipo da conta: zpub/ypub mandam; para xpub, o primeiro com histórico
   (mesma ordem de antes: bip44, bip86, bip84, bip49). */
function typeUsed(ctx, type) {
  for (const chain of [0, 1]) {
    const rows = ctx.rows.get(rowKey(type, chain));
    if (!rows) continue;
    for (const r of rows.values()) if (r.used) return true;
  }
  return false;
}

function chooseType(ctx, account) {
  if (account.versionType === 'bip84' || account.versionType === 'bip49') return account.versionType;
  for (const type of ['bip44', 'bip86', 'bip84', 'bip49']) if (typeUsed(ctx, type)) return type;
  return 'bip86';
}

function responseWallet(wallet, receive, change, extras, usedRows, warnings, detectedBalance, client) {
  const info = TYPE_INFO[wallet.account_type] || { label: wallet.account_type };
  const extraTotal = extras.reduce((s, e) => s + e.balance, 0);
  const addresses = usedRows.slice().sort((a, b) =>
    a.account_type.localeCompare(b.account_type) || a.chain - b.chain || a.idx - b.idx
  ).map(r => ({
    account_type: r.account_type,
    chain: r.chain,
    idx: r.idx,
    address: r.address,
    used: r.used,
    balance: r.balance,
    received: r.received,
    spent: r.spent,
    tx_count: r.tx_count
  }));
  return {
    version: 2,
    xpub_hash: wallet.xpub_hash,
    detected_type: wallet.account_type,
    detected_label: info.label,
    version_type: wallet.version_type,
    receive,
    change,
    balance: {
      detected: detectedBalance,
      extras: extraTotal,
      total: detectedBalance + extraTotal
    },
    extras,
    addresses,
    warnings,
    source: 'electrum (scripthash) · ' + (client ? client.name : 'servidor'),
    updated_at: wallet.updated_at
  };
}

async function handleWallet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return fail('informe a xpub');
  let account;
  try { account = parseXpub(xpub); } catch (e) { return fail(e.message); }
  const hash = await sha256Hex(xpub);

  const cfg = electrumConfig(env);
  if (!cfg) return fail('Electrum desligado (ELECTRUM_SERVERS=off); ele é a única fonte', 503);

  let client;
  try {
    client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
  } catch (e) {
    return fail('Electrum indisponível: ' + (e && e.message ? e.message : e), 502);
  }

  const ctx = {
    env, hash, client,
    rows: await loadRows(env, hash),
    chainNodes: new Map(),
    maxScan: cfg.maxScan,
    newTxs: [],
    warnings: []
  };

  try {
    await scanAll(ctx, account);
    const scans = {};
    for (const type of Object.keys(TYPE_INFO)) {
      scans[type] = { 0: branchOf(ctx, type, 0), 1: branchOf(ctx, type, 1) };
    }

    const { totals, errors } = await computeTotals(ctx);
    applyTotals(ctx, totals, errors);

    if (ctx.newTxs.length) await saveTxs(env, hash, ctx.newTxs);
    const allRows = flattenRows(ctx);
    await saveRows(env, hash, allRows);

    const type = chooseType(ctx, account);
    const detected = scans[type];
    const usedRows = allRows.filter(r => r.used);
    const totalOf = t => usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.balance, 0);

    let wallet = await getWallet(env, hash);
    if (!wallet) wallet = await insertWallet(env, hash, xpub, account, type);
    await setWallet(env, hash, type, detected[0].next, detected[1].next, totalOf(type));
    wallet = await getWallet(env, hash);

    const extras = [];
    for (const other of Object.keys(TYPE_INFO)) {
      if (other === type) continue;
      const used = usedRows.filter(r => r.account_type === other);
      if (!used.length) continue;
      extras.push({
        type: other,
        label: TYPE_INFO[other].label,
        address: scans[other][0].address,
        path: scans[other][0].path,
        balance: totalOf(other),
        txCount: used.reduce((s, r) => s + r.tx_count, 0)
      });
    }

    const warnings = [
      'Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow (get_history + get_mempool + transaction.get).',
      'O servidor Electrum vê os scripthashes consultados; o saldo sai das UTXOs e o "enviado" das saídas já gastas.'
    ];
    if (errors.size) {
      warnings.push('Transações não obtidas do servidor: ' + [...errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor gravado.');
    }
    if (ctx.rows.size) {
      const stale = allRows.filter(r => r.stale).length;
      if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');
    }

    return json(responseWallet(
      wallet,
      { address: detected[0].address, path: detected[0].path },
      { address: detected[1].address, path: detected[1].path },
      extras, usedRows, warnings, totalOf(type), client
    ));
  } finally {
    try { await client.close(); } catch (e) {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        const cfg = electrumConfig(env);
        return json({
          ok: true,
          service: 'projeto-2-electrum',
          source: 'electrum',
          electrum: cfg ? cfg.servers.map(s => s.host + ':' + s.port + (s.secure ? ' tls' : ' tcp')) : 'off',
          time: now()
        });
      }
      if (url.pathname === '/api/wallet') {
        if (request.method !== 'POST') return fail('use POST', 405);
        return await handleWallet(request, env);
      }
      if (url.pathname.startsWith('/api/')) return fail('rota não encontrada', 404);
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('not found', { status: 404 });
    } catch (e) {
      return fail(e && e.message ? e.message : String(e), 500);
    }
  }
};
