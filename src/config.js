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

/* Cabeçalhos de segurança aplicados pelo Worker às respostas dinâmicas
   (/api/* e o fallback do ASSETS). Os arquivos estáticos saem direto do
   asset layer, com os mesmos valores em public/_headers; o teste
   test/security-headers.test.mjs mantém os dois lados iguais. A CSP só
   libera o próprio domínio; o script inline do tema entra por hash sha256,
   então qualquer mudança nele exige recalcular o hash aqui e em
   public/_headers. HSTS com includeSubDomains: tire se algum subdomínio
   deste host ainda responder em HTTP.

   Cross-Origin-*: COOP `same-origin` corta o vínculo de janela com outras
   origens; COEP `require-corp` só deixa entrar recurso que autorize via
   CORP/CORS (a tela usa apenas recursos da própria origem); CORP
   `same-origin` impede que outra origem carregue estes arquivos. Juntos,
   permitem cross-origin isolation caso alguma API nova peça. */
export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'sha256-Lj2WKDYwirWpwwWlu/sg1rb/O+jVjFgt7nf3TTIjDa4='",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), clipboard-write=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
export function fail(message, status = 400) { return json({ error: String(message) }, status); }
