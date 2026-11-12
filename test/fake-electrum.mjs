/* Servidor Electrum de mentira para os testes (TCP puro, sem TLS) e um
   adaptador connect() em Node no mesmo formato de cloudflare:sockets.
   Fala o subconjunto que o Worker usa: server.version, scripthash
   get_history/get_mempool e transaction.get. */
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import BTC from '../src/btc-core.js';

function require_hash(text) {
  return createHash('sha256').update(text).digest().toString('hex').slice(0, 16);
}

/* txid de uma transação crua: sha256 duplo da serialização SEM witness
   (o wtxid não serve para o histórico nem para o `broadcast`). */
function txidOfHex(hex) {
  return BTC.txidOf(BTC.readTx(BTC.hexToBytes(hex)));
}

export async function startFakeElectrum(opts) {
  const o = opts || {};
  const histories = new Map(Object.entries(o.histories || {}));
  const mempool = new Map(Object.entries(o.mempool || {}));
  const txs = new Map(Object.entries(o.txs || {}));
  const requests = [];
  const broadcasts = [];
  const sockets = new Set();
  const subsBySocket = new Map(); // socket -> Set<scripthash>

  const statusOf = (sh) => {
    const hist = (histories.get(sh) || []).map(h => (h.tx_hash || '') + ':' + (h.height || 0)).join(',');
    const mem = (mempool.get(sh) || []).map(h => h.tx_hash || '').join(',');
    return require_hash(hist + '|' + mem);
  };

  const asEntries = (list) => (list || []).map(h => ({
    height: h.height === undefined ? 0 : h.height,
    tx_hash: h.tx_hash || h.txid,
    fee: 0
  }));

  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); subsBySocket.delete(socket); });
    subsBySocket.set(socket, new Set());
    let buf = '';
    socket.on('data', chunk => {
      if (o.silent) return;
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch (e) {
          socket.write(JSON.stringify({ id: null, error: { code: -32700, message: 'parse' } }) + '\n');
          continue;
        }
        requests.push(req);
        const arg = req.params && req.params[0];
        let result;
        if (req.method === 'server.version') {
          result = ['fake-electrum 1.0', '1.4'];
        } else if (req.method === 'blockchain.scripthash.get_history') {
          result = asEntries(histories.get(arg));
        } else if (req.method === 'blockchain.scripthash.get_mempool') {
          result = asEntries(mempool.get(arg));
        } else if (req.method === 'blockchain.scripthash.subscribe') {
          subsBySocket.get(socket).add(arg);
          result = statusOf(arg);
        } else if (req.method === 'blockchain.scripthash.unsubscribe') {
          subsBySocket.get(socket).delete(arg);
          result = true;
        } else if (req.method === 'server.ping') {
          result = null;
        } else if (req.method === 'blockchain.estimatefee') {
          const table = o.fees || { 1: 0.00012, 2: 0.00011, 3: 0.00009, 6: 0.00006, 144: 0.00002 };
          const value = table[Number(arg)];
          result = value === undefined ? -1 : value;
        } else if (req.method === 'blockchain.transaction.broadcast') {
          const hex = String(arg || '').toLowerCase();
          if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', error: { code: -22, message: 'TX decode failed' } }) + '\n');
            continue;
          }
          if (o.broadcastError) {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', error: { code: -26, message: o.broadcastError } }) + '\n');
            continue;
          }
          try {
            result = txidOfHex(hex);
          } catch (e) {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', error: { code: -22, message: 'TX decode failed' } }) + '\n');
            continue;
          }
          broadcasts.push({ hex, txid: result });
        } else if (req.method === 'blockchain.transaction.get') {
          const hex = txs.get(arg);
          if (typeof hex !== 'string') {
            socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', error: { code: -32603, message: 'transaction not found' } }) + '\n');
            continue;
          }
          result = hex;
        } else {
          socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', error: { code: -32601, message: 'método desconhecido' } }) + '\n');
          continue;
        }
        socket.write(JSON.stringify({ id: req.id, jsonrpc: '2.0', result }) + '\n');
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    port,
    host: '127.0.0.1',
    requests,
    broadcasts,
    histories,
    mempool,
    txs,
    count(method) { return requests.filter(r => r.method === method).length; },
    setBroadcastError(message) { o.broadcastError = message || ''; },
    /* Empurra uma notificação de scripthash (como o servidor real faz). */
    notify(sh) {
      const next = statusOf(sh);
      for (const [socket, subs] of subsBySocket) {
        if (!subs.has(sh)) continue;
        socket.write(JSON.stringify({
          jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [sh, next]
        }) + '\n');
      }
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/* Espelha o Socket do Workers: readable/writable Web Streams, opened/closed, close(). */
export function nodeConnect(address, options) {
  const socket = net.connect({ host: address.hostname, port: address.port });
  socket.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({
      remoteAddress: socket.remoteAddress, localAddress: socket.localAddress
    }));
    socket.once('error', reject);
  });
  const closed = new Promise(resolve => socket.once('close', resolve));
  closed.catch(() => {});
  return {
    readable: Readable.toWeb(socket),
    writable: Writable.toWeb(socket),
    opened,
    closed,
    close() {
      return new Promise(resolve => {
        if (socket.destroyed) return resolve();
        socket.once('close', resolve);
        socket.destroy();
      });
    }
  };
}

/* Porta livre que não aceita conexão (para testar fallback). */
export async function deadPort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}
