/* Validação e execução do lote JSON-RPC que o proxy aceita. Compartilhado
   entre o Worker (fallback sem Durable Object) e o ProxyWatcher (conexão
   reaproveitada dentro do objeto). Nenhum dado de carteira passa aqui. */

export const MAX_PROXY_ITEMS = 2500;
const MAX_TX_HEX = 400000;
const HEX64 = /^[0-9a-f]{64}$/;

const READ_METHODS = new Set([
  'blockchain.scripthash.get_history',
  'blockchain.scripthash.get_mempool',
  'blockchain.transaction.get',
  'blockchain.estimatefee'
]);
export const BROADCAST_METHOD = 'blockchain.transaction.broadcast';

function proxyItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('item de proxy inválido');
  const method = String(raw.method || '');
  if (method !== BROADCAST_METHOD && !READ_METHODS.has(method)) {
    throw new Error('método não permitido: ' + method);
  }
  const params = Array.isArray(raw.params) ? raw.params : [];
  if (method === 'blockchain.scripthash.get_history' || method === 'blockchain.scripthash.get_mempool') {
    if (params.length !== 1 || !HEX64.test(String(params[0] || '').toLowerCase())) {
      throw new Error('scripthash inválido');
    }
    return { method, params: [String(params[0]).toLowerCase()] };
  }
  if (method === 'blockchain.transaction.get') {
    if (params.length < 1 || !HEX64.test(String(params[0] || '').toLowerCase())) {
      throw new Error('txid inválido');
    }
    return { method, params: [String(params[0]).toLowerCase()] };
  }
  if (method === 'blockchain.estimatefee') {
    const target = Number(params[0]);
    if (!Number.isInteger(target) || target < 1 || target > 1000) {
      throw new Error('alvo de taxa inválido');
    }
    return { method, params: [target] };
  }
  const tx = String(params[0] || '').toLowerCase();
  if (tx.length < 2 || tx.length > MAX_TX_HEX || tx.length % 2 || !/^[0-9a-f]+$/.test(tx)) {
    throw new Error('transação inválida');
  }
  return { method, params: [tx] };
}

/* `body.items` ou um item só. Devolve a lista normalizada. */
export function normalizeProxyItems(body) {
  const rawItems = Array.isArray(body && body.items) ? body.items : [body];
  if (!rawItems.length || rawItems.length > MAX_PROXY_ITEMS) {
    throw new Error('lote inválido');
  }
  const items = rawItems.map(proxyItem);
  if (items.some(item => item.method === BROADCAST_METHOD) && items.length !== 1) {
    throw new Error('broadcast precisa ser sozinho no lote');
  }
  return items;
}

export async function runProxyItems(client, items) {
  const results = new Array(items.length);
  const errors = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await client.request(items[i].method, items[i].params); }
      catch (e) { errors[i] = e && e.message ? e.message : String(e); results[i] = null; }
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(20, items.length); k++) workers.push(worker());
  await Promise.all(workers);
  return { results, errors };
}
