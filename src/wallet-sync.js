/* Varredura e estado de uma carteira xpub — usado pelo Worker (consulta
   avulsa) e pelo Durable Object (tempo real com assinaturas).

   Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow:
   get_history + get_mempool + transaction.get (crua), parse local, conta de
   UTXO. O D1 guarda endereços derivados (com scriptPubKey) e as transações
   cruas; nada de chave privada. */
import { chainNode, deriveChild, TYPE_INFO } from './derivation.js';
import { historiesMany, transactionsMany } from './electrum.js';
import { totalsForScripts } from './address-totals.js';
import BTC from './btc-core.js';

export const DEFAULT_GAP = 20;
export const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];

const TX_CACHE_CHUNK = 80;
const HIST_CONCURRENCY = 100;
const TX_CONCURRENCY = 20;

export function now() { return new Date().toISOString(); }

/* ---------- D1 ---------- */

export async function getWallet(env, hash) {
  return await env.DB.prepare('SELECT * FROM wallets WHERE xpub_hash = ?').bind(hash).first();
}
export async function insertWallet(env, hash, xpub, account, type) {
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

export function rowKey(type, chain) { return type + ':' + chain; }

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

async function loadCachedTx(env, hash, txids) {
  const out = new Map();
  for (let i = 0; i < txids.length; i += TX_CACHE_CHUNK) {
    const chunk = txids.slice(i, i + TX_CACHE_CHUNK);
    const sql = 'SELECT txid, raw FROM transactions WHERE xpub_hash = ? AND txid IN (' +
      chunk.map(() => '?').join(',') + ')';
    const res = await env.DB.prepare(sql).bind(hash, ...chunk).all();
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

/* ---------- scanner ---------- */

export class WalletScanner {
  constructor({ env, xpub, account, hash, client, maxScan, gap }) {
    this.env = env;
    this.xpub = xpub;
    this.account = account;
    this.hash = hash;
    this.client = client;
    this.gap = Math.max(1, Number(gap) || DEFAULT_GAP);
    this.maxScan = Math.max(this.gap, Number(maxScan) || 400);
    this.rows = new Map();
    this.chainNodes = new Map();
    this.byScript = new Map();
    this.bySh = new Map();
    this.shCache = new Map();
    this.newTxs = [];
    this.warnings = [];
    this.wallet = null;
  }

  async init() {
    this.rows = await loadRows(this.env, this.hash);
    for (const type of TYPES) for (const chain of [0, 1]) {
      if (!this.rows.has(rowKey(type, chain))) this.rows.set(rowKey(type, chain), new Map());
    }
    this.reindex();
    return this;
  }

  reindex() {
    this.byScript = new Map();
    this.bySh = new Map();
    for (const rows of this.rows.values()) {
      for (const r of rows.values()) {
        if (!r.script) continue;
        this.byScript.set(r.script, r);
        this.bySh.set(this.sh(r.script), r);
      }
    }
  }

  sh(script) {
    let sh = this.shCache.get(script);
    if (!sh) {
      sh = shOf(script);
      this.shCache.set(script, sh);
    }
    return sh;
  }

  /* Todos os scripthashes já consultados (usados + cauda de gap). */
  scripts() {
    const out = [];
    for (const script of this.byScript.keys()) out.push(this.sh(script));
    return out;
  }

  async chainNodeFor(chain) {
    if (!this.chainNodes.has(chain)) this.chainNodes.set(chain, await chainNode(this.account, chain));
    return this.chainNodes.get(chain);
  }

  async makeRow(type, chain, idx) {
    const cn = await this.chainNodeFor(chain);
    const a = await deriveChild(type, cn, chain, idx);
    return {
      account_type: type, chain, idx, address: a.address, path: a.path,
      script: BTC.bytesToHex(a.script),
      used: 0, balance: 0, received: 0, spent: 0, tx_count: 0,
      heights: new Map(), txids: [], stale: false, _orig: null
    };
  }

  async queryRows(rows) {
    if (!rows.length) return;
    const hist = await historiesMany(this.client, rows.map(r => BTC.hexToBytes(r.script)),
      { concurrency: HIST_CONCURRENCY });
    rows.forEach((r, i) => {
      const h = hist[i];
      r.heights = h.heights;
      r.txids = h.txids;
      r.tx_count = h.txCount;
      r.used = h.txCount > 0 ? 1 : 0;
    });
  }

  lastUsedOf(rows) {
    let lastUsed = -1;
    let maxIdx = -1;
    for (const r of rows.values()) {
      if (r.idx > maxIdx) maxIdx = r.idx;
      if (r.used && r.idx > lastUsed) lastUsed = r.idx;
    }
    return { lastUsed, maxIdx };
  }

  /* Consulta o que já está no D1 (quando `requery`) e estende cada ramo até
     `gap` endereços sem uso, com as extensões de todos os ramos numa rodada.
     Devolve as linhas novas (para o DO assinar). */
  async ensureGap(requery) {
    if (requery) await this.queryRows([...this.byScript.values()]);
    const added = [];
    for (let round = 0; round < 64; round++) {
      const fresh = [];
      for (const type of TYPES) {
        for (const chain of [0, 1]) {
          const rows = this.rows.get(rowKey(type, chain));
          const { lastUsed, maxIdx } = this.lastUsedOf(rows);
          if (maxIdx - lastUsed >= this.gap) continue;
          const from = maxIdx + 1;
          const to = Math.min(lastUsed + this.gap, this.maxScan - 1);
          if (from > to) {
            const msg = 'ramo ' + type + '/' + chain + ' parou no teto de ' +
              this.maxScan + ' endereços (último usado: ' + lastUsed + ')';
            if (!this.warnings.includes(msg)) this.warnings.push(msg);
            continue;
          }
          for (let i = from; i <= to; i++) {
            const row = await this.makeRow(type, chain, i);
            rows.set(i, row);
            this.byScript.set(row.script, row);
            this.bySh.set(this.sh(row.script), row);
            fresh.push(row);
          }
        }
      }
      if (!fresh.length) break;
      await this.queryRows(fresh);
      added.push(...fresh);
    }
    return added;
  }

  /* Conta de UTXO a partir das transações cruas (cache no D1). */
  async recompute() {
    const heights = new Map();
    const scripts = new Set();
    for (const r of this.byScript.values()) {
      if (!r.txids.length) continue;
      scripts.add(r.script);
      for (const [txid, h] of r.heights) if (!heights.has(txid)) heights.set(txid, h);
    }

    let totals = new Map();
    const errors = new Map();
    if (heights.size) {
      const cached = await loadCachedTx(this.env, this.hash, [...heights.keys()]);
      const missing = [...heights.keys()].filter(t => !cached.has(t));
      const fetched = missing.length
        ? await transactionsMany(this.client, missing, { concurrency: TX_CONCURRENCY })
        : { raw: new Map(), errors: new Map() };
      for (const [txid, raw] of fetched.raw) this.newTxs.push({ txid, raw });
      for (const [txid, msg] of fetched.errors) errors.set(txid, msg);

      const entries = [];
      for (const [txid, raw] of [...cached, ...fetched.raw]) {
        try {
          const tx = BTC.readTx(BTC.hexToBytes(raw));
          entries.push({ txid, height: heights.get(txid) || 0, outputs: tx.outputs, inputs: tx.inputs });
        } catch (e) {
          errors.set(txid, 'transação ilegível');
        }
      }
      totals = totalsForScripts(entries, scripts);
    }

    for (const r of this.byScript.values()) {
      if (r.txids.some(t => errors.has(t))) {
        // sem a transação não fecha a conta: mantém o último valor gravado
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

    if (this.newTxs.length) {
      await saveTxs(this.env, this.hash, this.newTxs);
      this.newTxs = [];
    }
    await saveRows(this.env, this.hash, [...this.byScript.values()]);
    if (errors.size) this.errors = errors;
    else this.errors = null;
    return totals;
  }

  async fullSync() {
    await this.ensureGap(true);
    await this.recompute();
    return this.payload();
  }

  /* Atualização incremental: só os scripthashes avisados pelo servidor. */
  async refreshServices(scriptsHash) {
    const rows = [];
    for (const sh of scriptsHash) {
      const r = this.bySh.get(sh);
      if (r) rows.push(r);
    }
    if (!rows.length) return { payload: await this.payload(), added: [] };
    await this.queryRows(rows);
    const added = await this.ensureGap(false);
    await this.recompute();
    return { payload: await this.payload(), added };
  }

  branch(type, chain) {
    const rows = this.rows.get(rowKey(type, chain));
    const { lastUsed } = this.lastUsedOf(rows);
    const next = lastUsed + 1;
    const row = rows.get(next);
    return { chain, next, lastUsed, address: row ? row.address : null, path: row ? row.path : null };
  }

  typeUsed(type) {
    for (const r of this.byScript.values()) if (r.used && r.account_type === type) return true;
    return false;
  }

  chooseType() {
    const hint = this.account.versionType;
    if (hint === 'bip84' || hint === 'bip49') return hint;
    for (const type of ['bip44', 'bip86', 'bip84', 'bip49']) if (this.typeUsed(type)) return type;
    return 'bip86';
  }

  async payload() {
    const type = this.chooseType();
    const chains = { 0: this.branch(type, 0), 1: this.branch(type, 1) };
    const usedRows = [...this.byScript.values()].filter(r => r.used);
    const totalOf = t => usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.balance, 0);

    let wallet = await getWallet(this.env, this.hash);
    if (!wallet) wallet = await insertWallet(this.env, this.hash, this.xpub, this.account, type);
    const changed = wallet.account_type !== type ||
      Number(wallet.next_receive) !== chains[0].next ||
      Number(wallet.next_change) !== chains[1].next ||
      Number(wallet.balance) !== totalOf(type);
    if (changed) {
      await setWallet(this.env, this.hash, type, chains[0].next, chains[1].next, totalOf(type));
      wallet = await getWallet(this.env, this.hash);
    }
    this.wallet = wallet;

    const extras = [];
    for (const other of TYPES) {
      if (other === type) continue;
      const used = usedRows.filter(r => r.account_type === other);
      if (!used.length) continue;
      const branch = this.branch(other, 0);
      extras.push({
        type: other,
        label: TYPE_INFO[other].label,
        address: branch.address,
        path: branch.path,
        balance: totalOf(other),
        txCount: used.reduce((s, r) => s + r.tx_count, 0)
      });
    }

    const info = TYPE_INFO[type] || { label: type };
    const extraTotal = extras.reduce((s, e) => s + e.balance, 0);
    const detected = totalOf(type);

    const warnings = [
      'Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow (get_history + get_mempool + transaction.get).',
      'O servidor Electrum vê os scripthashes consultados; o saldo sai das UTXOs e o "enviado" das saídas já gastas.'
    ];
    if (this.errors) {
      warnings.push('Transações não obtidas do servidor: ' + [...this.errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor gravado.');
    }
    const stale = [...this.byScript.values()].filter(r => r.stale).length;
    if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');
    for (const w of this.warnings) if (!warnings.includes(w)) warnings.push(w);

    return {
      version: 3,
      xpub_hash: this.hash,
      detected_type: type,
      detected_label: info.label,
      version_type: this.account.versionType,
      receive: { address: chains[0].address, path: chains[0].path },
      change: { address: chains[1].address, path: chains[1].path },
      balance: { detected, extras: extraTotal, total: detected + extraTotal },
      extras,
      addresses: usedRows.slice().sort((a, b) =>
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
      })),
      warnings,
      source: 'electrum (scripthash) · ' + (this.client ? this.client.name : 'servidor'),
      updated_at: wallet.updated_at
    };
  }
}

function shOf(script) {
  const bytes = BTC.hexToBytes(script);
  const h = BTC.sha256(bytes);
  let out = '';
  for (let i = h.length - 1; i >= 0; i--) out += h[i].toString(16).padStart(2, '0');
  return out;
}
