/* Durable Object que segura a conexão com o servidor Electrum e as
   assinaturas (`blockchain.scripthash.subscribe`) de uma carteira.

   - um objeto por sessão de tela (id aleatório criado pelo Worker, sem
     relação com a xpub);
   - **não grava nada**: nem endereços, nem xpub, nem alarme. Todo o estado
     (conexão, assinaturas, endereços recebidos do cliente, cache de
     transações) é memória do objeto e morre com ele;
   - o conjunto derivado chega no POST /sync, fica só em memória e é
     descartado quando a última tela fecha;
   - aviso do Electrum → atualiza só aquele endereço e empurra o estado novo
     para as telas abertas;
   - sem tela aberta, fecha a conexão e esquece tudo; um objeto sem timers,
     sem socket e sem storage é despejado pelo runtime.
   - como não há cache durável, cada abertura de tela refaz a varredura
     com margem de 50; é o preço de não guardar nada. */
import { parseXpub } from './derivation.js';
import { openElectrum, estimateFees } from './electrum.js';
import { broadcastSignedPsbt, previewSignedPsbt } from './broadcast.js';
import { WalletScanner } from './wallet-sync.js';
import { electrumConfig, json } from './config.js';
import { normalizeWatchRequest } from './watch-set.js';

const KEEPALIVE_MS = 30000;
const DEBOUNCE_MS = 1000;
const IDLE_CLOSE_MS = 60000;
const MAX_XPUB_LENGTH = 111;

/* Timers em memória não sobrevivem a eviction (o socket do Electrum e as
   assinaturas também não), então não há o que restaurar. No Node dos testes
   `unref()` evita segurar o processo. */
function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

export class WalletWatcher {
  constructor(state, env) {
    this.env = env;
    this.xpub = null;        // legado; o fluxo novo manda só endereços
    this.account = null;
    this.watchMode = false;
    this.walletId = null;
    this.fingerprint = null;
    this.versionType = null;
    this.client = null;
    this.scanner = null;
    this.subs = new Map();      // scripthash -> status
    this.sockets = new Set();
    this.dirty = new Set();
    this.lastPayload = null;
    this.lastError = null;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    this.generation = 0;   // detecta reativação durante o encerramento
    this.debounceTimer = null;
    this.keepaliveTimer = null;
    this.idleTimer = null;
    this.lock = Promise.resolve(); // serializa handlers que mexem no scanner
  }

  /* O Durable Object roda handlers concorrentes: um /sync em passos e um
     /prepare, por exemplo, podiam trocar `this.scanner` no meio de um
     `scanStep` do outro. A fila é simples (um elo por handler) e não usa
     storage. */
  withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => {}, () => {});
    return run;
  }

  async fetch(request) {
    return await this.withLock(() => this.handle(request));
  }

  /* 409 de sessão de outra xpub: o id da sessão viaja na URL do WebSocket e
     não pode dar acesso à carteira de outra pessoa. */
  otherXpub(xpub) {
    return !!(this.xpub && xpub && this.xpub !== xpub);
  }

  /* A sessão também não pode ser reaproveitada por outra carteira no modo
     watch: o id aleatório do cliente é a identidade da carteira na sessão. */
  otherWallet(walletId) {
    return !!(this.walletId && walletId && this.walletId !== walletId);
  }

  /* Falha de transporte do Electrum no meio de uma rota não é erro de
     validação do formulário: 502, para a tela não culpar o pedido. */
  scanFailure(e) {
    const transport = (this.client && this.client.dead) || (e && e.failures);
    return json({ error: e && e.message ? e.message : '' + e }, transport ? 502 : 400);
  }

  routeError(e) {
    if (e && e.status) return json({ error: e.message }, e.status);
    return this.scanFailure(e);
  }

  /* Prepara o scanner a partir do conjunto de endereços do cliente. O
     `watch` substitui a cauda inteira; `watch_add` só acrescenta o que o
     cliente derivou depois de `watchStatus`. */
  async ensureWatchScanner(wr) {
    if (!wr) {
      if (!this.scanner) {
        const e = new Error('sessão sem endereços; envie watch em /sync');
        e.status = 400;
        throw e;
      }
      this.scanner.client = await this.ensureClient();
      return this.scanner;
    }
    if (this.otherWallet(wr.walletId)) {
      const e = new Error('sessão de outra carteira');
      e.status = 409;
      throw e;
    }
    if (this.watchMode && this.scanner && this.walletId === wr.walletId) {
      if (wr.watch) this.scanner.addWatchRows(wr.watch, true);
      else if (wr.watchAdd) this.scanner.addWatchRows(wr.watchAdd, false);
      this.scanner.client = await this.ensureClient();
      return this.scanner;
    }
    // carteira nova: derruba a conexão e começa do zero, como no xpub legado
    if (this.scanner) {
      await this.closeClient();
      this.scanner = null;
      this.lastPayload = null;
    }
    const client = await this.ensureClient();
    this.watchMode = true;
    this.walletId = wr.walletId;
    this.fingerprint = wr.fingerprint;
    this.versionType = wr.versionType;
    this.xpub = null;
    this.account = null;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    this.scanner = await new WalletScanner({
      env: this.env,
      watch: wr.watch || wr.watchAdd,
      walletId: wr.walletId,
      fingerprint: wr.fingerprint,
      versionType: wr.versionType,
      client
    }).init();
    return this.scanner;
  }

  /* Resolve a carteira de uma rota: watch novo, xpub legado ou a sessão já
     aberta (o caso normal depois do primeiro /sync). */
  async resolveScanner(body) {
    let wr = null;
    try { wr = normalizeWatchRequest(body); }
    catch (e) { const err = new Error(e.message); err.status = 400; throw err; }
    if (wr) return await this.ensureWatchScanner(wr);
    const xpub = String(body.xpub || '').trim();
    if (xpub) {
      if (xpub.length > MAX_XPUB_LENGTH) {
        const e = new Error('xpub grande demais'); e.status = 400; throw e;
      }
      if (this.otherXpub(xpub)) {
        const e = new Error('sessão de outra xpub'); e.status = 409; throw e;
      }
      return await this.ensureScanner(xpub);
    }
    if (this.scanner) {
      this.scanner.client = await this.ensureClient();
      return this.scanner;
    }
    const e = new Error('sessão expirada; recarregue a carteira.');
    e.status = 409;
    throw e;
  }

  async syncWatch(wr, watch) {
    this.generation++;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    const scanner = await this.ensureWatchScanner(wr);
    const payload = await scanner.watchSync();
    this.lastPayload = payload;
    await this.subscribeAll();
    if (watch && this.sockets.size) this.startKeepalive();
    return payload;
  }

  /* Antes de montar/conferir um PSBT, garante que a cauda nova já foi
     consultada. Sem cauda pendente, basta recalcular o cache. */
  async refreshScanner(scanner, watch) {
    if (this.scanning || !this.lastPayload || (scanner.pendingRows && scanner.pendingRows.length)) {
      if (scanner.watchMode) await this.syncWatch(null, watch);
      else await this.sync(this.xpub, watch);
    } else {
      await scanner.recompute();
    }
  }

  async handle(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/sync' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        let wr = null;
        try { wr = normalizeWatchRequest(body); }
        catch (e) { return json({ error: e.message }, 400); }
        if (wr) {
          if (this.otherWallet(wr.walletId)) return json({ error: 'sessão de outra carteira' }, 409);
          const payload = await this.syncWatch(wr, true);
          if (!this.sockets.size) this.armIdleClose();
          return json(payload);
        }
        const xpub = String(body.xpub || '').trim();
        if (!xpub) return json({ error: 'informe a xpub ou os endereços da carteira' }, 400);
        if (xpub.length > MAX_XPUB_LENGTH) return json({ error: 'xpub grande demais' }, 400);
        if (this.otherXpub(xpub)) return json({ error: 'sessão de outra xpub' }, 409);
        const payload = body.scan === 'step'
          ? await this.syncStep(xpub, true)
          : await this.sync(xpub, true);
        // sem tela aberta, dá um tempo curto para o WebSocket chegar; o
        // timer é só memória e fecha a conexão se ninguém aparecer
        if (!this.sockets.size) this.armIdleClose();
        return json(payload);
      }
      if (url.pathname === '/events' || url.pathname === '/api/events') return await this.events(request);
      if (url.pathname === '/fees') {
        const client = await this.ensureClient();
        const fees = await estimateFees(client);
        // sem tela aberta, a conexão aberta só para a taxa não fica solta
        if (!this.sockets.size) this.armIdleClose();
        return json(fees);
      }
      if (url.pathname === '/raw' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        let scanner;
        try { scanner = await this.resolveScanner(body); }
        catch (e) { return this.routeError(e); }
        try {
          await this.refreshScanner(scanner, true);
          return json({ raw: scanner.rawTransactions() });
        } catch (e) {
          return this.scanFailure(e);
        }
      }
      if (url.pathname === '/prepare' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        let scanner;
        try { scanner = await this.resolveScanner(body); }
        catch (e) { return this.routeError(e); }
        try {
          await this.refreshScanner(scanner, true);
          const target = {
            address: String(body.address || ''),
            feeRate: Number(body.feeRate),
            amountSats: body.amountSats == null ? null : Number(body.amountSats),
            quoteRates: Array.isArray(body.quoteRates) ? body.quoteRates : null
          };
          const payload = body.preview === true
            ? scanner.limits(target)
            : await scanner.prepare({
              ...target,
              amountSats: Number(body.amountSats)
            });
          return json(payload);
        } catch (e) {
          return this.scanFailure(e);
        }
      }
      if (url.pathname === '/cpfp' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const txid = String(body.txid || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) return json({ error: 'txid inválido' }, 400);
        const feeRate = Number(body.feeRate);
        let scanner;
        try { scanner = await this.resolveScanner(body); }
        catch (e) { return this.routeError(e); }
        try {
          await this.refreshScanner(scanner, true);
          return json(await scanner.prepareCpfp({ txid, feeRate }));
        } catch (e) {
          return this.scanFailure(e);
        }
      }
      if (url.pathname === '/broadcast' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) {}
        const psbt = String(body.psbt || '');
        if (!psbt.trim()) return json({ error: 'informe o psbt assinado' }, 400);
        const preview = body.preview === true;
        let scanner;
        try { scanner = await this.resolveScanner(body); }
        catch (e) { return this.routeError(e); }
        try {
          // estado novo: a conferência usa os UTXOs e os scripts desta sessão
          await this.refreshScanner(scanner, true);
          const client = await this.ensureClient();
          return json(preview
            ? previewSignedPsbt({ scanner, psbtText: psbt })
            : await broadcastSignedPsbt({ client, scanner, psbtText: psbt }));
        } catch (e) {
          return this.scanFailure(e);
        }
      }
      return json({ error: 'rota do watch não encontrada' }, 404);
    } catch (e) {
      this.lastError = e && e.message ? e.message : '' + e;
      return this.routeError(e);
    }
  }

  /* ---------- conexão e assinaturas ---------- */

  async ensureClient() {
    if (this.client && !this.client.dead) return this.client;
    const cfg = electrumConfig(this.env);
    if (!cfg) throw new Error('Electrum desligado (ELECTRUM_SERVERS=off)');
    if (cfg.error) throw new Error(cfg.error);
    this.client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
    this.client.onNotification = (method, params) => this.onNotify(method, params);
    this.subs.clear(); // conexão nova: precisa reassinar
    return this.client;
  }

  async ensureScanner(xpub) {
    const key = xpub || this.xpub;
    if (!key) {
      if (this.scanner) {
        this.scanner.client = await this.ensureClient();
        return this.scanner;
      }
      throw new Error('sessão sem xpub; envie a xpub em /sync');
    }
    if (this.scanner && this.xpub === key) {
      // a conexão pode ter caído: reconecta e reaproveita os endereços já
      // derivados e o cache de transações da sessão
      this.scanner.client = await this.ensureClient();
      return this.scanner;
    }
    // carteira diferente na mesma sessão: derruba a conexão e começa do zero
    if (this.xpub && this.xpub !== key) {
      await this.closeClient();
      this.scanner = null;
      this.lastPayload = null;
    }
    const client = await this.ensureClient();
    this.xpub = key;
    this.account = parseXpub(key);
    this.watchMode = false;
    this.walletId = null;
    this.fingerprint = null;
    this.versionType = null;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    this.scanner = await new WalletScanner({
      env: this.env,
      xpub: key,
      account: this.account,
      client
    }).init();
    return this.scanner;
  }

  async sync(xpub, watch) {
    this.generation++;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    const scanner = await this.ensureScanner(xpub);
    const payload = await scanner.fullSync();
    this.lastPayload = payload;
    await this.subscribeAll();
    if (watch && this.sockets.size) this.startKeepalive();
    return payload;
  }

  /* Um passo da varredura. A tela chama de novo enquanto `has_more` vier
     verdadeiro; o saldo final só é devolvido no último passo. */
  async syncStep(xpub, watch) {
    this.generation++;
    const scanner = await this.ensureScanner(xpub);
    if (!this.scanning) {
      this.scanning = true;
      this.scanRequery = true;
      this.lastPayload = null;
    }
    const step = await scanner.scanStep(this.scanRequery);
    this.scanRequery = false;
    this.progress = scanner.progress();
    if (step.more) {
      this.lastPayload = null;
      return { scanning: true, has_more: true, progress: this.progress };
    }
    await scanner.recompute();
    const payload = await scanner.payload();
    this.scanning = false;
    this.progress = null;
    this.lastPayload = payload;
    await this.subscribeAll();
    if (watch && this.sockets.size) this.startKeepalive();
    return Object.assign({}, payload, { scanning: false, has_more: false });
  }

  async subscribeAll() {
    if (!this.scanner || !this.client || this.client.dead) return;
    const wanted = this.scanner.scriptsForWatch();
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
    // um debounce só, curto, para juntar avisos do mesmo bloco
    if (!this.debounceTimer) {
      this.debounceTimer = unref(setTimeout(() => {
        this.debounceTimer = null;
        this.flushDirty();
      }, DEBOUNCE_MS));
    }
  }

  async flushDirty() {
    return await this.withLock(() => this._flushDirty());
  }

  async _flushDirty() {
    try {
      if (this.dirty.size) {
        const dirty = [...this.dirty];
        this.dirty.clear();
        if (!this.scanner || !this.client || this.client.dead) {
          const payload = await this.sync(null, this.sockets.size > 0);
          this.broadcast({ type: 'payload', payload });
        } else {
          const { payload, added } = await this.scanner.refreshServices(dirty);
          this.lastPayload = payload;
          if (added && added.length) await this.subscribeAll();
          this.broadcast({ type: 'payload', payload });
        }
      }
    } catch (e) {
      this.lastError = e && e.message ? e.message : '' + e;
      this.broadcast({ type: 'error', error: this.lastError });
    }
  }

  /* ---------- timers (todos em memória) ---------- */

  armIdleClose() {
    this.stopIdleClose();
    this.idleTimer = unref(setTimeout(() => {
      this.idleTimer = null;
      if (!this.sockets.size) this.stopSession().catch(() => {});
    }, IDLE_CLOSE_MS));
  }

  stopIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = unref(setInterval(() => { this.ping(); }, KEEPALIVE_MS));
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  async ping() {
    return await this.withLock(() => this._ping());
  }

  async _ping() {
    if (!this.sockets.size) return this._stopSession();
    try {
      if (this.client && !this.client.dead) await this.client.ping();
      else await this.sync(null, true);
    } catch (e) {
      this.lastError = e && e.message ? e.message : '' + e;
      await this.closeClient();
      this.broadcast({ type: 'error', error: this.lastError });
    }
  }

  /* Fim da sessão: nenhuma tela aberta. Descarta conexão, assinaturas,
     endereços observados, cache de transações e a identidade da carteira. Se um POST chegar
     enquanto fechamos (troca de xpub, recarga), a sessão foi reativada e o
     estado novo é preservado. */
  async stopSession() {
    return await this.withLock(() => this._stopSession());
  }

  async _stopSession() {
    if (this.sockets.size) return;
    const gen = this.generation;
    this.stopKeepalive();
    this.stopIdleClose();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    await this.closeClient();
    if (this.generation !== gen || this.sockets.size) return;
    this.xpub = null;
    this.account = null;
    this.watchMode = false;
    this.walletId = null;
    this.fingerprint = null;
    this.versionType = null;
    this.scanner = null;
    this.lastPayload = null;
    this.lastError = null;
    this.scanning = false;
    this.scanRequery = true;
    this.progress = null;
    this.dirty.clear();
  }

  async closeClient() {
    const client = this.client;
    this.client = null;
    this.subs.clear();
    if (!client) return;
    try { await client.close(); } catch (e) {}
  }

  /* ---------- WebSocket ---------- */

  async events(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'use websocket' }, 426);
    }
    /* WebSocket não é protegido por SOP: quando o navegador manda Origin,
       ele tem de ser o mesmo host da página. Sem Origin (clientes que não
       são navegador, como os testes) a credencial continua sendo o id da
       sessão. */
    const origin = request.headers.get('Origin');
    if (origin) {
      let expected = '';
      try { expected = new URL(request.url).origin; } catch (e) {}
      if (!expected || origin !== expected) return json({ error: 'origem não permitida' }, 403);
    }
    // sessão sem carteira (objeto despejado ou nunca sincronizado): o
    // cliente precisa reenviar os endereços em /api/wallet
    if (!this.xpub && !this.scanner) return json({ error: 'sessão expirada; recarregue a carteira.' }, 409);
    if (!this.scanning) {
      if (!this.lastPayload || !this.scanner || !this.client || this.client.dead) {
        await this.sync(null, true);
      } else {
        await this.subscribeAll();
      }
    }
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
    this.stopIdleClose();
    this.sockets.add(server);
    const drop = () => {
      this.sockets.delete(server);
      if (!this.sockets.size) this.stopSession().catch(() => {});
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    if (this.lastPayload) this.send(server, { type: 'payload', payload: this.lastPayload });
    else if (this.scanning) this.send(server, { type: 'progress', progress: this.progress });
    this.startKeepalive();
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
}
