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

/* Taxa ao vivo: `blockchain.estimatefee` devolve BTC/kvB para um alvo em
   blocos. Quatro alvos cobrem a escolha da tela, em ordem de prioridade:
   mínima (144 blocos ≈ 1 dia), padrão (6 ≈ 1 h), alta (3 ≈ 30 min) e
   urgente (1 bloco ≈ 10 min; o Bitcoin Core trata o alvo 1 como 2, o menor
   que ele estima). A tela mostra essas chaves como prazo médio, sem citar
   bloco: o tempo é alvo × 10 min, a média do intervalo entre blocos, não uma
   previsão do `estimatefee`. Servidor que responde -1 fica sem estimativa
   naquele nível (null) e a tela desabilita aquele nível.

   O valor NÃO é arredondado: BTC/kvB × 1e8 dá sat/kvB inteiro exato (é a
   unidade em que o servidor de fato responde: 1926, 970, 112), e `sat_per_vb`
   é só a leitura ÷1000. Arredondar a taxa antes de multiplicar pela vsize
   erra sempre para cima, então o PSBT recebe o valor exato e arredonda
   apenas a taxa final, em satoshis (ver `feeSats` em psbt.js).

   Abaixo do piso de relay do Bitcoin Core (1000 sat/kvB = 1 sat/vB) a
   transação não entra no mempool padrão: o nível continua visível com o
   valor que o servidor deu em `sat_per_vb`, mas `levels` (o que a tela
   escolhe e o PSBT usa) fica no piso e `floored` marca o nível. Num mempool
   quase vazio, vários alvos caem abaixo do piso — é o resultado correto, e a
   escada artificial de +1 sat/vB que existia antes escondia isso. */
export const FEE_TARGETS = { minimum: 144, standard: 6, high: 3, urgent: 1 };

/* Piso de relay do Bitcoin Core (`-minrelaytxfee` padrão): 1000 sat/kvB. */
export const RELAY_MIN_KVB = 1000;

export async function estimateFees(client) {
  const keys = Object.keys(FEE_TARGETS);
  // um nível que o servidor não estima não derruba os outros: cada pedido
  // falha isolado e vira null (a tela desabilita aquele nível)
  const values = await Promise.all(keys.map(k =>
    client.request('blockchain.estimatefee', [FEE_TARGETS[k]]).catch(() => null)
  ));
  const levels = {};
  const satPerKvb = {};
  const satPerVb = {};
  const floored = {};
  keys.forEach((k, i) => {
    const v = Number(values[i]);
    // × 1e8 em vez de × 1e5: sat/kvB é inteiro e exato; 0.0000097 * 1e5 daria
    // 0.9700000000000001, e sat/vB só existe para a tela
    const kvb = Number.isFinite(v) && v > 0 ? Math.round(v * 1e8) : null;
    satPerKvb[k] = kvb;
    satPerVb[k] = kvb === null ? null : kvb / 1000;
    floored[k] = kvb !== null && kvb < RELAY_MIN_KVB;
    levels[k] = kvb === null ? null : Math.max(RELAY_MIN_KVB, kvb) / 1000;
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
