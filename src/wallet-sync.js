/* Varredura e estado de uma carteira xpub — usado pelo Worker (consulta
   avulsa) e pelo Durable Object (tempo real com assinaturas).

   Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow:
   get_history + get_mempool + transaction.get (crua), parse local, conta de
   UTXO. Endereços e transações vivem só na memória desta varredura: nada é
   gravado, nem em D1 nem no Durable Object. Ao fechar a tela, tudo se perde
   e a próxima abertura refaz a varredura do zero. */
import { chainNode, deriveChild, TYPE_INFO } from './derivation.js';
import { historiesMany, transactionsMany } from './electrum.js';
import { totalsForScripts, utxosForScripts } from './address-totals.js';
import { preparePsbt, sendLimits } from './psbt.js';
import BTC from './btc-core.js';

const DEFAULT_GAP = 50;
const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];

/* A varredura não tem teto de endereços: o fim de cada ramo é a margem de
   `gap` endereços vazios. O lote limita só quanto trabalho uma requisição
   faz por vez, para a tela mostrar progresso e continuar depois. */
const SCAN_BATCH = 200;
const HIST_CONCURRENCY = 100;
const TX_CONCURRENCY = 20;

function now() { return new Date().toISOString(); }

function rowKey(type, chain) { return type + ':' + chain; }

/* Altura da atividade mais recente de uma linha: o maior bloco em que o
   endereço aparece. O mempool (altura 0) é atividade pendente e vale como a
   mais recente de todas, à frente de qualquer bloco confirmado. */
function activityOf(row) {
  let height = 0;
  let pending = 0;
  for (const h of row.heights.values()) {
    if (h > 0) {
      if (h > height) height = h;
    } else {
      pending = 1;
    }
  }
  return { height, pending };
}

/* ---------- scanner ---------- */

export class WalletScanner {
  constructor({ env, xpub, account, client, gap }) {
    this.env = env;
    this.xpub = xpub;
    this.account = account;
    this.client = client;
    this.gap = Math.max(1, Number(gap) || DEFAULT_GAP);
    this.rows = new Map();
    this.txCache = new Map();   // txid -> hex cru, só nesta sessão
    this.chainNodes = new Map();
    this.byScript = new Map();
    this.bySh = new Map();
    this.shCache = new Map();
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

  /* Scripthashes que precisam ser observados: os usados (para detectar
     gastos) e a cauda de gap de cada ramo (para detectar novos
     recebimentos). Endereços vazios fora da cauda não são assinados. */
  scriptsForWatch() {
    const out = [];
    for (const rows of this.rows.values()) {
      const { lastUsed, maxIdx } = this.lastUsedOf(rows);
      for (const r of rows.values()) {
        if (r.used || (r.idx > lastUsed && r.idx <= maxIdx)) out.push(this.sh(r.script));
      }
    }
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
      script: BTC.bytesToHex(a.script), pub: BTC.bytesToHex(a.pub),
      kind: (TYPE_INFO[type] || {}).kind || 'p2wpkh',
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
    let entries = [];
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
    /* UTXOs = saídas nossas que nenhuma transação conhecida gastou. Só são
       usados para montar PSBT; se faltou transação, prepare() recusa. */
    this.utxos = utxosForScripts(entries, scripts);

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

  /* Caminha a varredura em um lote de no máximo SCAN_BATCH endereços novos.
     Não existe teto de carteira: cada ramo só termina quando já tem `gap`
     endereços seguidos sem uso. `requery` reconsulta o que já existe (o
     primeiro passo de uma sessão nova). */
  async scanStep(requery) {
    if (requery) await this.queryRows([...this.byScript.values()]);
    const added = [];
    let budget = SCAN_BATCH;
    let extended = true;
    while (budget > 0 && extended) {
      extended = false;
      for (const type of TYPES) {
        for (const chain of [0, 1]) {
          if (budget <= 0) break;
          const rows = this.rows.get(rowKey(type, chain));
          const { lastUsed, maxIdx } = this.lastUsedOf(rows);
          if (maxIdx - lastUsed >= this.gap) continue;
          const from = maxIdx + 1;
          const to = Math.min(lastUsed + this.gap, from + budget - 1);
          if (from > to) continue;
          const fresh = [];
          for (let i = from; i <= to; i++) {
            const row = await this.makeRow(type, chain, i);
            rows.set(i, row);
            this.byScript.set(row.script, row);
            this.bySh.set(this.sh(row.script), row);
            fresh.push(row);
          }
          budget -= fresh.length;
          await this.queryRows(fresh);
          added.push(...fresh);
          extended = true;
        }
      }
    }
    return { added, more: this.scanPending() };
  }

  /* Ainda falta derivar/consultar algum endereço para fechar a margem? */
  scanPending() {
    for (const type of TYPES) {
      for (const chain of [0, 1]) {
        const rows = this.rows.get(rowKey(type, chain));
        const { lastUsed, maxIdx } = this.lastUsedOf(rows);
        if (maxIdx - lastUsed < this.gap) return true;
      }
    }
    return false;
  }

  progress() {
    let used = 0;
    for (const r of this.byScript.values()) if (r.used) used++;
    return { scanned: this.byScript.size, used, gap: this.gap };
  }

  async fullSync() {
    let requery = true;
    let step;
    do { step = await this.scanStep(requery); requery = false; } while (step.more);
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
    let step = await this.scanStep(false);
    const added = [...step.added];
    while (step.more) {
      step = await this.scanStep(false);
      added.push(...step.added);
    }
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

  /* Próxima linha do ramo de troco (já derivada pela varredura): é o
     endereço que recebe o troco do PSBT. */
  nextChangeRow(type) {
    const rows = this.rows.get(rowKey(type, 1));
    if (!rows) return null;
    const { lastUsed } = this.lastUsedOf(rows);
    return rows.get(lastUsed + 1) || null;
  }

  /* Monta o PSBT de envio com os UTXOs desta sessão. A transação não é
     assinada nem enviada; o resultado é o arquivo para o projeto 1. */
  prepareUtxos() {
    return this.utxos
      .map(u => ({ ...u, row: this.byScript.get(u.script) }))
      .filter(u => u.row);
  }

  /* Maior valor que a carteira consegue enviar para este destino e taxa.
     Com `amountSats`, devolve também a taxa (e o troco) daquele valor; com
     `quoteRates`, o custo de cada nível para esse mesmo valor. */
  limits({ address, feeRate, amountSats, quoteRates }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const changeRow = this.nextChangeRow(this.chooseType());
    return sendLimits({
      utxos: this.prepareUtxos(),
      address,
      feeRate,
      amountSats,
      quoteRates,
      changeScript: changeRow ? BTC.hexToBytes(changeRow.script) : null
    });
  }

  async prepare({ address, amountSats, feeRate }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const type = this.chooseType();
    const changeRow = this.nextChangeRow(type);
    const utxos = this.prepareUtxos();
    const rawTxFor = async txid => {
      const cached = this.txCache.get(txid);
      if (cached) return BTC.hexToBytes(cached);
      const got = await transactionsMany(this.client, [txid], { concurrency: 1 });
      const raw = got.raw.get(txid);
      if (raw) this.txCache.set(txid, raw);
      return raw ? BTC.hexToBytes(raw) : null;
    };
    return await preparePsbt({
      account: this.account, utxos, address, amountSats, feeRate, changeRow, rawTxFor
    });
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
    const usedRows = [...this.byScript.values()].filter(r => r.used);
    const totalOf = t => usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.balance, 0);

    /* Um item por tipo de conta, na ordem de TYPES (do BIP mais alto para o
       mais baixo: a tecnologia mais recente primeiro), cada um com o saldo do
       tipo e o próximo endereço livre do ramo de recebimento. O tipo
       detectado vem marcado, sem mudar de posição. A tela exibe os quatro no
       bloco receber; o saldo total é a soma das linhas. */
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

    const detected = totalOf(type);
    const extraTotal = types.reduce((s, t) => t.type === type ? s : s + t.balance, 0);

    /* Extrato na ordem do uso mais recente: a altura do bloco é a data que a
       varredura já tem, sem pedir cabeçalho ao servidor, e o mempool vem
       antes de tudo. O índice (maior primeiro) desempata o mesmo bloco e,
       por último, o tipo, para a ordem não mudar entre consultas iguais. */
    const addresses = usedRows
      .map(r => ({ r, act: activityOf(r) }))
      .sort((a, b) =>
        (b.act.pending - a.act.pending) ||
        (b.act.height - a.act.height) ||
        (b.r.idx - a.r.idx) ||
        a.r.account_type.localeCompare(b.r.account_type) ||
        (a.r.chain - b.r.chain)
      )
      .map(({ r, act }) => ({
        account_type: r.account_type,
        chain: r.chain,
        idx: r.idx,
        address: r.address,
        used: r.used,
        balance: r.balance,
        received: r.received,
        spent: r.spent,
        tx_count: r.tx_count,
        last_height: act.height,
        pending: act.pending === 1
      }));

    const warnings = [];
    if (this.errors) {
      warnings.push('Transações não obtidas do servidor: ' + [...this.errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor calculado nesta sessão.');
    }
    const stale = [...this.byScript.values()].filter(r => r.stale).length;
    if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');

    return {
      detected_type: type,
      balance: { detected, total: detected + extraTotal },
      types,
      addresses,
      warnings,
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
