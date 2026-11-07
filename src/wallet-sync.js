/* Varredura e estado de uma carteira xpub — usado pelo Worker (consulta
   avulsa) e pelo Durable Object (tempo real com assinaturas).

   Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow:
   get_history + get_mempool + transaction.get (crua), parse local, conta de
   UTXO. Endereços e transações vivem só na memória desta varredura: nada é
   gravado, nem em D1 nem no Durable Object. Ao fechar a tela, tudo se perde
   e a próxima abertura refaz a varredura do zero. */
import { chainNode, deriveChild, TYPE_INFO } from './derivation.js';
import { historiesMany, transactionsMany } from './electrum.js';
import { totalsForScripts } from './address-totals.js';
import BTC from './btc-core.js';

export const DEFAULT_GAP = 20;
export const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];

const HIST_CONCURRENCY = 100;
const TX_CONCURRENCY = 20;

export function now() { return new Date().toISOString(); }

export function rowKey(type, chain) { return type + ':' + chain; }

/* ---------- scanner ---------- */

export class WalletScanner {
  constructor({ env, xpub, account, client, maxScan, gap }) {
    this.env = env;
    this.xpub = xpub;
    this.account = account;
    this.client = client;
    this.gap = Math.max(1, Number(gap) || DEFAULT_GAP);
    this.maxScan = Math.max(this.gap, Number(maxScan) || 400);
    this.rows = new Map();
    this.txCache = new Map();   // txid -> hex cru, só nesta sessão
    this.chainNodes = new Map();
    this.byScript = new Map();
    this.bySh = new Map();
    this.shCache = new Map();
    this.warnings = [];
  }

  async init() {
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
      heights: new Map(), txids: [], stale: false
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

  /* Consulta de novo o que já está na memória (quando `requery`) e estende
     cada ramo até `gap` endereços sem uso, com as extensões de todos os
     ramos numa rodada. Devolve as linhas novas (para o DO assinar). */
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

  /* Conta de UTXO a partir das transações cruas (cache em memória). */
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
      const cached = new Map();
      for (const txid of heights.keys()) {
        const raw = this.txCache.get(txid);
        if (raw) cached.set(txid, raw);
      }
      const missing = [...heights.keys()].filter(t => !cached.has(t));
      const fetched = missing.length
        ? await transactionsMany(this.client, missing, { concurrency: TX_CONCURRENCY })
        : { raw: new Map(), errors: new Map() };
      for (const [txid, raw] of fetched.raw) this.txCache.set(txid, raw);
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
        // sem a transação não fecha a conta: mantém o último valor calculado
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

    /* Um item por tipo de conta, na ordem de TYPES (do BIP mais alto para o
       mais baixo: a tecnologia mais recente primeiro), cada um com o saldo do
       tipo e o próximo endereço livre do ramo de recebimento. O tipo
       detectado vem marcado, sem mudar de posição. A tela esconde os tipos
       sem saldo; o saldo total é a soma das linhas. */
    const types = TYPES.map(t => {
      const br = this.branch(t, 0);
      return {
        type: t,
        label: (TYPE_INFO[t] || { label: t }).label,
        address: br.address,
        path: br.path,
        balance: totalOf(t),
        tx_count: usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.tx_count, 0),
        detected: t === type
      };
    });

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

    const warnings = [];
    if (this.errors) {
      warnings.push('Transações não obtidas do servidor: ' + [...this.errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor calculado nesta sessão.');
    }
    const stale = [...this.byScript.values()].filter(r => r.stale).length;
    if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');
    for (const w of this.warnings) if (!warnings.includes(w)) warnings.push(w);

    return {
      version: 4,
      detected_type: type,
      detected_label: info.label,
      version_type: this.account.versionType,
      receive: { address: chains[0].address, path: chains[0].path },
      change: { address: chains[1].address, path: chains[1].path },
      balance: { detected, extras: extraTotal, total: detected + extraTotal },
      types,
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
      updated_at: now()
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
