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
import { preparePsbt, sendLimits, prepareCpfpPsbt, feeRateKvb, feeSats, DUST_SATS } from './psbt.js';
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
function hex(bytes) { return BTC.bytesToHex(bytes); }

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
    this.infoCache = new Map(); // txid -> resumo da transação, invalidado por aviso
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
      confirmed: 0, pendingIn: 0, pendingOut: 0, thirdIn: 0,
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
      /* transação nova muda o índice de saídas e a conta das vizinhas:
         zera o resumo em cache para o payload recalcular tudo uma vez */
      if (fetched.raw.size) this.infoCache.clear();

      for (const [txid, raw] of [...cached, ...fetched.raw]) {
        try {
          const tx = BTC.readTx(BTC.hexToBytes(raw));
          entries.push({
            txid, height: heights.get(txid) || 0, outputs: tx.outputs, inputs: tx.inputs,
            vsize: BTC.vsizeOf(tx)
          });
        } catch (e) {
          errors.set(txid, 'transação ilegível');
        }
      }
      /* confirmação de uma transação já conhecida muda a altura (e o
         pendente) sem baixar nada novo: o resumo em cache tem de cair */
      for (const tx of entries) {
        const info = this.infoCache.get(tx.txid);
        if (info && Number(info.height) !== (Number(tx.height) || 0)) this.infoCache.delete(tx.txid);
      }
      totals = totalsForScripts(entries, scripts);
    }
    /* UTXOs = saídas nossas que nenhuma transação conhecida gastou. Só são
       usados para montar PSBT; se faltou transação, prepare() recusa. */
    this.utxos = utxosForScripts(entries, scripts);
    /* Índices em memória para o extrato por transação e para o CPFP. O mapa
       de saídas cobre TODAS as saídas conhecidas (inclusive as externas),
       porque o valor de uma entrada nossa vem da transação anterior. */
    this.entries = entries;
    this.entryByTxid = new Map(entries.map(tx => [tx.txid, tx]));
    this.outpointIndex = new Map();
    for (const tx of entries) {
      for (let vout = 0; vout < tx.outputs.length; vout++) {
        const out = tx.outputs[vout];
        this.outpointIndex.set(tx.txid + ':' + vout, {
          txid: tx.txid, vout, value: Number(out.value) || 0,
          script: hex(out.script), height: tx.height || 0
        });
      }
    }
    this.utxoByKey = new Map(this.utxos.map(u => [u.txid + ':' + u.vout, u]));

    /* Disponível = saída confirmada não gasta + troco de transação nossa
       ainda pendente. O troco é uma saída da mesma transação do envio e some
       do saldo até confirmar, então ele entra aqui: pode ser gasto antes
       (gasto encadeado). Pagamento de terceiro no mempool (height 0, own
       false) não entra: fica como pendente de entrada e só conta depois da
       confirmação. É a mesma base que o envio usa. */
    const availableByScript = new Map();
    const thirdInByScript = new Map();
    for (const u of this.utxos) {
      if (u.height > 0 || u.own) {
        availableByScript.set(u.script, (availableByScript.get(u.script) || 0) + u.value);
      } else {
        thirdInByScript.set(u.script, (thirdInByScript.get(u.script) || 0) + u.value);
      }
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
      /* `received` e `spent` são o confirmado; `balance` é o disponível
         (confirmado não gasto + troco nosso ainda pendente). O mempool fica
         em pendingIn/pendingOut (brutos, para a tela do extrato) e
         thirdIn (entrada de terceiro que ainda não conta). */
      r.received = t ? t.receivedConfirmed : 0;
      r.spent = t ? t.spentConfirmed : 0;
      r.balance = availableByScript.get(r.script) || 0;
      r.tx_count = t ? t.txCount : 0;
      r.confirmed = t ? t.confirmed : 0;
      r.pendingIn = t ? t.unconfirmedIn : 0;
      r.pendingOut = t ? t.unconfirmedOut : 0;
      r.thirdIn = thirdInByScript.get(r.script) || 0;
      r.used = r.tx_count ? 1 : 0;
      r.stale = false;
    }

    if (errors.size) this.errors = errors;
    else this.errors = null;
    return totals;
  }

  /* Resumo de uma transação para o extrato por txid. `own_inputs` e
     `own_outputs` guardam a linha derivada (com pub/chave) só para o CPFP;
     `publicTransaction` remove o que não precisa ir ao navegador. O
     resultado fica em `infoCache` (por txid) até um aviso do Electrum tocar
     um scripthash dessa transação: sem isso, cada payload refazia
     `addressFromScript` para todas as saídas de todas as transações. */
  infoOf(entry) {
    let info = this.infoCache.get(entry.txid);
    if (!info) {
      info = this.transactionInfo(entry);
      this.infoCache.set(entry.txid, info);
    }
    return info;
  }

  transactionInfo(entry) {
    const addressOf = script => {
      try { return BTC.addressFromScript(script) || ''; } catch (e) { return ''; }
    };
    const ownInputs = [];
    let allPrevKnown = true;
    for (const input of entry.inputs) {
      const prev = this.outpointIndex.get(input.txid + ':' + input.vout);
      if (!prev) { allPrevKnown = false; continue; }
      const row = this.byScript.get(prev.script);
      if (row) ownInputs.push({
        txid: input.txid, vout: input.vout, value: prev.value,
        script: prev.script, row
      });
    }
    const outputs = entry.outputs.map((out, vout) => {
      const script = hex(out.script);
      const row = this.byScript.get(script);
      const key = entry.txid + ':' + vout;
      const value = Number(out.value) || 0;
      return {
        txid: entry.txid, vout, value, script, row,
        address: row ? row.address : addressOf(out.script),
        own: !!row,
        spendable: this.utxoByKey.has(key)
      };
    });
    const ownOutputs = outputs.filter(o => o.own);
    const externalOutputs = outputs.filter(o => !o.own);
    const allInputsOwn = allPrevKnown && ownInputs.length === entry.inputs.length;
    const totalIn = allInputsOwn
      ? ownInputs.reduce((sum, i) => sum + i.value, 0)
      : null;
    const totalOut = outputs.reduce((sum, o) => sum + o.value, 0);
    const fee = totalIn == null ? null : totalIn - totalOut;
    const received = ownOutputs.reduce((sum, o) => sum + o.value, 0);
    const sent = externalOutputs.reduce((sum, o) => sum + o.value, 0);
    const direction = ownInputs.length
      ? (externalOutputs.length ? 'out' : 'self')
      : 'in';

    const addresses = [];
    const seen = new Set();
    const addAddress = (row, role) => {
      if (!row || seen.has(row.address)) return;
      seen.add(row.address);
      addresses.push({
        address: row.address, role, chain: row.chain, idx: row.idx,
        account_type: row.account_type, path: row.path
      });
    };
    ownInputs.forEach(i => addAddress(i.row, 'entrada'));
    ownOutputs.forEach(o => addAddress(o.row, o.row.chain === 1 ? 'troco' : 'recebimento'));

    const candidates = ownOutputs
      .filter(o => o.spendable && o.value >= DUST_SATS)
      .sort((a, b) => b.value - a.value);
    const cpfpOutput = candidates[0] || null;

    return {
      txid: entry.txid,
      height: Number(entry.height) || 0,
      pending: !entry.height,
      vsize: Number(entry.vsize) || 0,
      direction,
      received_sats: received,
      sent_sats: sent,
      fee_sats: fee,
      total_in_sats: totalIn,
      total_out_sats: totalOut,
      input_count: entry.inputs.length,
      output_count: entry.outputs.length,
      addresses,
      own_inputs: ownInputs,
      own_outputs: ownOutputs,
      all_inputs_own: allInputsOwn,
      cpfp: {
        eligible: !entry.height && ownInputs.length > 0 && allInputsOwn &&
          fee != null && fee >= 0 && !!cpfpOutput,
        output: cpfpOutput ? {
          txid: cpfpOutput.txid, vout: cpfpOutput.vout,
          outpoint: cpfpOutput.txid + ':' + cpfpOutput.vout,
          value: cpfpOutput.value, address: cpfpOutput.address,
          path: cpfpOutput.row.path, chain: cpfpOutput.row.chain,
          idx: cpfpOutput.row.idx
        } : null
      }
    };
  }

  /* O que vai no payload: sem as linhas derivadas nem os Map internos. */
  publicTransaction(t) {
    return {
      txid: t.txid,
      height: t.height,
      pending: t.pending,
      vsize: t.vsize,
      direction: t.direction,
      received_sats: t.received_sats,
      sent_sats: t.sent_sats,
      fee_sats: t.fee_sats,
      total_in_sats: t.total_in_sats,
      total_out_sats: t.total_out_sats,
      input_count: t.input_count,
      output_count: t.output_count,
      addresses: t.addresses,
      cpfp: t.cpfp
    };
  }

  /* Soma taxa e vsize do pai e de todos os ancestrais ainda no mempool. Se
     algum deles não for inteiramente desta carteira, a taxa não pode ser
     conferida e o CPFP é recusado (não há como garantir o pacote). */
  cpfpPackage(entry) {
    const seen = new Set();
    const queue = [entry];
    let fee = 0;
    let vsize = 0;
    let count = 0;
    while (queue.length) {
      const tx = queue.pop();
      if (seen.has(tx.txid)) continue;
      seen.add(tx.txid);
      const info = this.infoOf(tx);
      if (!info.all_inputs_own || info.fee_sats == null || info.fee_sats < 0) {
        return { fee_sats: null, vsize: null, count: null };
      }
      fee += info.fee_sats;
      vsize += Number(tx.vsize) || 0;
      count++;
      for (const input of tx.inputs) {
        const prev = this.entryByTxid.get(input.txid);
        if (prev && !prev.height) queue.push(prev);
      }
    }
    return { fee_sats: fee, vsize, count };
  }

  /* CPFP: monta o PSBT da filha que gasta a maior saída própria ainda não
     gasta do pai e devolve o resto para o próximo endereço de troco. A taxa
     do filho é a diferença entre a taxa-alvo do pacote e o que o pai (e os
     ancestrais pendentes) já paga. */
  async prepareCpfp({ txid, feeRate }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const entry = this.entryByTxid && this.entryByTxid.get(String(txid || '').toLowerCase());
    if (!entry) throw new Error('transação não encontrada nesta carteira');
    if (entry.height > 0) throw new Error('a transação já foi confirmada; CPFP só vale para pendente');
    const info = this.infoOf(entry);
    if (!info.own_inputs.length) throw new Error('a transação não é um envio desta carteira');
    if (!info.all_inputs_own) throw new Error('nem todas as entradas da transação são desta carteira; não é possível assinar a filha');
    if (info.fee_sats == null || info.fee_sats < 0) throw new Error('taxa da transação pai indisponível');
    const spend = info.own_outputs
      .filter(o => o.spendable && o.value >= DUST_SATS)
      .sort((a, b) => b.value - a.value)[0];
    if (!spend) throw new Error('não há saída própria ainda não gasta para acelerar');
    const pkg = this.cpfpPackage(entry);
    if (pkg.fee_sats == null || !(pkg.vsize > 0)) {
      throw new Error('há ancestral pendente com taxa que não é desta carteira; não é possível calcular o pacote com segurança');
    }
    const rateKvb = feeRateKvb(feeRate);
    const changeRow = this.nextChangeRow(this.chooseType());
    if (!changeRow) throw new Error('endereço de troco indisponível');
    const childVsize = BTC.estimateVsize([spend.row.kind], [BTC.hexToBytes(changeRow.script)]);
    const targetFee = feeSats(rateKvb, pkg.vsize + childVsize);
    const childFee = targetFee - pkg.fee_sats;
    if (!(childFee > 0)) {
      throw new Error('a transação já paga a taxa alvo; não há o que acelerar');
    }
    const rawTxFor = async id => {
      const cached = this.txCache.get(id);
      if (cached) return BTC.hexToBytes(cached);
      const got = await transactionsMany(this.client, [id], { concurrency: 1 });
      const raw = got.raw.get(id);
      if (raw) this.txCache.set(id, raw);
      return raw ? BTC.hexToBytes(raw) : null;
    };
    const parent = {
      txid: entry.txid,
      vsize: Number(entry.vsize) || 0,
      fee_sats: info.fee_sats,
      fee_rate: entry.vsize ? info.fee_sats / entry.vsize : 0
    };
    return await prepareCpfpPsbt({
      account: this.account, spend, changeRow, childFee, feeRate, rawTxFor,
      parent, packageBefore: pkg
    });
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
          const target = lastUsed + this.gap;
          const to = Math.min(target, from + budget - 1);
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
          /* endereço novo pode tornar interna uma saída antes externa */
          if (fresh.length) this.infoCache.clear();
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
    /* aviso novo pode mudar o resumo dessas transações */
    for (const r of rows) for (const id of r.txids) this.infoCache.delete(id);
    await this.queryRows(rows);
    for (const r of rows) for (const id of r.txids) this.infoCache.delete(id);
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
     assinada nem enviada; o resultado é o arquivo para o Cofre BTC. */
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
      account: this.account, utxos, address, amountSats, feeRate, changeRow, rawTxFor,
      ownScripts: this.byScript
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
       mais baixo: a tecnologia mais recente primeiro), cada um com o saldo
       disponível do tipo e o próximo endereço livre do ramo de recebimento.
       O tipo detectado vem marcado, sem mudar de posição. A tela exibe os
       quatro no bloco receber; o saldo total é a soma das linhas. */
    const types = TYPES.map(t => {
      const br = this.branch(t, 0);
      const ch = this.branch(t, 1);
      return {
        type: t,
        label: (TYPE_INFO[t] || { label: t }).label,
        address: br.address,
        path: br.path,
        change_address: ch.address,
        change_path: ch.path,
        balance: totalOf(t),
        tx_count: usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.tx_count, 0),
        detected: t === type
      };
    });

    const detected = totalOf(type);
    const extraTotal = types.reduce((s, t) => t.type === type ? s : s + t.balance, 0);
    const availableTotal = detected + extraTotal;
    /* O que a linha "pendente" da carteira mostra é só o que ainda não está
       no disponível: entrada de terceiro que não conta (pending_in) e o que
       já saiu de fato numa transação pendente, isto é, a diferença para o
       saldo confirmado descontado o troco que volta (pending_out). O troco
       pendente já está em `total`, então não aparece como entrada. */
    const confirmedTotal = usedRows.reduce((s, r) => s + r.confirmed, 0);
    const thirdIn = usedRows.reduce((s, r) => s + r.thirdIn, 0);
    const netOut = Math.max(0, confirmedTotal - availableTotal);

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
        pending: act.pending === 1,
        pending_in: r.pendingIn,
        pending_out: r.pendingOut
      }));

    /* Extrato agrupado por txid: uma linha por transação, do mempool para o
       bloco mais recente. A ordem é estável (txid desempata) para a lista não
       dançar entre duas consultas iguais. */
    const transactions = (this.entries || [])
      .map(e => this.publicTransaction(this.infoOf(e)))
      .sort((a, b) =>
        (Number(b.pending) - Number(a.pending)) ||
        (b.height - a.height) ||
        (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0)
      );

    const warnings = [];
    if (this.errors) {
      warnings.push('Transações não obtidas do servidor: ' + [...this.errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor calculado nesta sessão.');
    }
    const stale = [...this.byScript.values()].filter(r => r.stale).length;
    if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');
    return {
      detected_type: type,
      balance: {
        detected,
        total: availableTotal,
        pending_in: thirdIn,
        pending_out: netOut
      },
      types,
      addresses,
      transactions,
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
