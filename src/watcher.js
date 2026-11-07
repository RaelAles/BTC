/* Durable Object que segura a conexão com o servidor Electrum e as
   assinaturas (`blockchain.scripthash.subscribe`) de uma carteira xpub.

   - um objeto por xpub (id = hash da xpub);
   - recebe aviso do servidor quando um scripthash muda, atualiza só aquele
     endereço e empurra o estado novo para as telas abertas por WebSocket;
   - sem tela aberta, fecha a conexão e deixa o objeto dormir (socket aberto
     mantém o DO em memória por até 15 min, e isso é cobrado como duração);
   - o D1 continua sendo a fonte de verdade; o DO guarda só conexão,
     assinaturas e o estado em memória, que é reconstruído do D1 se ele for
     despejado. */
import { parseXpub } from './derivation.js';
import { openElectrum } from './electrum.js';
import { WalletScanner, getWallet } from './wallet-sync.js';
import { electrumConfig, json } from './config.js';

const KEEPALIVE_MS = 30000;
const DEBOUNCE_MS = 1000;
const IDLE_CLOSE_MS = 60000;

export class WalletWatcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hash = state.id && state.id.name ? state.id.name : null;
    this.xpub = null;
    this.account = null;
    this.client = null;
    this.scanner = null;
    this.subs = new Map();      // scripthash -> status
    this.sockets = new Set();
    this.dirty = new Set();
    this.lastPayload = null;
    this.lastError = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/sync' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const payload = await this.sync(body.xpub, true);
        // sem tela aberta, a conexão não fica aberta à toa: o alarme fecha
        if (!this.sockets.size) await this.state.storage.setAlarm(Date.now() + IDLE_CLOSE_MS);
        return json(payload);
      }
      if (url.pathname === '/events' || url.pathname === '/api/events') return await this.events(request);
      if (url.pathname === '/state') {
        if (!this.lastPayload) await this.sync(null, true);
        return json(this.lastPayload || { error: 'sem estado' }, this.lastPayload ? 200 : 503);
      }
      return json({ error: 'rota do watch não encontrada' }, 404);
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      return json({ error: this.lastError }, 502);
    }
  }

  /* ---------- conexão e assinaturas ---------- */

  async ensureClient() {
    if (this.client && !this.client.dead) return this.client;
    const cfg = electrumConfig(this.env);
    if (!cfg) throw new Error('Electrum desligado (ELECTRUM_SERVERS=off)');
    this.client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
    this.client.onNotification = (method, params) => this.onNotify(method, params);
    this.subs.clear(); // conexão nova: precisa reassinar
    this.gap = cfg.gap;
    this.maxScan = cfg.maxScan;
    return this.client;
  }

  async loadXpub() {
    if (this.xpub) return this.xpub;
    const wallet = await getWallet(this.env, this.hash);
    if (!wallet) throw new Error('carteira desconhecida: envie a xpub em /api/wallet antes');
    this.xpub = wallet.xpub;
    return this.xpub;
  }

  async ensureScanner(xpub) {
    const key = xpub || await this.loadXpub();
    if (this.scanner && this.xpub === key) return this.scanner;
    const client = await this.ensureClient();
    this.xpub = key;
    this.account = parseXpub(key);
    this.scanner = await new WalletScanner({
      env: this.env,
      xpub: key,
      account: this.account,
      hash: this.hash,
      client,
      gap: this.gap,
      maxScan: this.maxScan
    }).init();
    return this.scanner;
  }

  async sync(xpub, watch) {
    const client = await this.ensureClient();
    const scanner = await this.ensureScanner(xpub);
    const payload = await scanner.fullSync();
    this.lastPayload = payload;
    await this.subscribeAll();
    if (watch && this.sockets.size) await this.keepAlive();
    return payload;
  }

  async subscribeAll() {
    if (!this.scanner || !this.client || this.client.dead) return;
    const wanted = this.scanner.scripts();
    const missing = wanted.filter(sh => !this.subs.has(sh));
    if (!missing.length) return;
    const items = missing.map(sh => ({ method: 'blockchain.scripthash.subscribe', params: [sh] }));
    const results = await this.client.requestMany(items, 40);
    missing.forEach((sh, i) => {
      this.subs.set(sh, results[i] == null ? null : String(results[i]));
    });
  }

  onNotify(method, params) {
    if (method !== 'blockchain.scripthash.subscribe') return;
    const sh = params && params[0];
    if (!sh) return;
    const status = params[1];
    this.subs.set(sh, status == null ? null : String(status));
    this.dirty.add(sh);
    // um alarme só, curto, para juntar avisos do mesmo bloco
    Promise.resolve()
      .then(() => this.state.storage.getAlarm())
      .then(alarm => (alarm === null ? this.state.storage.setAlarm(Date.now() + DEBOUNCE_MS) : null))
      .catch(() => {});
  }

  /* ---------- WebSocket ---------- */

  async events(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'use websocket' }, 426);
    }
    await this.sync(null, true);
    const { client } = await this.openSocket();
    return new Response(null, { status: 101, webSocket: client });
  }

  /* Ponto de entrada do WebSocket, separado do Response para os testes
     poderem falar com o objeto sem o upgrade de verdade. */
  async openSocket() {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    const drop = () => this.sockets.delete(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    if (this.lastPayload) this.send(server, { type: 'payload', payload: this.lastPayload });
    await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    return { client, server };
  }

  send(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch (e) {
      this.sockets.delete(socket);
    }
  }

  broadcast(message) {
    for (const socket of [...this.sockets]) this.send(socket, message);
  }

  async keepAlive() {
    await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  /* ---------- alarme: aviso pendente + keepalive ---------- */

  async alarm() {
    const hadSockets = this.sockets.size > 0;
    try {
      if (this.dirty.size) {
        const dirty = [...this.dirty];
        this.dirty.clear();
        if (!this.scanner || !this.client || this.client.dead) {
          const payload = await this.sync(null, hadSockets);
          this.broadcast({ type: 'payload', payload });
        } else {
          const { payload, added } = await this.scanner.refreshServices(dirty);
          this.lastPayload = payload;
          if (added && added.length) await this.subscribeAll();
          this.broadcast({ type: 'payload', payload });
        }
      }
    } catch (e) {
      this.lastError = e && e.message ? e.message : String(e);
      this.broadcast({ type: 'error', error: this.lastError });
    }

    if (this.sockets.size) {
      try {
        if (this.client && !this.client.dead) await this.client.ping();
        else await this.sync(null, true);
      } catch (e) {
        this.lastError = e && e.message ? e.message : String(e);
        await this.closeClient();
        this.broadcast({ type: 'error', error: this.lastError });
      }
      await this.keepAlive();
      return;
    }

    // nenhuma tela aberta: para de monitorar e deixa o objeto dormir
    await this.closeClient();
    await this.state.storage.deleteAlarm();
  }

  async closeClient() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.subs.clear();
    try { await client.close(); } catch (e) {}
  }
}
