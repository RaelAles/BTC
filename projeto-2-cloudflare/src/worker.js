import {
  parseXpub, chainNode, deriveChild, deriveAddress, addressForType,
  TYPE_INFO, pathFor
} from './derivation.js';
import {
  DEFAULT_SERVERS, openElectrum, parseServerList, statsMany
} from './electrum.js';

/* Projeto 2 — Fase 1 no Cloudflare + Electrum (fase 2).
   - xpub é a credencial (hash SHA-256 no D1)
   - D1 guarda os endereços públicos derivados e o próximo índice
   - saldo: Electrum (uma conexão TCP/TLS, consulta por scripthash) quando
     disponível; senão blockchain.info (pkh) + Blockstream/mempool (Esplora)
   - "próximo endereço" é o último usado + 1 (convenção BIP); quando o atual
     recebe, o refresh avança.
   Sem chave privada em lugar nenhum. */

const GAP = 20;          // endereços seguidos sem uso para parar a varredura
const MAX_SCAN = 120;    // teto de segurança da varredura
const WINDOW = 20;       // endereços por rodada (uma consulta em lote)
const PROVIDERS = [
  { name: 'blockstream.info', base: 'https://blockstream.info/api' },
  { name: 'mempool.space', base: 'https://mempool.space/api' }
];

function now() { return new Date().toISOString(); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function fail(message, status = 400) { return json({ error: String(message) }, status); }

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'btc-projeto-2/1.0', 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + url);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Config do Electrum: ELECTRUM_SERVERS="host:porta[:tls|:tcp],..." ("off" desliga),
   ELECTRUM_TIMEOUT_MS, EXTRAS_UNION=off para não varrer os outros tipos. */
function electrumConfig(env) {
  const raw = env && env.ELECTRUM_SERVERS;
  const text = raw == null ? '' : String(raw).trim();
  if (/^(off|0|false|no)$/i.test(text)) return null;
  let servers;
  try { servers = text ? parseServerList(text) : DEFAULT_SERVERS; }
  catch (e) { return null; }
  return {
    servers,
    timeoutMs: Number((env && env.ELECTRUM_TIMEOUT_MS) || 8000),
    union: !/^(off|0|false|no)$/i.test(String((env && env.EXTRAS_UNION) || 'on'))
  };
}

/* Esplora (Blockstream, fallback mempool.space). */
async function esplora(path) {
  let last = null;
  for (const p of PROVIDERS) {
    try { return await fetchJson(p.base + path); }
    catch (e) { last = e; }
  }
  throw last || new Error('Esplora indisponível');
}
async function addressStats(address) {
  const s = await esplora('/address/' + encodeURIComponent(address));
  const c = s.chain_stats || {};
  const m = s.mempool_stats || {};
  return {
    txCount: (c.tx_count || 0) + (m.tx_count || 0),
    funded: (c.funded_txo_sum || 0) + (m.funded_txo_sum || 0),
    spent: (c.spent_txo_sum || 0) + (m.spent_txo_sum || 0),
    balance: (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0) +
      (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0)
  };
}

/* Saldo de uma lista de endereços derivados ({address, script}): Electrum numa
   conexão só; se ele cair, Esplora endereço por endereço. `ctx` é mutável e
   carrega o cliente, a falha e as fontes efetivamente usadas. */
async function readStats(ctx, entries) {
  if (ctx.client && !ctx.dead && entries.length) {
    try {
      const stats = await statsMany(ctx.client, entries.map(e => e.script));
      ctx.usedElectrum = true;
      return stats;
    } catch (e) {
      ctx.dead = e && e.message ? e.message : String(e);
      ctx.failures.push(ctx.dead);
    }
  }
  const out = [];
  for (const e of entries) out.push(await addressStats(e.address));
  ctx.usedEsplora = true;
  return out;
}

/* blockchain.info/xpub: histórico BIP44/p2pkh completo em uma consulta. */
async function fetchBip44(xpub) {
  return await fetchJson(
    'https://blockchain.info/xpub/' + encodeURIComponent(xpub) + '?format=json',
    25000
  );
}

function parseBip44(j, xpub) {
  const by = new Map();
  for (const tx of (j.txs || [])) {
    for (const o of (tx.out || [])) {
      const x = o.xpub;
      if (!x || x.m !== xpub || !x.path) continue;
      const m = /^M\/(\d+)\/(\d+)$/.exec(x.path);
      if (!m) continue;
      const chain = Number(m[1]);
      const idx = Number(m[2]);
      const key = chain + ':' + idx;
      let e = by.get(key);
      if (!e) {
        e = { chain, index: idx, address: o.addr, balance: 0, received: 0, hashes: new Set() };
        by.set(key, e);
      }
      e.received += Number(o.value || 0);
      if (!o.spent) e.balance += Number(o.value || 0);
      e.hashes.add(tx.hash);
    }
  }
  const addresses = [...by.values()].map(e => ({
    chain: e.chain, index: e.index, address: e.address,
    balance: e.balance, received: e.received, txCount: e.hashes.size, used: 1
  }));
  addresses.sort((a, b) => a.chain - b.chain || a.index - b.index);
  let max0 = -1, max1 = -1, sum = 0;
  for (const e of addresses) {
    sum += e.balance;
    if (e.chain === 0) max0 = Math.max(max0, e.index);
    else max1 = Math.max(max1, e.index);
  }
  return {
    balance: Number(j.final_balance || 0),
    totalReceived: Number(j.total_received || 0),
    nTx: Number(j.n_tx || 0),
    addresses,
    sum,
    nextReceive: max0 + 1,
    nextChange: max1 + 1
  };
}

/* Detecta o tipo: zpub/ypub pela versão; xpub pelo histórico BIP44 e,
   se não houver, pelo primeiro endereço de p2tr/p2wpkh/p2sh. */
async function detectType(account, xpub, ctx) {
  if (account.versionType === 'bip84' || account.versionType === 'bip49') {
    return { type: account.versionType, bip44: null };
  }
  let b44 = null;
  try { b44 = await fetchBip44(xpub); ctx.usedBci = true; } catch (e) {}
  if (b44 && ((Number(b44.n_tx) || 0) > 0 || (Number(b44.final_balance) || 0) > 0)) {
    return { type: 'bip44', bip44: b44 };
  }
  const order = ['bip86', 'bip84', 'bip49'];
  const candidates = [];
  for (const type of order) candidates.push(await deriveAddress(type, account, 0, 0));
  let stats;
  try { stats = await readStats(ctx, candidates); } catch (e) { stats = []; }
  for (let i = 0; i < order.length; i++) {
    const s = stats[i];
    if (s && (s.txCount > 0 || s.balance > 0)) return { type: order[i], bip44: null };
  }
  return { type: 'bip86', bip44: null };
}

async function getWallet(env, hash) {
  return await env.DB.prepare('SELECT * FROM wallets WHERE xpub_hash = ?').bind(hash).first();
}
async function insertWallet(env, hash, xpub, account, type) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO wallets (xpub_hash, xpub, version_type, account_type, next_receive, next_change, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).bind(hash, xpub, account.versionType, type, t, t).run();
  return await getWallet(env, hash);
}
async function setWallet(env, hash, type, nextReceive, nextChange, balance) {
  await env.DB.prepare(
    `UPDATE wallets SET account_type = ?, next_receive = ?, next_change = ?, balance = ?, updated_at = ? WHERE xpub_hash = ?`
  ).bind(type, nextReceive, nextChange, balance, now(), hash).run();
}

function addressStatement(env, hash, type, chain, idx, address, used, balance, received, txCount) {
  return env.DB.prepare(
    `INSERT INTO addresses (xpub_hash, account_type, chain, idx, address, used, balance, received, tx_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (xpub_hash, account_type, chain, idx) DO UPDATE SET
       address = excluded.address, used = excluded.used, balance = excluded.balance,
       received = excluded.received, tx_count = excluded.tx_count, updated_at = excluded.updated_at`
  ).bind(hash, type, chain, idx, address, used ? 1 : 0, balance, received, txCount, now());
}

async function getAddresses(env, hash) {
  const r = await env.DB.prepare(
    'SELECT * FROM addresses WHERE xpub_hash = ? ORDER BY account_type, chain, idx'
  ).bind(hash).all();
  return r.results || [];
}

/* BIP44: usa o xpub completo do blockchain.info; grava os usados. */
async function refreshBip44(env, hash, xpub, account, b44) {
  const parsed = parseBip44(b44, xpub);
  const stmts = [];
  for (const e of parsed.addresses) {
    stmts.push(addressStatement(env, hash, 'bip44', e.chain, e.index, e.address,
      1, e.balance, e.received, e.txCount));
  }
  const recv = await deriveAddress('bip44', account, 0, parsed.nextReceive);
  const change = await deriveAddress('bip44', account, 1, parsed.nextChange);
  stmts.push(addressStatement(env, hash, 'bip44', 0, parsed.nextReceive, recv.address, 0, 0, 0, 0));
  stmts.push(addressStatement(env, hash, 'bip44', 1, parsed.nextChange, change.address, 0, 0, 0, 0));
  if (stmts.length) await env.DB.batch(stmts);
  await setWallet(env, hash, 'bip44', parsed.nextReceive, parsed.nextChange, parsed.balance);
  return { parsed, recv, change };
}

/* Varre /0/* e /1/* até GAP seguidos sem uso, em janelas de WINDOW endereços
   (uma rodada = um lote de consultas). Devolve os usados e o próximo índice. */
async function scanChain(ctx, account, type, chain) {
  const cn = await chainNode(account, chain);
  const used = [];
  let total = 0, lastUsed = -1, consecutive = 0, idx = 0;
  while (consecutive < GAP && idx < MAX_SCAN) {
    const window = [];
    const size = Math.min(WINDOW, MAX_SCAN - idx);
    for (let k = 0; k < size; k++) window.push(await deriveChild(type, cn, chain, idx + k));
    const stats = await readStats(ctx, window);
    let stop = false;
    for (let k = 0; k < window.length; k++) {
      const s = stats[k] || { txCount: 0, balance: 0, funded: null };
      if (s.txCount > 0) {
        consecutive = 0;
        lastUsed = idx + k;
        total += s.balance;
        used.push({
          index: idx + k, address: window[k].address, balance: s.balance,
          funded: s.funded == null ? s.balance : s.funded, txCount: s.txCount
        });
      } else {
        consecutive++;
      }
      if (consecutive >= GAP) { stop = true; break; }
    }
    idx += window.length;
    if (stop) break;
    if (idx >= MAX_SCAN && consecutive < GAP) {
      throw new Error('varredura passou do teto de ' + MAX_SCAN + ' endereços');
    }
  }
  const next = lastUsed + 1;
  const nextAddress = await deriveChild(type, cn, chain, next);
  return { chain, used, total, next, address: nextAddress.address, path: nextAddress.path };
}

/* bip86/bip84/bip49: varre /0/* e /1/* do tipo detectado. */
async function refreshScan(env, hash, xpub, account, type, ctx) {
  const stmts = [];
  const perChain = [];
  let total = 0;
  for (const chain of [0, 1]) {
    const r = await scanChain(ctx, account, type, chain);
    total += r.total;
    for (const u of r.used) {
      stmts.push(addressStatement(env, hash, type, chain, u.index, u.address, 1,
        u.balance, u.funded, u.txCount));
    }
    stmts.push(addressStatement(env, hash, type, chain, r.next, r.address, 0, 0, 0, 0));
    perChain[chain] = { next: r.next, address: r.address, path: r.path };
  }
  if (stmts.length) await env.DB.batch(stmts);
  await setWallet(env, hash, type, perChain[0].next, perChain[1].next, total);
  return { nextReceive: perChain[0].next, nextChange: perChain[1].next, total, perChain };
}

/* Outros tipos. Com Electrum: união completa (varredura com gap nos dois
   ramos de cada tipo). Sem Electrum: só o /0/0, para não explodir subrequests. */
async function refreshExtras(env, hash, account, detected, ctx) {
  const extras = [];
  const stmts = [];
  let total = 0;
  const union = !!(ctx && ctx.client && !ctx.dead && ctx.union !== false);
  for (const type of Object.keys(TYPE_INFO)) {
    if (type === detected) continue;
    try {
      if (union) {
        const r0 = await scanChain(ctx, account, type, 0);
        const r1 = await scanChain(ctx, account, type, 1);
        const used = r0.used.concat(r1.used);
        if (!used.length) continue;
        total += r0.total + r1.total;
        extras.push({
          type, label: TYPE_INFO[type].label, address: r0.address, path: r0.path,
          balance: r0.total + r1.total,
          txCount: used.reduce((s, u) => s + u.txCount, 0)
        });
        for (const u of r0.used) {
          stmts.push(addressStatement(env, hash, type, 0, u.index, u.address, 1,
            u.balance, u.funded, u.txCount));
        }
        for (const u of r1.used) {
          stmts.push(addressStatement(env, hash, type, 1, u.index, u.address, 1,
            u.balance, u.funded, u.txCount));
        }
        stmts.push(addressStatement(env, hash, type, 0, r0.next, r0.address, 0, 0, 0, 0));
      } else {
        const a = await deriveAddress(type, account, 0, 0);
        const s = (await readStats(ctx, [a]))[0];
        total += s.balance;
        extras.push({
          type, label: TYPE_INFO[type].label, address: a.address, path: a.path,
          balance: s.balance, txCount: s.txCount
        });
        stmts.push(addressStatement(env, hash, type, 0, 0, a.address,
          s.txCount > 0 ? 1 : 0, s.balance, s.funded == null ? s.balance : s.funded, s.txCount));
      }
    } catch (e) {}
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { extras, total, union };
}

/* Texto da fonte efetivamente usada nesta consulta. */
function sourceText(ctx) {
  const parts = [];
  if (ctx.usedElectrum) parts.push('electrum (scripthash)');
  if (ctx.usedBci) parts.push('blockchain.info (bip44)');
  if (ctx.usedEsplora) parts.push('blockstream.info/mempool.space (Esplora)');
  return parts.length ? parts.join(' + ') : 'nenhuma fonte consultada';
}

function warningsFor(ctx) {
  const w = [];
  if (ctx.union) {
    w.push('União dos quatro tipos completa: varredura com gap de ' + GAP +
      ' endereços por ramo, tudo numa conexão Electrum.');
  } else {
    w.push('Os outros tipos mostram apenas o primeiro endereço (/0/0); a união completa exige Electrum.');
  }
  if (ctx.failures.length) {
    w.push('Electrum indisponível (' + ctx.failures[0] + '); o saldo veio do Esplora/blockchain.info.');
  }
  if (ctx.usedElectrum) {
    w.push('O servidor Electrum público vê os scripthashes consultados; "total recebido" por endereço não vem dele.');
  }
  w.push('O bitcoin.com não tem API pública de saldo; a fonte é blockchain.info para pkh e Blockstream/mempool para os demais.');
  return w;
}

function responseWallet(wallet, account, recv, change, extras, addresses, warnings, source) {
  const detected = TYPE_INFO[wallet.account_type] || { label: wallet.account_type };
  const extraTotal = extras.reduce((s, e) => s + e.balance, 0);
  return {
    version: 1,
    xpub_hash: wallet.xpub_hash,
    detected_type: wallet.account_type,
    detected_label: detected.label,
    version_type: wallet.version_type,
    receive: recv ? { address: recv.address, path: recv.path } : null,
    change: change ? { address: change.address, path: change.path } : null,
    balance: {
      detected: Number(wallet.balance || 0),
      extras: extraTotal,
      total: Number(wallet.balance || 0) + extraTotal
    },
    extras,
    addresses,
    warnings,
    source: source || 'blockchain.info (pkh) + blockstream.info/mempool.space (demais)',
    updated_at: wallet.updated_at
  };
}

async function handleWallet(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail('json inválido'); }
  const xpub = String(body.xpub || '').trim();
  if (!xpub) return fail('informe a xpub');
  let account;
  try { account = parseXpub(xpub); }
  catch (e) { return fail(e.message); }
  const hash = await sha256Hex(xpub);

  const ctx = {
    client: null, dead: null, failures: [], union: true,
    usedElectrum: false, usedEsplora: false, usedBci: false
  };
  const cfg = electrumConfig(env);
  if (cfg) {
    ctx.union = cfg.union;
    try {
      ctx.client = await openElectrum({ servers: cfg.servers, timeoutMs: cfg.timeoutMs });
    } catch (e) {
      ctx.failures.push(e && e.message ? e.message : String(e));
    }
  }

  try {
    let wallet = await getWallet(env, hash);
    let b44 = null;
    if (!wallet) {
      const det = await detectType(account, xpub, ctx);
      b44 = det.bip44;
      wallet = await insertWallet(env, hash, xpub, account, det.type);
    }
    const type = wallet.account_type;
    let recv, change;
    if (type === 'bip44') {
      if (!b44) {
        try { b44 = await fetchBip44(xpub); ctx.usedBci = true; }
        catch (e) { return fail('blockchain.info indisponível para a conta bip44: ' + e.message, 502); }
      }
      const r = await refreshBip44(env, hash, xpub, account, b44);
      wallet = await getWallet(env, hash);
      recv = r.recv; change = r.change;
    } else {
      const r = await refreshScan(env, hash, xpub, account, type, ctx);
      wallet = await getWallet(env, hash);
      recv = r.perChain[0];
      change = r.perChain[1];
    }
    const ex = await refreshExtras(env, hash, account, type, ctx);
    const addresses = await getAddresses(env, hash);
    return json(responseWallet(wallet, account, recv, change, ex.extras, addresses,
      warningsFor(ctx), sourceText(ctx)));
  } finally {
    if (ctx.client) { try { await ctx.client.close(); } catch (e) {} }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/health') {
        const cfg = electrumConfig(env);
        return json({
          ok: true,
          service: 'projeto-2-fase-2',
          electrum: cfg ? cfg.servers.map(s => s.host + ':' + s.port + (s.secure ? ' tls' : ' tcp')) : 'off',
          union: cfg ? cfg.union : false,
          time: now()
        });
      }
      if (url.pathname === '/api/wallet') {
        if (request.method !== 'POST') return fail('use POST', 405);
        return await handleWallet(request, env);
      }
      if (url.pathname.startsWith('/api/')) {
        return fail('rota não encontrada', 404);
      }
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response('not found', { status: 404 });
    } catch (e) {
      return fail(e && e.message ? e.message : String(e), 500);
    }
  }
};
