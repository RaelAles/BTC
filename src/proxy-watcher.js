/* Durable Object de notificações do proxy.

   Não guarda carteira: o cliente manda só uma lista de scripthashes e o
   objeto mantém as assinaturas `blockchain.scripthash.subscribe` enquanto a
   tela estiver aberta. Um aviso vira `{type:"scripthash",scripthash}`; o
   navegador reconsulta o histórico/transações no proxy e recalcula tudo
   localmente. Sem socket, fecha a conexão e esquece as assinaturas. */
import { openElectrum } from './electrum.js';
import { electrumConfig, json } from './config.js';

const KEEPALIVE_MS = 30000;
const IDLE_CLOSE_MS = 60000;
const MAX_SH = 2500;
const HEX64 = /^[0-9a-f]{64}$/;

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

export class ProxyWatcher {
  constructor(state, env) {
    this.env = env;
    this.client = null;
    this.subs = new Set();
    this.sockets = new Set();
    this.keepaliveTimer = null;
    this.idleTimer = null;
    this.lock = Promise.resolve();
  }

  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => {}, () => {});
    return run;
  }

  fetch(request) {
    return this.withLock(() => this.handle(request));
  }

  async handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/events' || url.pathname === '/api/events') {
      return await this.events(request);
    }
    return json({ error: 'rota do proxy não encontrada' }, 404);
  }

  async ensureClient() {
    if (this.client && !this.client.dead) return this.client;
    const cfg = electrumConfig(this.env);
    if (!cfg) throw new Error('Electrum desligado (ELECTRUM_SERVERS=off)');
    if (cfg.error) throw new Error(cfg.error);
    this.client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
    this.client.onNotification = (method, params) => this.onNotify(method, params);
    this.subs.clear();
    return this.client;
  }

  async events(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'use websocket' }, 426);
    }
    const origin = request.headers.get('Origin');
    if (origin) {
      let expected = '';
      try { expected = new URL(request.url).origin; } catch (e) {}
      if (!expected || origin !== expected) return json({ error: 'origem não permitida' }, 403);
    }
    const pair = this.connectSocket();
    return new Response(null, { status: 101, webSocket: pair.client });
  }

  connectSocket() {
    const pair = this.openSocket();
    const server = pair.server;
    this.stopIdleClose();
    this.sockets.add(server);
    server.addEventListener('message', ev => {
      this.withLock(() => this.onMessage(server, ev.data)).catch(() => {});
    });
    const drop = () => {
      this.sockets.delete(server);
      if (!this.sockets.size) this.armIdleClose();
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    this.startKeepalive();
    return pair;
  }

  openSocket() {
    const pair = new WebSocketPair();
    pair[1].accept();
    return { client: pair[0], server: pair[1] };
  }

  async onMessage(socket, raw) {
    let message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw)); }
    catch (e) { return; }
    if (!message || message.type !== 'subscribe') return;
    let shs;
    try { shs = this.normalizeScripthashes(message.scripthashes); }
    catch (e) {
      this.send(socket, { type: 'error', error: e.message });
      return;
    }
    try {
      await this.subscribe(shs);
      this.send(socket, { type: 'subscribed', count: shs.length });
    } catch (e) {
      this.send(socket, { type: 'error', error: e && e.message ? e.message : String(e) });
    }
  }

  normalizeScripthashes(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_SH) {
      throw new Error('lista de scripthashes inválida');
    }
    const out = [];
    const seen = new Set();
    for (const raw of value) {
      const sh = String(raw || '').toLowerCase();
      if (!HEX64.test(sh)) throw new Error('scripthash inválido');
      if (seen.has(sh)) continue;
      seen.add(sh);
      out.push(sh);
    }
    return out;
  }

  async subscribe(shs) {
    const client = await this.ensureClient();
    const wanted = new Set(shs);
    const drop = [...this.subs].filter(sh => !wanted.has(sh));
    if (drop.length) {
      await client.requestMany(drop.map(sh => ({
        method: 'blockchain.scripthash.unsubscribe', params: [sh]
      })), 40).catch(() => {});
      for (const sh of drop) this.subs.delete(sh);
    }
    const add = shs.filter(sh => !this.subs.has(sh));
    if (add.length) {
      const results = await client.requestMany(add.map(sh => ({
        method: 'blockchain.scripthash.subscribe', params: [sh]
      })), 40);
      add.forEach((sh, i) => this.subs.add(sh));
      void results;
    }
  }

  onNotify(method, params) {
    if (method !== 'blockchain.scripthash.subscribe') return;
    const sh = params && String(params[0] || '').toLowerCase();
    if (!sh || !this.subs.has(sh)) return;
    this.broadcast({ type: 'scripthash', scripthash: sh });
  }

  startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = unref(setInterval(() => {
      this.withLock(() => this.ping()).catch(() => {});
    }, KEEPALIVE_MS));
  }

  async ping() {
    if (!this.sockets.size) {
      await this.stop();
      return;
    }
    if (!this.client || this.client.dead) return;
    try { await this.client.ping(); }
    catch (e) {
      await this.closeClient();
      this.broadcast({ type: 'error', error: e && e.message ? e.message : String(e) });
    }
  }

  armIdleClose() {
    this.stopIdleClose();
    this.idleTimer = unref(setTimeout(() => {
      this.idleTimer = null;
      if (!this.sockets.size) this.stop().catch(() => {});
    }, IDLE_CLOSE_MS));
  }

  stopIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async closeClient() {
    const client = this.client;
    this.client = null;
    this.subs.clear();
    if (client) {
      try { await client.close(); } catch (e) {}
    }
  }

  async stop() {
    this.stopIdleClose();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    await this.closeClient();
    this.sockets.clear();
  }

  send(socket, message) {
    try { socket.send(JSON.stringify(message)); }
    catch (e) { this.sockets.delete(socket); }
  }

  broadcast(message) {
    for (const socket of [...this.sockets]) this.send(socket, message);
  }
}
