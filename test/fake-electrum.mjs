/* Servidor Electrum de mentira para os testes (TCP puro, sem TLS) e um
   adaptador connect() em Node no mesmo formato de cloudflare:sockets.
   Não há rede: o teste aponta o transporte para 127.0.0.1. */
import net from 'node:net';
import { Readable, Writable } from 'node:stream';

export async function startFakeElectrum(opts) {
  const o = opts || {};
  const balances = new Map(Object.entries(o.balances || {}));
  const histories = new Map(Object.entries(o.histories || {}));
  const requests = [];
  const sockets = new Set();

  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
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
        const sh = req.params && req.params[0];
        let result;
        if (req.method === 'server.version') {
          result = ['fake-electrum 1.0', '1.4'];
        } else if (req.method === 'blockchain.scripthash.get_balance') {
          const bal = balances.get(sh) || 0;
          result = { confirmed: bal, unconfirmed: 0 };
        } else if (req.method === 'blockchain.scripthash.get_history') {
          const n = histories.has(sh) ? histories.get(sh) : (balances.get(sh) > 0 ? 1 : 0);
          result = Array.from({ length: n }, (_, i) => ({ height: 700000 + i, tx_hash: 'aa'.repeat(31) + '01' }));
        } else if (req.method === 'blockchain.scripthash.listunspent') {
          const bal = balances.get(sh) || 0;
          result = bal > 0 ? [{ tx_hash: 'bb'.repeat(32), tx_pos: 0, height: 700000, value: bal }] : [];
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
    balances,
    histories,
    server,
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
