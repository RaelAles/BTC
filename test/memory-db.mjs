/* D1 em memória para os testes e para o servidor de desenvolvimento.
   Cobre só o SQL que o Worker usa (wallets, addresses, transactions). */
export class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { this.args = args; return this; }
  async run() { return this.db.run(this.sql, this.args); }
  async first() { return this.db.first(this.sql, this.args); }
  async all() { return { results: this.db.all(this.sql, this.args) }; }
}

export class MemoryDB {
  constructor() {
    this.wallets = [];
    this.addresses = [];
    this.transactions = new Map(); // hash|txid -> raw
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); }

  run(sql, args) {
    if (sql.startsWith('INSERT INTO wallets')) {
      const [hash, xpub, version, type, created, updated] = args;
      this.wallets.push({
        xpub_hash: hash, xpub, version_type: version, account_type: type,
        next_receive: 0, next_change: 0, balance: 0, created_at: created, updated_at: updated
      });
      return { success: true };
    }
    if (sql.startsWith('UPDATE wallets')) {
      const [type, nr, nc, bal, updated, hash] = args;
      const w = this.wallets.find(x => x.xpub_hash === hash);
      if (w) Object.assign(w, { account_type: type, next_receive: nr, next_change: nc, balance: bal, updated_at: updated });
      return { success: true };
    }
    if (sql.startsWith('INSERT INTO addresses')) {
      const [hash, type, chain, idx, address, script, used, balance, received, spent, tx, updated] = args;
      const row = {
        xpub_hash: hash, account_type: type, chain, idx, address, script,
        used, balance, received, spent, tx_count: tx, updated_at: updated
      };
      const old = this.addresses.find(a =>
        a.xpub_hash === hash && a.account_type === type && a.chain === chain && a.idx === idx);
      if (old) Object.assign(old, row); else this.addresses.push(row);
      return { success: true };
    }
    if (sql.startsWith('INSERT OR IGNORE INTO transactions')) {
      const [hash, txid, raw] = args;
      const key = hash + '|' + txid;
      if (!this.transactions.has(key)) this.transactions.set(key, raw);
      return { success: true };
    }
    throw new Error('SQL não suportado: ' + sql.slice(0, 60));
  }

  first(sql, args) {
    if (sql.startsWith('SELECT * FROM wallets')) return this.wallets.find(w => w.xpub_hash === args[0]) || null;
    throw new Error('SQL não suportado: ' + sql.slice(0, 60));
  }

  all(sql, args) {
    if (sql.startsWith('SELECT * FROM addresses')) {
      return this.addresses.filter(a => a.xpub_hash === args[0]);
    }
    if (sql.startsWith('SELECT txid, raw FROM transactions')) {
      const [hash, ...txids] = args;
      const out = [];
      for (const txid of txids) {
        const raw = this.transactions.get(hash + '|' + txid);
        if (raw) out.push({ txid, raw });
      }
      return out;
    }
    throw new Error('SQL não suportado: ' + sql.slice(0, 60));
  }

  txCount() { return this.transactions.size; }
}
