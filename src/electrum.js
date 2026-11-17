/* Cliente mínimo do protocolo Electrum (JSON-RPC 1.4) sobre TCP/TLS.
   Usa `connect()` de `cloudflare:sockets`; o transporte é injetável
   (setConnectOverride) para os testes rodarem em Node.

   Sem chave privada: a consulta é por scripthash = sha256(scriptPubKey)
   com os bytes invertidos. Métodos usados:
     server.version
     server.ping
     blockchain.scripthash.get_history
     blockchain.scripthash.get_mempool
     blockchain.scripthash.subscribe
     blockchain.estimatefee
     blockchain.transaction.get
     blockchain.transaction.broadcast (só na rota /api/broadcast, com o PSBT
       assinado já conferido contra a carteira)
   Uma conexão responde a muitas consultas (pipelining), então não há o
   limite de subrequests do fetch. */
import BTC from './btc-core.js';

/* Verificados em 2026-11: TLS 50002 e texto puro 50001 respondem
   `server.version` e `get_balance`. O TLS é o padrão; o texto puro só
   como último recurso (o caminho da rede vê os endereços consultados). */
export const DEFAULT_SERVERS = [
  { host: 'electrum.blockstream.info', port: 50002, secure: true },
  { host: 'electrum.blockstream.info', port: 50001, secure: false }
];

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_CONNECT_TIMEOUT = 6000;
const DEFAULT_CONCURRENCY = 20;
const MAX_BUFFER = 8 * 1024 * 1024;

export function scripthash(script) {
  if (!script || typeof script.length !== 'number' || !script.length) {
    throw new Error('script inválido para scripthash');
  }
  const bytes = script instanceof Uint8Array ? script : new Uint8Array(script);
  const h = BTC.sha256(bytes);
  let out = '';
  for (let i = h.length - 1; i >= 0; i--) out += h[i].toString(16).padStart(2, '0');
  return out;
}

/* "host:porta[:tls|:tcp],..." — a porta 50001 assume tcp, o resto tls. */
export function parseServerList(text) {
  const out = [];
  for (const raw of String(text || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const parts = item.split(':');
    const host = parts[0];
    const port = Number(parts[1]);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('servidor Electrum inválido: ' + item);
    }
    const mode = String(parts[2] || (port === 50001 ? 'tcp' : 'tls')).toLowerCase();
    if (mode !== 'tls' && mode !== 'tcp') {
      throw new Error('transporte inválido em ' + item + ' (use tls ou tcp)');
    }
    out.push({ host, port, secure: mode === 'tls' });
  }
  if (!out.length) throw new Error('lista de servidores Electrum vazia');
  return out;
}

let connectOverride = null;
/* Seam de teste: em Node não existe `cloudflare:sockets`. */
export function setConnectOverride(fn) { connectOverride = fn || null; }

async function loadConnect() {
  if (connectOverride) return connectOverride;
  const mod = await import('cloudflare:sockets');
  return mod.connect;
}

function withDeadline(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export class ElectrumClient {
  constructor(socket, info, opts) {
    const o = opts || {};
    this.socket = socket;
    this.server = { host: info.host, port: info.port, secure: !!info.secure };
    this.timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT;
    this.version = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.dead = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.writeQueue = Promise.resolve();
    this.onNotification = null;
    this.pump = this._read();
  }

  get name() { return this.server.host + ':' + this.server.port; }

  _fail(err) {
    if (this.dead) return;
    this.dead = err instanceof Error ? err : new Error(String(err));
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.dead);
    }
    this.pending.clear();
    try { if (this.socket.close) this.socket.close(); } catch (e) {}
    try { this.reader.cancel().catch(() => {}); } catch (e) {}
    try { this.writer.close().catch(() => {}); } catch (e) {}
  }

  _line(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return this._fail(new Error('resposta não-JSON do Electrum')); }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      if (m.method && m.id === undefined) {
        if (this.onNotification) {
          try { this.onNotification(m.method, m.params || []); } catch (e) {}
        }
        continue; // notificação (scripthash.subscribe, headers.subscribe)
      }
      const p = this.pending.get(m.id);
      if (!p) continue; // notificação ou resposta já expirada
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error((p.method || 'electrum') + ': ' + (m.error.message || JSON.stringify(m.error))));
      } else {
        p.resolve(m.result);
      }
    }
  }

  async _read() {
    try {
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        if (this.buffer.length > MAX_BUFFER) throw new Error('resposta grande demais do Electrum');
        let cut;
        while ((cut = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, cut).trim();
          this.buffer = this.buffer.slice(cut + 1);
          if (line) this._line(line);
        }
      }
      this._fail(new Error('conexão Electrum encerrada pelo servidor'));
    } catch (e) {
      this._fail(e);
    }
  }

  _write(text) {
    const data = this.encoder.encode(text);
    this.writeQueue = this.writeQueue.then(() => this.writer.write(data));
    return this.writeQueue;
  }

  request(method, params) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error('timeout de ' + this.timeoutMs + ' ms em ' + method);
        this._fail(err);
        reject(err);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this._write(JSON.stringify({ id, method, params: params || [] }) + '\n')
      .catch(e => this._fail(e));
    return promise;
  }

  /* Pipelining com janela: mantém `concurrency` pedidos em voo, devolve na ordem. */
  async requestMany(items, concurrency) {
    const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
    const out = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await this.request(items[i].method, items[i].params);
      }
    };
    const workers = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async serverVersion(label) {
    this.version = await this.request('server.version', [label || 'btc/1.0', '1.4']);
    return this.version;
  }

  async ping() {
    return await this.request('server.ping', []);
  }

  async close() {
    if (this.dead) {
      this.dead = this.dead || new Error('fechado');
      return;
    }
    this.dead = new Error('conexão Electrum fechada pelo cliente');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.dead);
    }
    this.pending.clear();
    try { await this.socket.close(); } catch (e) {}
  }
}

/* Abre a primeira conexão que responder, na ordem da lista. */
export async function openElectrum(opts) {
  const o = opts || {};
  const servers = o.servers && o.servers.length ? o.servers : DEFAULT_SERVERS;
  const connectTimeoutMs = Number(o.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT;
  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT;
  const label = o.label || 'btc/1.0';

  let connectFn;
  try {
    connectFn = await loadConnect();
  } catch (e) {
    throw new Error('TCP indisponível neste runtime (cloudflare:sockets): ' +
      (e && e.message ? e.message : e));
  }
  if (typeof connectFn !== 'function') throw new Error('connect() TCP indisponível neste runtime');

  const failures = [];
  for (const server of servers) {
    let socket = null;
    let client = null;
    try {
      const address = { hostname: server.host, port: server.port };
      const options = server.secure ? { secureTransport: 'on' } : {};
      socket = connectFn(address, options);
      await withDeadline(Promise.resolve(socket.opened), connectTimeoutMs,
        'timeout de conexão com ' + server.host + ':' + server.port);
      client = new ElectrumClient(socket, server, { timeoutMs });
      await client.serverVersion(label);
      return client;
    } catch (e) {
      failures.push(server.host + ':' + server.port + ' → ' + (e && e.message ? e.message : e));
      if (client) { try { await client.close(); } catch (_) {} }
      else if (socket) { try { await socket.close(); } catch (_) {} }
    }
  }
  const err = new Error('nenhum servidor Electrum respondeu: ' + failures.join('; '));
  err.failures = failures;
  throw err;
}

/* Histórico + mempool de vários scripts numa conexão só.
   Devolve, por script, um Map txid → altura (0 = mempool). */
export async function historiesMany(client, scripts, opts) {
  const o = opts || {};
  const shs = scripts.map(s => scripthash(s));
  const items = [];
  for (const sh of shs) {
    items.push({ method: 'blockchain.scripthash.get_history', params: [sh] });
    items.push({ method: 'blockchain.scripthash.get_mempool', params: [sh] });
  }
  const out = await client.requestMany(items, o.concurrency);
  return shs.map((sh, i) => {
    const heights = new Map();
    for (const h of (out[i * 2] || [])) {
      if (h && h.tx_hash) heights.set(h.tx_hash, Number(h.height) > 0 ? Number(h.height) : 0);
    }
    for (const m of (out[i * 2 + 1] || [])) {
      if (m && m.tx_hash && !heights.has(m.tx_hash)) heights.set(m.tx_hash, 0);
    }
    return { scripthash: sh, heights, txids: [...heights.keys()], txCount: heights.size };
  });
}

/* Transações cruas (hex) em lote. Tolera txid que sumiu (mempool que caiu,
   reorg): devolve o que veio e o erro por txid, sem derrubar o lote. */
export async function transactionsMany(client, txids, opts) {
  const o = opts || {};
  const limit = Math.max(1, Number(o.concurrency) || 8);
  const raw = new Map();
  const errors = new Map();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= txids.length) return;
      const txid = txids[i];
      try { raw.set(txid, await client.request('blockchain.transaction.get', [txid])); }
      catch (e) { errors.set(txid, e && e.message ? e.message : String(e)); }
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(limit, txids.length); k++) workers.push(worker());
  await Promise.all(workers);
  return { raw, errors };
}

/* Taxa ao vivo: o histograma manda; o estimador é só fallback.

   `mempool.get_fee_histogram` é o estado da fila agora. O nível é a
   **mediana do primeiro bloco**: o preço da faixa em que o acumulado alcança
   metade da vsize do bloco (0,5 × 1 000 000 vB). Metade do bloco paga mais,
   metade paga menos; é o mínimo que compra uma chance razoável de entrar no
   próximo bloco, sem ficar na borda da fila.

   O alvo de 1 bloco inteiro (o piso) era o menor valor que *podia* entrar,
   mas ficava no fim da fila e qualquer transação nova podia empurrá-lo para
   o segundo bloco. Medido em 17/11/2026, a fila cotava 0,127 sat/vB para
   30 min enquanto os blocos recentes fechavam em 1,0 e 1,872 — três dos
   últimos seis blocos só desceram até 0,12, os outros pararam em 1,0 ou
   acima. A mediana acompanha o miolo do bloco; o estimador do Core é
   consultado em 2 blocos, mas só entra quando o histograma não responde.

   O `max` com o estimador saiu: em regime de fila baixa ele fazia a taxa
   ficar ~8× acima da fila (1,003 sat/vB contra uma mediana de ~0,12). O
   estimador continua sendo o fallback para servidor sem histograma; sem
   ele, o nível fica null e o envio é bloqueado.

   Não há escolha de taxa na tela: um número só, a mediana do próximo bloco.
   A escolha entre níveis saiu porque, medido em 17/11/2026, as duas opções
   entregavam ~12 e ~14 minutos de espera por 8x de preço: a escolha não era
   sobre tempo, era sobre seguro, e transferia ao usuário uma decisão sem
   informação (e sem RBF para corrigir depois).

   Nada de folga fixa (FEE_MARGIN saiu): a folga percentual era cerimônia
   diante da variação real dos blocos (0,12 contra 1,87 no mesmo dia). O que
   sobra é o teto da faixa que cruza o alvo (o piso da faixa imediatamente
   mais cara), mais 1 sat/kvB para não empatar com esse teto. O piso da faixa
   não basta: a faixa pode ser mais larga que 1 sat/kvB, e a taxa real do
   corte fica dentro dela. Medido em 17/11/2026, a faixa do corte de 1 bloco
   ia de 1,004245 a 1,005909 sat/vB; o piso + 1 sat/kvB dava 1,005, abaixo do
   1º percentil do primeiro bloco (1,00535), enquanto o teto + 1 sat/kvB dava
   1,006. O mesmo teto é aplicado à mediana.

   O valor NÃO é arredondado: BTC/kvB × 1e8 dá sat/kvB inteiro exato (é a
   unidade em que o servidor de fato responde: 1926, 970, 112), e `sat_per_vb`
   é só a leitura ÷1000. Arredondar a taxa antes de multiplicar pela vsize
   erra sempre para cima, então o PSBT recebe o valor exato e arredonda
   apenas a taxa final, em satoshis (ver `feeSats` em psbt.js).

   `levels` (o que a tela escolhe e o PSBT usa) pode ficar abaixo de 1 sat/vB:
   não há piso econômico na carteira, só o piso de relay. `floored` marca o
   nível abaixo do piso padrão atual do Bitcoin Core (`-minrelaytxfee` =
   0,1 sat/vB desde a v30) e a tela mostra o aviso para o nível escolhido. */
/* Fração do bloco que define o alvo: 0,5 = mediana do primeiro bloco
   (metade da vsize). O alvo de 1 bloco inteiro é o piso da fila; a mediana
   é o mínimo que compra uma chance razoável de entrar no próximo bloco. */
export const FEE_TARGETS = { next: 0.5 };

/* Alvo pedido ao `blockchain.estimatefee`. Diferente do corte (mediana do
   primeiro bloco) porque o Core se recusa a estimar 1 bloco — "It's not
   possible to get reasonable estimates for confTarget of 1" — e calcula com
   2. É o fallback quando o servidor não devolve histograma. */
export const ESTIMATE_TARGETS = { next: 2 };

/* Piso de relay padrão do Bitcoin Core (`-minrelaytxfee`): 100 sat/kvB =
   0,1 sat/vB desde a v30 (nas versões anteriores era 1000 sat/kvB). */
export const RELAY_MIN_KVB = 100;

/* Capacidade de um bloco em vB (peso de 4 M / 4). É a régua do corte de
   fila: no mempool cheio o bloco sai com ~1 000 000 vB. */
export const BLOCK_VSIZE = 1000000;

/* Corte de fila para a fração `blocks` do bloco (0,5 = mediana do
   primeiro bloco; 1 = bloco inteiro), em sat/kvB, a partir do histograma do
   mempool.

   `mempool.get_fee_histogram` devolve [[fee, vsize], …] com `fee` em sat/vB.
   O `vsize` vem POR FAIXA nos servidores reais — conferido em
   electrum.blockstream.info, onde a soma das faixas dá o tamanho do mempool
   (31,9 M vB) e a última faixa tem 2 296 vB —, embora a doc do protocolo
   diga "cumulative virtual size". Ler faixa como acumulado subestima a fila
   de um fator de ~10 mil e devolve a mesma taxa para todos os alvos.

   Aceita os dois formatos sem adivinhar às cegas: depois de ordenar por taxa
   desc, se a coluna já é não-decrescente ela é cumulativa; senão acumula.
   Com oito faixas ou mais, dado por faixa cair em ordem crescente por acaso
   é improvável.

   O corte não é o piso da faixa que cruza o alvo: a faixa contém taxas até
   o piso da faixa imediatamente mais cara, e a taxa real do corte fica
   dentro dela. Pagar o piso + 1 sat/kvB podia ficar abaixo do corte quando
   a faixa era mais larga que isso (medido em 17/11/2026: faixa de 1,004245
   a 1,005909 sat/vB, corte real em 1,00535; o piso + 1 dava 1,005). O teto
   da faixa + 1 sat/kvB é o menor valor que fica acima de todas as
   transações dela. É um passo de 1 sat/kvB, não uma porcentagem: a folga
   percentual que existia aqui (5%) não mudava nada diante da variação real
   dos blocos.

   Alvo dentro da faixa mais cara: o histograma não dá o teto dessa faixa,
   então fica o piso + 1 sat/kvB. Alvo maior que o mempool inteiro: vale a
   faixa mais baixa (o piso do servidor), nunca abaixo do piso de relay
   padrão. */
export function cutoffKvb(histogram, blocks) {
  if (!Array.isArray(histogram) || !histogram.length) return null;
  const rows = [];
  for (const row of histogram) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const fee = Number(row[0]);
    const vsize = Number(row[1]);
    if (!Number.isFinite(fee) || !Number.isFinite(vsize) || fee <= 0 || vsize < 0) continue;
    rows.push([fee, vsize]);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b[0] - a[0]);
  const cumulativo = rows.every((r, i) => i === 0 || r[1] >= rows[i - 1][1]);
  let soma = 0;
  const fila = rows.map(([fee, vsize]) => {
    soma += vsize;
    return [fee, cumulativo ? vsize : soma];
  });
  const alvo = blocks * BLOCK_VSIZE;
  let indice = -1;
  for (let i = 0; i < fila.length; i++) {
    if (fila[i][1] >= alvo) { indice = i; break; }
  }
  let base;
  if (indice < 0) {
    // alvo maior que o mempool inteiro: vale a faixa mais baixa
    base = fila[fila.length - 1][0];
  } else if (indice === 0) {
    // alvo dentro da faixa mais cara: o histograma não dá o teto dela
    base = fila[0][0];
  } else {
    // teto da faixa que cruza o alvo = piso da faixa imediatamente mais cara
    base = fila[indice - 1][0];
  }
  return Math.max(Math.floor(base * 1000) + 1, RELAY_MIN_KVB);
}

export async function estimateFees(client) {
  const keys = Object.keys(FEE_TARGETS);
  // um nível que o servidor não estima não derruba os outros: cada pedido
  // falha isolado e vira null (a tela desabilita aquele nível)
  const [values, histogram] = await Promise.all([
    Promise.all(keys.map(k =>
      client.request('blockchain.estimatefee', [ESTIMATE_TARGETS[k]]).catch(() => null)
    )),
    client.request('mempool.get_fee_histogram', []).catch(() => null)
  ]);
  const levels = {};
  const satPerKvb = {};
  const satPerVb = {};
  const floored = {};
  keys.forEach((k, i) => {
    const v = Number(values[i]);
    // × 1e8 em vez de × 1e5: sat/kvB é inteiro e exato; 0.0000097 * 1e5 daria
    // 0.9700000000000001, e sat/vB só existe para a tela
    const estimado = Number.isFinite(v) && v > 0 ? Math.round(v * 1e8) : null;
    // O histograma manda: a taxa é a mediana do primeiro bloco, já com o
    // teto da faixa + 1 sat/kvB (ver `cutoffKvb`). O estimatefee é só
    // fallback quando não há histograma; usá-lo como piso fazia a taxa ficar
    // ~8× acima da fila em regime de fila baixa.
    const corte = cutoffKvb(histogram, FEE_TARGETS[k]);
    const kvb = corte === null ? estimado : corte;
    satPerKvb[k] = kvb;
    satPerVb[k] = kvb === null ? null : kvb / 1000;
    floored[k] = kvb !== null && kvb < RELAY_MIN_KVB;
    levels[k] = kvb === null ? null : kvb / 1000;
  });
  return {
    levels,
    targets: { ...FEE_TARGETS },
    sat_per_kvb: satPerKvb,
    sat_per_vb: satPerVb,
    floored,
    relay_min_kvb: RELAY_MIN_KVB,
    unit: 'sat/vB',
    source: 'electrum',
    updated_at: new Date().toISOString()
  };
}
