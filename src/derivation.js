import BTC from './btc-core.js';

/* Derivação pública (CKDpub) e endereços dos quatro tipos de conta.
   Tudo local; a xpub é a única entrada. */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const TYPE_INFO = {
  bip86: { label: 'bip86 · taproot (p2tr)', purpose: 86, kind: 'p2tr' },
  bip84: { label: 'bip84 · segwit (p2wpkh)', purpose: 84, kind: 'p2wpkh' },
  bip49: { label: 'bip49 · segwit aninhado (p2sh-p2wpkh)', purpose: 49, kind: 'p2sh-p2wpkh' },
  bip44: { label: 'bip44 · legacy (p2pkh)', purpose: 44, kind: 'p2pkh' }
};

function hex(b) { return BTC.bytesToHex(b); }
function fromHex(h) { return BTC.hexToBytes(h); }
function bytes() { return BTC.concatBytes.apply(null, arguments); }

export function b58decode(text) {
  const s = String(text).trim();
  let n = 0n;
  for (let i = 0; i < s.length; i++) {
    const d = B58.indexOf(s[i]);
    if (d < 0) throw new Error('xpub com caractere inválido');
    n = n * 58n + BigInt(d);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const out = n ? fromHex(h) : new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return bytes(new Uint8Array(zeros), out);
}

function readBE32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function be32(v) {
  return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

export function parseXpub(text) {
  const raw = b58decode(text);
  if (raw.length !== 82) throw new Error('xpub com tamanho inválido');
  const payload = raw.subarray(0, 78);
  const chk = raw.subarray(78);
  const want = BTC.sha256(BTC.sha256(payload)).subarray(0, 4);
  if (hex(chk) !== hex(want)) throw new Error('checksum da xpub inválido');
  const version = readBE32(raw, 0);
  if (version === 0x0488ade4) {
    throw new Error('isso é uma xprv (chave privada), não uma xpub');
  }
  let versionType;
  if (version === 0x0488b21e) versionType = 'xpub';
  else if (version === 0x04b24746) versionType = 'bip84';
  else if (version === 0x049d7cb2) versionType = 'bip49';
  else throw new Error('versão de xpub não suportada (use xpub, zpub ou ypub mainnet)');
  if (raw[4] !== 3) throw new Error('use a xpub da conta (profundidade 3), não a raiz');
  const pub = raw.subarray(45, 78);
  if (pub[0] !== 2 && pub[0] !== 3) throw new Error('chave pública da xpub inválida');
  return {
    pub,
    chain: raw.subarray(13, 45),
    depth: raw[4],
    parentFp: raw.subarray(5, 9),
    child: readBE32(raw, 9),
    versionType
  };
}

export function parsePoint(pub) {
  if (pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) throw new Error('ponto inválido');
  const x = BigInt('0x' + hex(pub.subarray(1)));
  let Q = BTC.liftX(x);
  if (!Q) throw new Error('ponto inválido');
  if ((pub[0] & 1) !== Number(Q.y & 1n)) Q = { x: Q.x, y: BTC.P - Q.y };
  return Q;
}

export async function ckdPub(node, index) {
  if (index >= 0x80000000) throw new Error('índice endurecido não é possível com xpub');
  const data = bytes(node.pub, be32(index));
  const I = await BTC.hmacSha512(node.chain, data);
  const il = BigInt('0x' + hex(I.subarray(0, 32)));
  if (il >= BTC.N) throw new Error('derivação BIP32 inválida');
  const Pp = parsePoint(node.pub);
  const Q = BTC.toAffine(BTC.jAdd(BTC.jMul(il), [Pp.x, Pp.y, 1n]));
  if (!Q) throw new Error('derivação BIP32 inválida');
  return {
    pub: BTC.pubCompressed(Q),
    chain: I.subarray(32),
    depth: node.depth + 1,
    parentFp: BTC.hash160(node.pub).subarray(0, 4),
    child: index
  };
}

export function p2pkhAddress(node) {
  return BTC.base58check(bytes(Uint8Array.of(0x00), BTC.hash160(node.pub)));
}
export function p2wpkhScript(node) {
  return bytes(Uint8Array.of(0x00, 0x14), BTC.hash160(node.pub));
}
export function p2wpkhAddress(node) {
  return BTC.segwitAddress('bc', 0, BTC.hash160(node.pub));
}
export function p2shP2wpkhScript(node) {
  return bytes(Uint8Array.of(0xa9, 0x14), BTC.hash160(p2wpkhScript(node)), Uint8Array.of(0x87));
}
export function p2shP2wpkhAddress(node) {
  return BTC.base58check(bytes(Uint8Array.of(0x05), BTC.hash160(p2wpkhScript(node))));
}
export function p2pkhScript(node) {
  return bytes(Uint8Array.of(0x76, 0xa9, 0x14), BTC.hash160(node.pub), Uint8Array.of(0x88, 0xac));
}
export function p2trScript(node) {
  return bytes(Uint8Array.of(0x51, 0x20), BTC.taprootOutputKey(node.pub.subarray(1)));
}
export function p2trAddress(node) {
  return BTC.segwitAddress('bc', 1, BTC.taprootOutputKey(node.pub.subarray(1)));
}

export function addressForType(type, node) {
  if (type === 'bip84') return p2wpkhAddress(node);
  if (type === 'bip49') return p2shP2wpkhAddress(node);
  if (type === 'bip44') return p2pkhAddress(node);
  return p2trAddress(node);
}
export function scriptForType(type, node) {
  if (type === 'bip84') return p2wpkhScript(node);
  if (type === 'bip49') return p2shP2wpkhScript(node);
  if (type === 'bip44') return p2pkhScript(node);
  return p2trScript(node);
}

export function pathFor(type, chain, index) {
  const p = TYPE_INFO[type] ? TYPE_INFO[type].purpose : 86;
  return "m/" + p + "'/0'/0'/" + chain + "/" + index;
}

export async function chainNode(account, chain) {
  if (chain !== 0 && chain !== 1) throw new Error('cadeia inválida');
  return ckdPub(account, chain);
}

export async function deriveChild(type, chainNodeValue, chain, index) {
  const child = await ckdPub(chainNodeValue, index);
  return {
    address: addressForType(type, child),
    pub: child.pub,
    script: scriptForType(type, child),
    path: pathFor(type, chain, index)
  };
}

export async function deriveAddress(type, account, chain, index) {
  const cn = await chainNode(account, chain);
  return deriveChild(type, cn, chain, index);
}
