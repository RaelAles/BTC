/* Configuração compartilhada entre o Worker e o Durable Object. */
import { DEFAULT_SERVERS, parseServerList } from './electrum.js';

/* ELECTRUM_SERVERS="host:porta[:tls|:tcp],..." (off desliga),
   ELECTRUM_TIMEOUT_MS. A margem de vazios e o lote da varredura são fixos
   em wallet-sync.js (DEFAULT_GAP e SCAN_BATCH), não vêm do ambiente. */
export function electrumConfig(env) {
  const raw = env && env.ELECTRUM_SERVERS;
  const text = raw == null ? '' : String(raw).trim();
  if (/^(off|0|false|no)$/i.test(text)) return null;
  let servers;
  try { servers = text ? parseServerList(text) : DEFAULT_SERVERS; }
  catch (e) { return null; }
  return {
    servers,
    timeoutMs: Number((env && env.ELECTRUM_TIMEOUT_MS) || 8000)
  };
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
export function fail(message, status = 400) { return json({ error: String(message) }, status); }
