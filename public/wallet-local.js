/* Gerado por scripts/sync-browser-core.mjs; não edite à mão.
   Scanner, UTXOs, PSBT e CPFP locais; o Worker é só proxy. */
(function (global) {
'use strict';
/* Núcleo BTC extraído da UI standalone antiga (projeto-2.html), sem DOM. */
'use strict';
/* Núcleo criptográfico independente: SHA-256, RIPEMD-160, HMAC, secp256k1,
   Base58Check, Bech32/Bech32m, ECDSA determinístico (RFC 6979). Sem DOM. */
var BTC = (function () {
  /* ------------------------------------------------------------- bytes */
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function hexToBytes(h) {
    h = String(h).replace(/[^0-9a-fA-F]/g, '');
    if (h.length % 2) h = '0' + h;
    var o = new Uint8Array(h.length / 2);
    for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
    return o;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
  function concatBytes() {
    var len = 0, i, j = 0, out;
    for (i = 0; i < arguments.length; i++) len += arguments[i].length;
    out = new Uint8Array(len);
    for (i = 0; i < arguments.length; i++) { out.set(arguments[i], j); j += arguments[i].length; }
    return out;
  }
  function be32(v) {
    return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  }
  function le32(v) {
    return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  }
  function wordsToBytesBE(w) {
    var out = new Uint8Array(w.length * 4), i;
    for (i = 0; i < w.length; i++) out.set(be32(w[i] >>> 0), i * 4);
    return out;
  }

  /* ----------------------------------------------------------- SHA-256 */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256(msg) {
    var l = msg.length;
    var total = (((l + 9) + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[l] = 0x80;
    var bitsHi = Math.floor(l / 536870912);
    var bitsLo = (l << 3) >>> 0;
    buf.set(be32(bitsHi), total - 8);
    buf.set(be32(bitsLo), total - 4);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        W[i] = (buf[off + i * 4] << 24) | (buf[off + i * 4 + 1] << 16) | (buf[off + i * 4 + 2] << 8) | buf[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var x = W[i - 15], y = W[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return wordsToBytesBE(H);
  }

  /* --------------------------------------------------------- RIPEMD-160 */
  var RMD_R = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13
  ];
  var RMD_RR = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11
  ];
  var RMD_S = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6
  ];
  var RMD_SS = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11
  ];
  var RMD_KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
  var RMD_KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];
  function rol32(x, n) { return ((x << n) | (x >>> (32 - n))) | 0; }
  function rmdF(j, x, y, z) {
    switch (j) {
      case 0: return (x ^ y ^ z) | 0;
      case 1: return ((x & y) | (~x & z)) | 0;
      case 2: return ((x | ~y) ^ z) | 0;
      case 3: return ((x & z) | (y & ~z)) | 0;
      default: return (x ^ (y | ~z)) | 0;
    }
  }
  function ripemd160(msg) {
    var l = msg.length;
    var total = (((l + 9) + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(msg);
    buf[l] = 0x80;
    var bitsLo = (l << 3) >>> 0;
    var bitsHi = Math.floor(l / 536870912);
    buf.set(le32(bitsLo), total - 8);
    buf.set(le32(bitsHi), total - 4);
    var H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    var X = new Array(16);
    for (var off = 0; off < total; off += 64) {
      var i, j;
      for (i = 0; i < 16; i++) {
        X[i] = buf[off + i * 4] | (buf[off + i * 4 + 1] << 8) | (buf[off + i * 4 + 2] << 16) | (buf[off + i * 4 + 3] << 24);
      }
      var al = H[0], bl = H[1], cl = H[2], dl = H[3], el = H[4];
      var ar = H[0], br = H[1], cr = H[2], dr = H[3], er = H[4];
      for (j = 0; j < 80; j++) {
        var round = j >> 4;
        var tl = (rol32((al + rmdF(round, bl, cl, dl) + X[RMD_R[j]] + RMD_KL[round]) | 0, RMD_S[j]) + el) | 0;
        al = el; el = dl; dl = rol32(cl, 10); cl = bl; bl = tl;
        var tr = (rol32((ar + rmdF(4 - round, br, cr, dr) + X[RMD_RR[j]] + RMD_KR[round]) | 0, RMD_SS[j]) + er) | 0;
        ar = er; er = dr; dr = rol32(cr, 10); cr = br; br = tr;
      }
      var t = (H[1] + cl + dr) | 0;
      H[1] = (H[2] + dl + er) | 0;
      H[2] = (H[3] + el + ar) | 0;
      H[3] = (H[4] + al + br) | 0;
      H[4] = (H[0] + bl + cr) | 0;
      H[0] = t;
    }
    var out = new Uint8Array(20);
    for (var k = 0; k < 5; k++) out.set(le32(H[k] >>> 0), k * 4);
    return out;
  }
  function hash160(b) { return ripemd160(sha256(b)); }

  /* ---------------------------------------------------------------- HMAC */
  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64), i;
    ipad.fill(0x36); opad.fill(0x5c);
    for (i = 0; i < key.length; i++) { ipad[i] ^= key[i]; opad[i] ^= key[i]; }
    return sha256(concatBytes(opad, sha256(concatBytes(ipad, msg))));
  }

  /* ------------------------------------------------------------ secp256k1 */
  var P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  var N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  var GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  var GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  function mod(a, m) { var r = a % (m || P); return r < 0n ? r + (m || P) : r; }
  function powMod(b, e, m) {
    var r = 1n; b = mod(b, m);
    while (e > 0n) { if (e & 1n) r = mod(r * b, m); b = mod(b * b, m); e >>= 1n; }
    return r;
  }
  function invMod(a, m) {
    var oldR = mod(a, m), r = m, oldS = 1n, s = 0n;
    while (r !== 0n) {
      var q = oldR / r;
      var nr = oldR - q * r; oldR = r; r = nr;
      var ns = oldS - q * s; oldS = s; s = ns;
    }
    if (oldR !== 1n) throw new Error('sem inverso modular');
    return mod(oldS, m);
  }
  function jDouble(p) {
    var X = p[0], Y = p[1], Z = p[2];
    if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
    var Y2 = mod(Y * Y), S = mod(4n * X * Y2), M = mod(3n * X * X);
    var X3 = mod(M * M - 2n * S);
    var Y3 = mod(M * (S - X3) - 8n * Y2 * Y2);
    var Z3 = mod(2n * Y * Z);
    return [X3, Y3, Z3];
  }
  function jAdd(p, q) {
    if (p[2] === 0n) return q;
    if (q[2] === 0n) return p;
    var Z1Z1 = mod(p[2] * p[2]), Z2Z2 = mod(q[2] * q[2]);
    var U1 = mod(p[0] * Z2Z2), U2 = mod(q[0] * Z1Z1);
    var S1 = mod(p[1] * q[2] * Z2Z2), S2 = mod(q[1] * p[2] * Z1Z1);
    if (U1 === U2) {
      if (S1 !== S2) return [0n, 1n, 0n];
      return jDouble(p);
    }
    var H = mod(U2 - U1), I = mod(4n * H * H), J = mod(H * I);
    var r = mod(2n * (S2 - S1)), V = mod(U1 * I);
    var X3 = mod(r * r - J - 2n * V);
    var Y3 = mod(r * (V - X3) - 2n * S1 * J);
    var Z3 = mod(((p[2] + q[2]) * (p[2] + q[2]) - Z1Z1 - Z2Z2) * H);
    return [X3, Y3, Z3];
  }
  function jMul(k, pt) {
    var base = pt || { x: GX, y: GY };
    var r = [0n, 1n, 0n], q = [base.x, base.y, 1n];
    while (k > 0n) {
      if (k & 1n) r = jAdd(r, q);
      q = jDouble(q);
      k >>= 1n;
    }
    return r;
  }
  function toAffine(p) {
    if (!p || p[2] === 0n) return null;
    var zi = invMod(p[2], P), zi2 = mod(zi * zi);
    return { x: mod(p[0] * zi2), y: mod(p[1] * zi2 * zi) };
  }
  function pad32(v) {
    var h = v.toString(16);
    while (h.length < 64) h = '0' + h;
    return hexToBytes(h);
  }
  function pointFromD(d) {
    if (d <= 0n || d >= N) throw new Error('chave privada fora do intervalo 1…n-1');
    return toAffine(jMul(d));
  }
  function pubCompressed(Q) {
    return concatBytes(new Uint8Array([Q.y & 1n ? 3 : 2]), pad32(Q.x));
  }
  function pubUncompressed(Q) {
    return concatBytes(new Uint8Array([4]), pad32(Q.x), pad32(Q.y));
  }
  function liftX(x) {
    if (x <= 0n || x >= P) return null;
    var y2 = mod(x * x * x + 7n);
    var y = powMod(y2, (P + 1n) / 4n, P);
    if (mod(y * y) !== y2) return null;
    if (y & 1n) y = P - y;
    return { x: x, y: y };
  }
  function taggedHash(tag, data) {
    var t = sha256(utf8(tag));
    return sha256(concatBytes(t, t, data));
  }
  /* BIP341/BIP86: chave de saída = P + int(taggedHash("TapTweak", x(P)))·G,
     com P = lift_x(x) de ordenada par. Sem árvore de script (key path). */
  function taprootOutputKey(xonly) {
    var Ppt = liftX(BigInt('0x' + bytesToHex(xonly)));
    if (!Ppt) throw new Error('ponto inválido para taproot');
    var t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', xonly)));
    if (t >= N) throw new Error('tweak taproot inválido');
    var Q = toAffine(jAdd(jMul(t), [Ppt.x, Ppt.y, 1n]));
    return pad32(Q.x);
  }

  /* ---------------------------------------------------------- Base58Check */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Encode(bytes) {
    var digits = [0], i, j, carry;
    for (i = 0; i < bytes.length; i++) {
      carry = bytes[i];
      for (j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
    for (i = digits.length - 1; i >= 0; i--) out += B58.charAt(digits[i]);
    return out;
  }
  function base58check(payload) {
    var check = sha256(sha256(payload)).subarray(0, 4);
    return base58Encode(concatBytes(payload, check));
  }
  function base58Decode(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) throw new Error('endereço vazio');
    /* Decodificação quadrática no tamanho: recusa antes de qualquer conta. */
    if (s.length > 128) throw new Error('endereço base58 grande demais');
    var n = 0n;
    for (var i = 0; i < s.length; i++) {
      var d = B58.indexOf(s[i]);
      if (d < 0) throw new Error('endereço com caractere inválido');
      n = n * 58n + BigInt(d);
    }
    var h = n.toString(16);
    if (h.length % 2) h = '0' + h;
    var out = n ? hexToBytes(h) : new Uint8Array(0);
    var zeros = 0;
    while (zeros < s.length && s[zeros] === '1') zeros++;
    return concatBytes(new Uint8Array(zeros), out);
  }
  function base58checkDecode(text) {
    var raw = base58Decode(text);
    if (raw.length < 5) throw new Error('endereço base58 truncado');
    var payload = raw.subarray(0, raw.length - 4);
    var check = raw.subarray(raw.length - 4);
    var want = sha256(sha256(payload)).subarray(0, 4);
    if (bytesToHex(check) !== bytesToHex(want)) throw new Error('checksum do endereço inválido');
    return payload;
  }
  function wif(d, compressed) {
    var key = pad32(d);
    return base58check(concatBytes(new Uint8Array([0x80]), key, compressed ? new Uint8Array([1]) : new Uint8Array(0)));
  }
  function p2pkh(pub) {
    return base58check(concatBytes(new Uint8Array([0x00]), hash160(pub)));
  }
  function p2shP2wpkh(pub) {
    var redeem = concatBytes(new Uint8Array([0x00, 0x14]), hash160(pub));
    return base58check(concatBytes(new Uint8Array([0x05]), hash160(redeem)));
  }

  /* ------------------------------------------------------ Bech32 / Bech32m */
  var B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function bechPolymod(values) {
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1, i, j;
    for (i = 0; i < values.length; i++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[i];
      for (j = 0; j < 5; j++) if ((top >>> j) & 1) chk ^= GEN[j];
    }
    return chk;
  }
  function bechHrpExpand(hrp) {
    var out = [], i;
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }
  function convertBits(data, from, to, pad) {
    var acc = 0, bits = 0, out = [], maxv = (1 << to) - 1, i;
    for (i = 0; i < data.length; i++) {
      acc = (acc << from) | data[i];
      bits += from;
      while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
    }
    if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
    else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return out;
  }
  function segwitAddress(hrp, version, program) {
    var data = [version].concat(convertBits(program, 8, 5, true));
    var constant = version === 0 ? 1 : 0x2bc830a3;
    var values = bechHrpExpand(hrp).concat(data);
    var polymod = bechPolymod(values.concat([0, 0, 0, 0, 0, 0])) ^ constant;
    var checksum = [];
    for (var i = 0; i < 6; i++) checksum.push((polymod >>> (5 * (5 - i))) & 31);
    return hrp + '1' + data.concat(checksum).map(function (d) { return B32.charAt(d); }).join('');
  }
  function p2wpkh(pub) {
    return segwitAddress('bc', 0, hash160(pub));
  }
  function p2tr(xonly) {
    return segwitAddress('bc', 1, xonly);
  }
  function segwitDecode(address) {
    var s = String(address == null ? '' : address).trim();
    if (!s) throw new Error('endereço vazio');
    var lower = s.toLowerCase();
    if (s !== lower && s !== s.toUpperCase()) {
      throw new Error('endereço com maiúsculas e minúsculas misturadas');
    }
    var cut = lower.lastIndexOf('1');
    if (cut < 1) throw new Error('endereço bech32 inválido');
    var hrp = lower.slice(0, cut);
    if (hrp !== 'bc') throw new Error('endereço não é da mainnet (bc1)');
    var part = lower.slice(cut + 1);
    if (part.length < 7) throw new Error('endereço bech32 truncado');
    var data = [];
    for (var i = 0; i < part.length; i++) {
      var d = B32.indexOf(part[i]);
      if (d < 0) throw new Error('endereço bech32 com caractere inválido');
      data.push(d);
    }
    var version = data[0];
    if (version > 16) throw new Error('versão de witness inválida');
    var constant = version === 0 ? 1 : 0x2bc830a3;
    if (bechPolymod(bechHrpExpand(hrp).concat(data)) !== constant) {
      throw new Error('checksum do endereço inválido');
    }
    var program = convertBits(data.slice(1, data.length - 6), 5, 8, false);
    if (!program) throw new Error('programa witness inválido');
    if (program.length < 2 || program.length > 40) throw new Error('programa witness inválido');
    if (version === 0 && program.length !== 20 && program.length !== 32) {
      throw new Error('programa witness v0 inválido');
    }
    return { version: version, program: new Uint8Array(program) };
  }

  /* ---------------------------------------------------------- ECDSA RFC6979 */
  function bits2int(bytes) {
    var v = BigInt('0x' + (bytesToHex(bytes) || '0'));
    var excess = bytes.length * 8 - 256;
    if (excess > 0) v >>= BigInt(excess);
    return v;
  }
  function int2octets(v) { return pad32(v); }
  /* O estado K/V da RFC 6979 fica entre os candidatos: um k já devolvido não
     se repete, porque o próximo sai da continuação do mesmo HMAC. É disso que
     o laço de reserva do signDigest precisa quando r ou s sai zero. */
  function rfc6979Init(d, digest) {
    var x = int2octets(d);
    var h1 = int2octets(bits2int(digest) % N);
    var K = new Uint8Array(32);
    var V = new Uint8Array(32).fill(1);
    K = hmacSha256(K, concatBytes(V, new Uint8Array([0]), x, h1));
    V = hmacSha256(K, V);
    K = hmacSha256(K, concatBytes(V, new Uint8Array([1]), x, h1));
    V = hmacSha256(K, V);
    return { K: K, V: V };
  }
  function rfc6979Next(state) {
    for (var guard = 0; guard < 1000; guard++) {
      state.V = hmacSha256(state.K, state.V);
      var k = bits2int(state.V);
      if (k >= 1n && k < N) return k;
      state.K = hmacSha256(state.K, concatBytes(state.V, new Uint8Array([0])));
      state.V = hmacSha256(state.K, state.V);
    }
    throw new Error('RFC 6979 não convergiu');
  }
  function derInt(v) {
    var b = pad32(v), i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    if (b[0] & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  }
  function encodeDer(r, s) {
    var body = concatBytes(derInt(r), derInt(s));
    return concatBytes(new Uint8Array([0x30, body.length]), body);
  }
  function signDigest(d, digest) {
    var z = bits2int(digest) % N;
    var nonce = rfc6979Init(d, digest);
    for (var guard = 0; guard < 1000; guard++) {
      var k = rfc6979Next(nonce);
      var R = toAffine(jMul(k));
      var r = mod(R.x, N);
      if (r === 0n) continue;
      var s = mod(invMod(k, N) * (z + r * d), N);
      if (s === 0n) continue;
      var recid = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
      if (s > N / 2n) { s = N - s; recid ^= 1; }
      var rb = pad32(r), sb = pad32(s);
      return {
        r: r, s: s, recid: recid,
        der: encodeDer(r, s),
        compact: concatBytes(rb, sb, new Uint8Array([recid]))
      };
    }
    throw new Error('assinatura não convergiu');
  }
  function verifyDigest(Q, digest, r, s) {
    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
    var z = bits2int(digest) % N;
    var w = invMod(s, N);
    var u1 = mod(z * w, N), u2 = mod(r * w, N);
    var pt = toAffine(jAdd(jMul(u1), jMul(u2, Q)));
    if (!pt) return false;
    return mod(pt.x, N) === r;
  }

  /* BIP39: lista inglesa de 2.048 palavras. Os 256 bits viram uma frase de
     24 palavras; a frase e a frase secreta (passphrase opcional) entram no
     PBKDF2 que gera a seed. A entrada na tela é pela frase de 24 palavras. */
  var BIP39_WORDS = (
    'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid ' +
    'acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance ' +
    'advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album ' +
    'alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among ' +
    'amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique ' +
    'anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor ' +
    'army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume ' +
    'asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado ' +
    'avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball ' +
    'bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become ' +
    'beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle ' +
    'bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood ' +
    'blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring ' +
    'borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief ' +
    'bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb ' +
    'bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable ' +
    'cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable ' +
    'capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog ' +
    'catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk ' +
    'champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child ' +
    'chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify ' +
    'claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud ' +
    'clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine ' +
    'come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper ' +
    'copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle ' +
    'craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop ' +
    'cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious ' +
    'current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn ' +
    'day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay ' +
    'deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk ' +
    'despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital ' +
    'dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide ' +
    'divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft ' +
    'dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb ' +
    'dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ' +
    'ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator ' +
    'elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy ' +
    'energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode ' +
    'equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil ' +
    'evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit ' +
    'exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint ' +
    'faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault ' +
    'favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field ' +
    'figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness ' +
    'fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly ' +
    'foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil ' +
    'foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel ' +
    'fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment ' +
    'gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ' +
    'ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue ' +
    'goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass ' +
    'gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun ' +
    'gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard ' +
    'head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip ' +
    'hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital ' +
    'host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband ' +
    'hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose ' +
    'improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial ' +
    'inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest ' +
    'invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel ' +
    'job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup ' +
    'key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know ' +
    'lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law ' +
    'lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend ' +
    'length lens leopard lesson letter level liar liberty library license life lift light like limb limit ' +
    'link lion liquid list little live lizard load loan lobster local lock logic lonely long loop ' +
    'lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet ' +
    'maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin ' +
    'marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure ' +
    'meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message ' +
    'metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake ' +
    'mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning ' +
    'mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music ' +
    'must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative ' +
    'neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee ' +
    'noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey ' +
    'object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay ' +
    'old olive olympic omit once one onion online only open opera opinion oppose option orange orbit ' +
    'orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over ' +
    'own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper ' +
    'parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut ' +
    'pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical ' +
    'piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet ' +
    'plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony ' +
    'pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare ' +
    'present pretty prevent price pride primary print priority prison private prize problem process produce profit program ' +
    'project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil ' +
    'puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz ' +
    'quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid ' +
    'rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle ' +
    'reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove ' +
    'render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire ' +
    'retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ' +
    'ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room ' +
    'rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness ' +
    'safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say ' +
    'scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea ' +
    'search season seat second secret section security seed seek segment select sell seminar senior sense sentence ' +
    'series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ' +
    'ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side ' +
    'siege sight sign silent silk silly silver similar simple since sing siren sister situate six size ' +
    'skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan ' +
    'slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social ' +
    'sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup ' +
    'source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin ' +
    'spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium ' +
    'staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting ' +
    'stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject ' +
    'submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme ' +
    'sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim ' +
    'swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target ' +
    'task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that ' +
    'theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger ' +
    'tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token ' +
    'tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist ' +
    'toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree ' +
    'trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try ' +
    'tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ' +
    'ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown ' +
    'unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful ' +
    'useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle ' +
    'velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view ' +
    'village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote ' +
    'voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave ' +
    'way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat ' +
    'wheel when where whip whisper wide width wife wild will win window wine wing wink winner ' +
    'winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth ' +
    'wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo '
  ).trim().split(/\s+/);

  /* A lista só codifica os 256 bits na frase BIP39 usada para gerar a seed;
     o sentido inverso (palavra → 11 bits) e a checagem da frase ficam com
     quem lê a entrada, a partir desta cópia da lista. */
  function bip39Words() {
    return BIP39_WORDS.slice();
  }
  function bip39Mnemonic(bits) {
    var entropy = new Uint8Array(32);
    var i;
    for (i = 0; i < 32; i++) entropy[i] = parseInt(bits.substr(i * 8, 8), 2);
    var checksum = sha256(entropy)[0];
    var all = bits + ('00000000' + checksum.toString(2)).slice(-8);
    var words = [];
    for (i = 0; i < 24; i++) words.push(BIP39_WORDS[parseInt(all.slice(i * 11, i * 11 + 11), 2)]);
    return words.join(' ');
  }

  /* ------------------------------------------------ BIP32 / contas HD */
  function nfkd(s) {
    s = String(s);
    return s.normalize ? s.normalize('NFKD') : s;
  }
  function subtle() {
    if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('Web Crypto indisponível');
    return crypto.subtle;
  }
  async function hmacSha512(key, msg) {
    var k = await subtle().importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    var sig = await subtle().sign('HMAC', k, msg);
    return new Uint8Array(sig);
  }
  async function bip39Seed(mnemonic, passphrase) {
    /* A frase secreta é opcional e entra inteira no sal do PBKDF2: espaço,
       acento e maiúscula contam. Vazia, a seed é a do BIP39 sem segundo
       fator. */
    var pass = passphrase == null ? '' : String(passphrase);
    var key = await subtle().importKey('raw', utf8(nfkd(mnemonic)), 'PBKDF2', false, ['deriveBits']);
    var salt = utf8(nfkd('mnemonic' + pass));
    var bits = await subtle().deriveBits(
      { name: 'PBKDF2', salt: salt, iterations: 2048, hash: 'SHA-512' }, key, 512
    );
    return new Uint8Array(bits);
  }
  async function masterFromSeed(seed) {
    var I = await hmacSha512(utf8('Bitcoin seed'), seed);
    var d = BigInt('0x' + bytesToHex(I.subarray(0, 32)));
    if (d <= 0n || d >= N) throw new Error('seed BIP32 fora do intervalo');
    return {
      d: d, chain: I.subarray(32), depth: 0,
      parentFingerprint: new Uint8Array(4), childNumber: 0
    };
  }
  function fingerprintOf(node) {
    return hash160(pubCompressed(pointFromD(node.d))).subarray(0, 4);
  }
  async function ckdPriv(node, index) {
    var data = index >= 0x80000000
      ? concatBytes(new Uint8Array([0]), pad32(node.d), be32(index))
      : concatBytes(pubCompressed(pointFromD(node.d)), be32(index));
    var I = await hmacSha512(node.chain, data);
    var il = BigInt('0x' + bytesToHex(I.subarray(0, 32)));
    var child = mod(il + node.d, N);
    if (il >= N || child === 0n) throw new Error('derivação BIP32 inválida');
    return {
      d: child, chain: I.subarray(32), depth: node.depth + 1,
      parentFingerprint: fingerprintOf(node), childNumber: index
    };
  }
  async function derivePath(node, path) {
    var parts = path.split('/');
    if (parts[0] !== 'm') throw new Error('caminho BIP32 inválido');
    for (var i = 1; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var hardened = part.charAt(part.length - 1) === "'";
      var index = parseInt(hardened ? part.slice(0, -1) : part, 10);
      if (!(index >= 0 && index < 0x80000000)) throw new Error('índice BIP32 inválido');
      node = await ckdPriv(node, hardened ? index + 0x80000000 : index);
    }
    return node;
  }
  function extendedKey(version, node, isPrivate) {
    var key = isPrivate
      ? concatBytes(new Uint8Array([0]), pad32(node.d))
      : pubCompressed(pointFromD(node.d));
    return base58check(concatBytes(
      be32(version), new Uint8Array([node.depth]), node.parentFingerprint,
      be32(node.childNumber), node.chain, key
    ));
  }
  var HD_ACCOUNTS = [
    { id: 'bip86', path: "m/86'/0'/0'", xprv: 0x0488ADE4, xpub: 0x0488B21E, kind: 'p2tr' },
    { id: 'bip84', path: "m/84'/0'/0'", xprv: 0x04B2430C, xpub: 0x04B24746, kind: 'p2wpkh' },
    { id: 'bip49', path: "m/49'/0'/0'", xprv: 0x049D7878, xpub: 0x049D7CB2, kind: 'p2sh-p2wpkh' },
    { id: 'bip44', path: "m/44'/0'/0'", xprv: 0x0488ADE4, xpub: 0x0488B21E, kind: 'p2pkh' }
  ];
  function addressFor(kind, Q) {
    var pub = pubCompressed(Q);
    if (kind === 'p2pkh') return p2pkh(pub);
    if (kind === 'p2sh-p2wpkh') return p2shP2wpkh(pub);
    if (kind === 'p2wpkh') return p2wpkh(pub);
    return p2tr(taprootOutputKey(pad32(Q.x)));
  }
  async function accountFor(master, def) {
    var node = await derivePath(master, def.path);
    return {
      id: def.id, kind: def.kind, path: def.path,
      xprv: extendedKey(def.xprv, node, true),
      xpub: extendedKey(def.xpub, node, false),
      node: node
    };
  }
  async function deriveHD(bits, passphrase) {
    if (bits.length !== 256) throw new Error('são necessários exatamente 256 bits');
    var mnemonic = bip39Mnemonic(bits);
    var seed = await bip39Seed(mnemonic, passphrase);
    var master = await masterFromSeed(seed);
    var fingerprint = bytesToHex(fingerprintOf(master));
    var accounts = {};
    for (var i = 0; i < HD_ACCOUNTS.length; i++) {
      var acc = await accountFor(master, HD_ACCOUNTS[i]);
      accounts[acc.id] = acc;
    }
    return {
      bits: bits, mnemonic: mnemonic, seed: seed, master: master,
      fingerprint: fingerprint,
      accounts: accounts, primary: accounts.bip86
    };
  }

  /* --------------------------------------------- leitura/escrita binária */
  function le16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function reverseBytes(b) { return new Uint8Array(b).reverse(); }
  function readLE16(b, o) { return b[o] | (b[o + 1] << 8); }
  function readLE32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }
  function readLE64(b, o) {
    var v = 0n;
    for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
    return v;
  }
  function le64(v) {
    var out = new Uint8Array(8);
    for (var i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }
  function writeVarInt(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) return concatBytes(new Uint8Array([0xfd]), le16(n));
    if (n <= 0xffffffff) return concatBytes(new Uint8Array([0xfe]), le32(n));
    throw new Error('varint grande demais');
  }
  function readVarInt(b, o) {
    if (o >= b.length) throw new Error('varint fora do buffer');
    var c = b[o];
    var size = c < 0xfd ? 1 : c === 0xfd ? 3 : c === 0xfe ? 5 : 9;
    if (o + size > b.length) throw new Error('varint fora do buffer');
    if (c < 0xfd) return { value: c, size: 1 };
    if (c === 0xfd) return { value: readLE16(b, o + 1), size: 3 };
    if (c === 0xfe) return { value: readLE32(b, o + 1), size: 5 };
    return { value: Number(readLE64(b, o + 1)), size: 9 };
  }
  function dsha256(b) { return sha256(sha256(b)); }

  /* ------------------------------------------------------- transações */
  function readTxOut(b, o) {
    var p = o || 0;
    if (p + 8 > b.length) throw new Error('saída truncada');
    var value = readLE64(b, p); p += 8;
    var vi = readVarInt(b, p); p += vi.size;
    if (p + vi.value > b.length) throw new Error('script da saída truncado');
    var script = b.subarray(p, p + vi.value); p += vi.value;
    return { value: value, script: script, size: p - (o || 0) };
  }
  function readTx(b) {
    var p = 0;
    function u32() {
      if (p + 4 > b.length) throw new Error('transação truncada');
      var v = readLE32(b, p); p += 4; return v;
    }
    function take(n) {
      if (n < 0 || p + n > b.length) throw new Error('transação truncada');
      var out = b.subarray(p, p + n);
      p += n;
      return out;
    }
    function varint() {
      var vi = readVarInt(b, p);
      p += vi.size;
      return vi.value;
    }
    var tx = { version: u32(), inputs: [], outputs: [], witnesses: [], locktime: 0, segwit: false };
    if (b[p] === 0 && b[p + 1] === 1) { tx.segwit = true; p += 2; }
    var nIn = varint();
    for (var i = 0; i < nIn; i++) {
      var txid = bytesToHex(reverseBytes(take(32)));
      var vout = u32();
      var scriptSig = take(varint());
      var sequence = u32();
      tx.inputs.push({ txid: txid, vout: vout, scriptSig: scriptSig, sequence: sequence });
    }
    var nOut = varint();
    for (var j = 0; j < nOut; j++) {
      var value = readLE64(take(8), 0);
      var script = take(varint());
      tx.outputs.push({ value: value, script: script });
    }
    if (tx.segwit) {
      for (var k = 0; k < tx.inputs.length; k++) {
        var count = varint();
        var stack = [];
        for (var w = 0; w < count; w++) stack.push(take(varint()));
        tx.witnesses.push(stack);
      }
    }
    tx.locktime = u32();
    if (p !== b.length) throw new Error('bytes sobrando no fim da transação');
    return tx;
  }
  function writeTx(tx, withWitness) {
    var parts = [le32(tx.version >>> 0)];
    var useWitness = !!withWitness && tx.witnesses.some(function (stack) {
      return stack && stack.length;
    });
    if (useWitness) parts.push(new Uint8Array([0, 1]));
    parts.push(writeVarInt(tx.inputs.length));
    tx.inputs.forEach(function (inp) {
      parts.push(reverseBytes(hexToBytes(inp.txid)));
      parts.push(le32(inp.vout >>> 0));
      var script = inp.scriptSig || new Uint8Array(0);
      parts.push(writeVarInt(script.length), script);
      parts.push(le32(inp.sequence >>> 0));
    });
    parts.push(writeVarInt(tx.outputs.length));
    tx.outputs.forEach(function (out) {
      parts.push(le64(out.value), writeVarInt(out.script.length), out.script);
    });
    if (useWitness) {
      tx.inputs.forEach(function (inp, i) {
        var stack = (tx.witnesses[i] || []);
        parts.push(writeVarInt(stack.length));
        stack.forEach(function (item) { parts.push(writeVarInt(item.length), item); });
      });
    }
    parts.push(le32(tx.locktime >>> 0));
    return concatBytes.apply(null, parts);
  }
  function txidOf(tx) { return bytesToHex(reverseBytes(dsha256(writeTx(tx, false)))); }

  /* -------------------------------------------------------- endereços */
  function p2pkhScript(pub) {
    return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(pub), new Uint8Array([0x88, 0xac]));
  }
  function p2shScriptOfRedeem(redeem) {
    return concatBytes(new Uint8Array([0xa9, 0x14]), hash160(redeem), new Uint8Array([0x87]));
  }
  function p2wpkhScript(pub) {
    return concatBytes(new Uint8Array([0x00, 0x14]), hash160(pub));
  }
  function p2trScript(xonly) {
    return concatBytes(new Uint8Array([0x51, 0x20]), xonly);
  }
  function scriptForKind(kind, Q) {
    var pub = pubCompressed(Q);
    if (kind === 'p2pkh') return p2pkhScript(pub);
    if (kind === 'p2sh-p2wpkh') return p2shScriptOfRedeem(p2wpkhScript(pub));
    if (kind === 'p2wpkh') return p2wpkhScript(pub);
    return p2trScript(taprootOutputKey(pad32(Q.x)));
  }
  function scriptKind(script) {
    var h = bytesToHex(script);
    if (script.length === 25 && h.slice(0, 6) === '76a914' && h.slice(-4) === '88ac') return 'p2pkh';
    if (script.length === 23 && h.slice(0, 4) === 'a914' && h.slice(-2) === '87') return 'p2sh';
    if (script.length === 22 && h.slice(0, 4) === '0014') return 'p2wpkh';
    if (script.length === 34 && h.slice(0, 4) === '0020') return 'p2wsh';
    if (script.length === 34 && h.slice(0, 4) === '5120') return 'p2tr';
    if (script.length >= 4 && script.length <= 42 && (script[0] === 0 || (script[0] >= 0x51 && script[0] <= 0x60)) &&
        script[1] === script.length - 2) {
      /* BIP141: witness v0 só existe em 20 ou 32 bytes. Programa v0 de outro
         tamanho não é endereço segwit válido (BIP173); fica como script. */
      if (script[0] === 0 && script.length !== 22 && script.length !== 34) return 'outro';
      return 'witness';
    }
    return 'outro';
  }
  /* O script P2SH não diz qual é o redeem; neste cofre só existe P2SH-P2WPKH. */
  function normalizeKind(kind) { return kind === 'p2sh' ? 'p2sh-p2wpkh' : kind; }
  function addressFromScript(script) {
    var kind = scriptKind(script);
    if (kind === 'p2pkh') return base58check(concatBytes(new Uint8Array([0x00]), script.subarray(3, 23)));
    if (kind === 'p2sh') return base58check(concatBytes(new Uint8Array([0x05]), script.subarray(2, 22)));
    if (kind === 'p2wpkh' || kind === 'p2wsh' || kind === 'p2tr' || kind === 'witness') {
      var version = script[0] === 0 ? 0 : script[0] - 0x50;
      return segwitAddress('bc', version, script.subarray(2));
    }
    return bytesToHex(script);
  }
  /* Endereço de pagamento → scriptPubKey. Só mainnet e os tipos que o
     projeto já deriva/assina: p2pkh, p2sh-p2wpkh, p2wpkh e p2tr. */
  function scriptFromAddress(address) {
    var s = String(address == null ? '' : address).trim();
    if (!s) throw new Error('informe o endereço de destino');
    if (/^bc1/i.test(s)) {
      var seg = segwitDecode(s);
      if (seg.version === 0 && seg.program.length === 20) {
        return concatBytes(new Uint8Array([0x00, 0x14]), seg.program);
      }
      if (seg.version === 0 && seg.program.length === 32) {
        return concatBytes(new Uint8Array([0x00, 0x20]), seg.program);
      }
      if (seg.version === 1 && seg.program.length === 32) {
        return concatBytes(new Uint8Array([0x51, 0x20]), seg.program);
      }
      throw new Error('tipo de endereço segwit não suportado');
    }
    var payload = base58checkDecode(s);
    if (payload.length !== 21) throw new Error('endereço base58 inválido');
    if (payload[0] === 0x00) {
      return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), payload.subarray(1), new Uint8Array([0x88, 0xac]));
    }
    if (payload[0] === 0x05) {
      return concatBytes(new Uint8Array([0xa9, 0x14]), payload.subarray(1), new Uint8Array([0x87]));
    }
    throw new Error('endereço não é da mainnet');
  }
  function parsePath(text) {
    var parts = String(text).split('/');
    if (parts[0] !== 'm') throw new Error('caminho inválido');
    var out = [];
    for (var i = 1; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var hard = part.slice(-1) === "'" || part.slice(-1) === 'h' || part.slice(-1) === 'H';
      var num = parseInt(hard ? part.slice(0, -1) : part, 10);
      if (!(num >= 0 && num < 0x80000000)) throw new Error('índice inválido no caminho');
      out.push(hard ? num + 0x80000000 : num);
    }
    return out;
  }
  function pathText(indices) {
    return 'm/' + indices.map(function (v) {
      return v >= 0x80000000 ? (v - 0x80000000) + "'" : String(v);
    }).join('/');
  }
  function pathBytes(indices) {
    var parts = [];
    indices.forEach(function (v) { parts.push(le32(v >>> 0)); });
    return concatBytes.apply(null, parts);
  }

  /* ------------------------------------------------ base64 (PSBT em texto) */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64encode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var n = (a << 16) | (b << 8) | c;
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) +
        (i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=') +
        (i + 2 < bytes.length ? B64.charAt(n & 63) : '=');
    }
    return out;
  }
  function b64decode(text) {
    var clean = String(text).replace(/[\s=]+/g, '');
    if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error('base64 inválido');
    /* Comprimento ≡ 1 (mod 4) não completa um byte: recusar evita que um
       arquivo corrompido vire bytes plausíveis. */
    if (clean.length % 4 === 1) throw new Error('base64 inválido');
    var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    var acc = 0, bits = 0, p = 0;
    for (var i = 0; i < clean.length; i++) {
      acc = (acc << 6) | B64.indexOf(clean.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; out[p++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, p);
  }

  /* --------------------------------------------------- mapa de PSBT */
  function mapFind(map, type) {
    for (var i = 0; i < map.length; i++) {
      if (map[i].key.length === 1 && map[i].key[0] === type) return map[i];
    }
    return null;
  }
  function mapFindAll(map, type) {
    return map.filter(function (e) { return e.key.length > 0 && e.key[0] === type; });
  }
  function mapSet(map, type, keydata, value) {
    var key = concatBytes(new Uint8Array([type]), keydata || new Uint8Array(0));
    for (var i = 0; i < map.length; i++) {
      var k = map[i].key;
      if (k.length === key.length && bytesToHex(k) === bytesToHex(key)) {
        map[i].value = value;
        return;
      }
    }
    map.push({ key: key, value: value });
  }
  function readMap(b, p) {
    var map = [];
    var seen = Object.create(null);
    for (;;) {
      if (p >= b.length) throw new Error('PSBT truncado');
      var vi = readVarInt(b, p); p += vi.size;
      if (vi.value === 0) return { map: map, pos: p };
      var klen = vi.value;
      if (p + klen > b.length) throw new Error('chave do PSBT truncada');
      var key = b.subarray(p, p + klen); p += klen;
      if (key.length === 0) throw new Error('chave vazia no PSBT');
      /* BIP174: chave repetida dentro do mesmo mapa torna o PSBT inválido. */
      var keyHex = bytesToHex(key);
      if (seen[keyHex]) throw new Error('chave repetida no PSBT');
      seen[keyHex] = true;
      var vv = readVarInt(b, p); p += vv.size;
      if (p + vv.value > b.length) throw new Error('valor do PSBT truncado');
      map.push({ key: key, value: b.subarray(p, p + vv.value) });
      p += vv.value;
    }
  }
  function writeMap(map) {
    var parts = [];
    map.forEach(function (e) {
      parts.push(writeVarInt(e.key.length), e.key, writeVarInt(e.value.length), e.value);
    });
    parts.push(new Uint8Array([0x00]));
    return concatBytes.apply(null, parts);
  }
  /* BIP174/BIP371: cada tipo conhecido tem uma forma fixa de chave e valor;
     tipo desconhecido é preservado. O PSBT malformado é recusado na leitura.
     Portado do núcleo do Cofre BTC: as duas cópias recusam o mesmo arquivo. */
  function validPubkey(kd) {
    return (kd.length === 33 && (kd[0] === 0x02 || kd[0] === 0x03)) ||
      (kd.length === 65 && kd[0] === 0x04);
  }
  function onlyType(key, name) {
    if (key.length !== 1) throw new Error('PSBT inválido: ' + name + ' com bytes extras na chave.');
  }
  function valueSize(value, size, name) {
    if (value.length !== size) throw new Error('PSBT inválido: ' + name + ' com tamanho incorreto.');
  }
  function derivationPath(value, name) {
    if (value.length < 4 || (value.length - 4) % 4 !== 0) {
      throw new Error('PSBT inválido: ' + name + ' com caminho de derivação malformado.');
    }
  }
  function tapDerivation(key, value, name) {
    if (key.length !== 33) throw new Error('PSBT inválido: ' + name + ' com bytes extras na chave.');
    var n = readVarInt(value, 0);
    var p = n.size + 32 * n.value;
    if (n.value > value.length || p + 4 > value.length || (value.length - p - 4) % 4 !== 0) {
      throw new Error('PSBT inválido: ' + name + ' com caminho de derivação malformado.');
    }
  }
  function tapLeafScript(key, value) {
    var control = key.length - 1;
    if (control < 33 || (control - 33) % 32 !== 0 || control > 33 + 32 * 128) {
      throw new Error('PSBT inválido: tap_leaf_script com control block ou leaf version inválido.');
    }
    if (value.length < 1) throw new Error('PSBT inválido: tap_leaf_script com control block ou leaf version inválido.');
  }
  function tapTree(value) {
    if (value.length === 0) throw new Error('PSBT inválido: tap_tree vazia ou truncada.');
    var p = 0;
    while (p < value.length) {
      if (p + 2 > value.length) throw new Error('PSBT inválido: tap_tree vazia ou truncada.');
      p += 2;
      var n = readVarInt(value, p); p += n.size;
      if (p + n.value > value.length) throw new Error('PSBT inválido: tap_tree vazia ou truncada.');
      p += n.value;
    }
  }
  function witnessValue(value, name) {
    if (value.length === 0) throw new Error('PSBT inválido: ' + name + ' vazio.');
    readWitness(value);
  }
  function validateMap(map, scope, version) {
    map.forEach(function (entry) {
      var t = entry.key[0], kd = entry.key.subarray(1), v = entry.value;
      if (scope === 'global') {
        if (version === 0 && t >= 0x02 && t <= 0x06) throw new Error('PSBT inválido: campo exclusivo de PSBT v2 dentro de um PSBT v0.');
        if (t === 0x00) onlyType(entry.key, 'unsigned tx');
        else if (t === 0x01) {
          if (kd.length !== 78) throw new Error('PSBT inválido: xpub com tamanho incorreto.');
          if (v.length !== 4 + 4 * kd[4]) throw new Error('PSBT inválido: xpub com caminho de derivação malformado.');
        } else if (t === 0xfb) {
          onlyType(entry.key, 'version');
          valueSize(v, 4, 'version');
        }
      } else if (scope === 'input') {
        if (version === 0 && (t === 0x0e || t === 0x0f || t === 0x10)) throw new Error('PSBT inválido: campo exclusivo de PSBT v2 dentro de um PSBT v0.');
        if (t === 0x00) { onlyType(entry.key, 'non_witness_utxo'); readTx(v); }
        else if (t === 0x01) {
          onlyType(entry.key, 'witness_utxo');
          if (readTxOut(v, 0).size !== v.length) throw new Error('PSBT inválido: witness_utxo com bytes extras.');
        } else if (t === 0x02) {
          if (!validPubkey(kd)) throw new Error('PSBT inválido: partial_sig com pubkey inválida.');
          if (v.length === 0) throw new Error('PSBT inválido: partial_sig vazia.');
        } else if (t === 0x03) {
          onlyType(entry.key, 'sighash_type');
          valueSize(v, 4, 'sighash_type');
        } else if (t === 0x04) onlyType(entry.key, 'redeem_script');
        else if (t === 0x05) onlyType(entry.key, 'witness_script');
        else if (t === 0x06) {
          if (!validPubkey(kd)) throw new Error('PSBT inválido: bip32_derivation com pubkey inválida.');
          derivationPath(v, 'bip32_derivation');
        } else if (t === 0x07) onlyType(entry.key, 'final_scriptSig');
        else if (t === 0x08) {
          onlyType(entry.key, 'final_scriptWitness');
          witnessValue(v, 'final_scriptWitness');
        } else if (t === 0x09) onlyType(entry.key, 'por_commitment');
        else if (t === 0x0a || t === 0x0c) valueSize(kd, 20, 'preimagem hash160');
        else if (t === 0x0b || t === 0x0d) valueSize(kd, 32, 'preimagem hash256');
        else if (t === 0x11 || t === 0x12) {
          onlyType(entry.key, t === 0x11 ? 'required_time_locktime' : 'required_height_locktime');
          valueSize(v, 4, 'time lock');
        } else if (t === 0x13) {
          onlyType(entry.key, 'tap_key_sig');
          if (v.length !== 64 && v.length !== 65) throw new Error('PSBT inválido: tap_key_sig com tamanho diferente de 64/65 bytes.');
        } else if (t === 0x14) {
          if (kd.length !== 64) throw new Error('PSBT inválido: tap_script_sig com chave ou tamanho inválido.');
          if (v.length !== 64 && v.length !== 65) throw new Error('PSBT inválido: tap_script_sig com chave ou tamanho inválido.');
        } else if (t === 0x15) tapLeafScript(entry.key, v);
        else if (t === 0x16) tapDerivation(entry.key, v, 'tap_bip32_derivation');
        else if (t === 0x17) {
          onlyType(entry.key, 'tap_internal_key');
          valueSize(v, 32, 'tap_internal_key');
        } else if (t === 0x18) {
          onlyType(entry.key, 'tap_merkle_root');
          valueSize(v, 32, 'tap_merkle_root');
        }
      } else {
        if (version === 0 && (t === 0x03 || t === 0x04)) throw new Error('PSBT inválido: campo exclusivo de PSBT v2 dentro de um PSBT v0.');
        if (t === 0x00) onlyType(entry.key, 'redeem_script');
        else if (t === 0x01) onlyType(entry.key, 'witness_script');
        else if (t === 0x02) {
          if (!validPubkey(kd)) throw new Error('PSBT inválido: bip32_derivation com pubkey inválida.');
          derivationPath(v, 'bip32_derivation');
        } else if (t === 0x05) {
          onlyType(entry.key, 'tap_internal_key');
          valueSize(v, 32, 'tap_internal_key');
        } else if (t === 0x06) {
          onlyType(entry.key, 'tap_tree');
          tapTree(v);
        } else if (t === 0x07) tapDerivation(entry.key, v, 'tap_bip32_derivation');
      }
    });
  }
  function parsePsbt(b) {
    if (b.length < 5 || b[0] !== 0x70 || b[1] !== 0x73 || b[2] !== 0x62 || b[3] !== 0x74 || b[4] !== 0xff) {
      throw new Error('não começa com a marca psbt');
    }
    var g = readMap(b, 5);
    var psbt = { global: g.map, inputs: [], outputs: [], tx: null, version: 0 };
    var ver = mapFind(g.map, 0xfb);
    if (ver && ver.value.length === 4) psbt.version = readLE32(ver.value, 0);
    validateMap(g.map, 'global', psbt.version);
    if (psbt.version !== 0) throw new Error('PSBT v2 não é suportado; exporte em PSBT v0');
    var utx = mapFind(g.map, 0x00);
    if (!utx) throw new Error('PSBT sem transação não assinada (v0)');
    psbt.tx = readTx(utx.value);
    /* BIP174: a transação não assinada vai no formato antigo, sem scriptSig. */
    if (psbt.tx.segwit) throw new Error('a transação não assinada veio no formato witness; PSBT v0 exige o formato antigo');
    psbt.tx.inputs.forEach(function (inp) {
      if (inp.scriptSig && inp.scriptSig.length) {
        throw new Error('a transação não assinada veio com scriptSig; PSBT v0 exige scriptSig vazio');
      }
    });
    var p = g.pos;
    for (var i = 0; i < psbt.tx.inputs.length; i++) {
      var mi = readMap(b, p);
      validateMap(mi.map, 'input', psbt.version);
      psbt.inputs.push(mi.map);
      p = mi.pos;
    }
    for (var j = 0; j < psbt.tx.outputs.length; j++) {
      var mo = readMap(b, p);
      validateMap(mo.map, 'output', psbt.version);
      psbt.outputs.push(mo.map);
      p = mo.pos;
    }
    if (p !== b.length) throw new Error('bytes sobrando depois do PSBT');
    return psbt;
  }
  function writePsbt(psbt) {
    var parts = [new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]), writeMap(psbt.global)];
    psbt.inputs.forEach(function (m) { parts.push(writeMap(m)); });
    psbt.outputs.forEach(function (m) { parts.push(writeMap(m)); });
    return concatBytes.apply(null, parts);
  }

  /* PSBT v0 sem assinatura, pronto para o Cofre BTC.

     spec.inputs: [{ txid, vout, value, script (bytes), kind, pub (bytes),
                     path ("m/..."), fingerprint (hex), rawTx? (bytes) }]
     spec.outputs: [{ value (sats), script (bytes), origin?: { pub, path,
                      fingerprint } }]

     Cada entrada leva witness_utxo e a origem BIP32 (bip32/tap_bip32) para
     o assinante achar a chave sem varrer a carteira. Toda entrada com rawTx
     leva também o non_witness_utxo, para o assinante conferir o valor contra
     a transação anterior; no p2pkh ele é obrigatório. O p2sh-p2wpkh leva o
     redeem_script. A saída de troco leva a origem da conta para o assinante
     reconhecê-la como interna. */
  function buildPsbt(spec) {
    var inputs = spec.inputs || [];
    var outputs = spec.outputs || [];
    if (!inputs.length) throw new Error('a transação não tem entradas');
    if (!outputs.length) throw new Error('a transação não tem saídas');
    var tx = {
      version: spec.version || 2,
      inputs: inputs.map(function (inp) {
        return {
          txid: inp.txid, vout: inp.vout >>> 0,
          scriptSig: new Uint8Array(0),
          sequence: inp.sequence == null ? 0xffffffff : (inp.sequence >>> 0)
        };
      }),
      outputs: outputs.map(function (out) {
        return { value: BigInt(out.value), script: out.script };
      }),
      witnesses: [], locktime: spec.locktime || 0, segwit: false
    };
    var global = [{ key: new Uint8Array([0x00]), value: writeTx(tx, false) }];
    var originOf = function (o) {
      if (!o || !o.fingerprint || !o.path) throw new Error('origem BIP32 ausente');
      return concatBytes(hexToBytes(o.fingerprint), pathBytes(parsePath(o.path)));
    };
    var inputMaps = inputs.map(function (inp) {
      var kind = normalizeKind(inp.kind || scriptKind(inp.script));
      var map = [];
      var witnessUtxo = concatBytes(le64(BigInt(inp.value)), writeVarInt(inp.script.length), inp.script);
      if (kind === 'p2pkh' && !inp.rawTx) {
        throw new Error('entrada p2pkh sem a transação anterior (non_witness_utxo)');
      }
      if (inp.rawTx) map.push({ key: new Uint8Array([0x00]), value: inp.rawTx });
      map.push({ key: new Uint8Array([0x01]), value: witnessUtxo });
      if (kind === 'p2sh-p2wpkh') {
        map.push({ key: new Uint8Array([0x04]), value: p2wpkhScript(inp.pub) });
      }
      if (!inp.pub) throw new Error('entrada sem chave pública');
      var origin = originOf(inp);
      if (kind === 'p2tr') {
        var xonly = inp.pub.subarray(1);
        map.push({ key: concatBytes(new Uint8Array([0x16]), xonly), value: concatBytes(new Uint8Array([0x00]), origin) });
      } else {
        map.push({ key: concatBytes(new Uint8Array([0x06]), inp.pub), value: origin });
      }
      return map;
    });
    var outputMaps = outputs.map(function (out) {
      var map = [];
      if (out.origin) {
        var origin = originOf(out.origin);
        if (scriptKind(out.script) === 'p2tr') {
          map.push({ key: concatBytes(new Uint8Array([0x07]), out.origin.pub.subarray(1)),
            value: concatBytes(new Uint8Array([0x00]), origin) });
        } else {
          map.push({ key: concatBytes(new Uint8Array([0x02]), out.origin.pub), value: origin });
        }
      }
      return map;
    });
    var psbt = { global: global, inputs: inputMaps, outputs: outputMaps, tx: tx, version: 0 };
    var bytes = writePsbt(psbt);
    return {
      psbt: psbt, bytes: bytes, base64: b64encode(bytes), tx: tx, txid: txidOf(tx),
      vsize: estimateVsize(inputs.map(function (i) { return normalizeKind(i.kind || scriptKind(i.script)); }),
        outputs.map(function (o) { return o.script; }))
    };
  }
  function psbtParseInput(text) {
    var compact = String(text).replace(/\s+/g, '');
    if (!compact) throw new Error('PSBT vazio');
    /* A marca psbt\xff em base64 começa sempre por "cHNidP8", então uma
       sequência puramente hexadecimal só pode ser a forma hex. */
    if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) return hexToBytes(compact);
    return b64decode(compact);
  }

  /* Transação final de um PSBT assinado (o que se publica na rede).

     O BIP174 manda escrever a transação a partir dos campos finais de cada
     entrada (`final_scriptSig` e `final_scriptWitness`), e não copiar os
     campos de assinatura: quem transmite não precisa conhecer o script tipo
     de cada entrada. Exige todas as entradas finalizadas; o que falta é
     erro, e não um hex pela metade. */
  function psbtFinalTx(psbt) {
    var tx = psbt && psbt.tx;
    if (!tx) throw new Error('PSBT sem a transação não assinada');
    if (!tx.inputs.length) throw new Error('a transação não tem entradas');
    if (!tx.outputs.length) throw new Error('a transação não tem saídas');
    var finalInputs = [], witnesses = [];
    for (var i = 0; i < tx.inputs.length; i++) {
      if (tx.inputs[i].scriptSig && tx.inputs[i].scriptSig.length) {
        throw new Error('entrada ' + i + ' já tem scriptSig na transação não assinada');
      }
      var map = psbt.inputs[i];
      var fs = mapFind(map, 0x07);
      var fw = mapFind(map, 0x08);
      if (!fs && !fw) throw new Error('uma entrada: não está finalizada; o PSBT precisa dos campos finais para gerar a transação.');
      var prev = prevoutOf(map, tx.inputs[i]);
      var kind = normalizeKind(scriptKind(prev.script));
      var scriptSig = fs ? fs.value : new Uint8Array(0);
      var stack = fw ? readWitness(fw.value) : [];
      /* O formato final depende do tipo: p2pkh no scriptSig, p2sh-p2wpkh nos
         dois, p2wpkh/p2tr só no witness. Um witness em entrada não-segwit
         invalida a transação; um p2wpkh sem witness não está finalizado. */
      if (kind === 'p2pkh') {
        if (!scriptSig.length || stack.length) throw new Error('uma entrada: p2pkh não está finalizada como esperado.');
      } else if (kind === 'p2sh-p2wpkh') {
        if (!scriptSig.length || !stack.length) throw new Error('uma entrada: p2sh-p2wpkh não está finalizada como esperado.');
      } else if (kind === 'p2wpkh' || kind === 'p2tr') {
        if (scriptSig.length || !stack.length) throw new Error('uma entrada: ' + kind + ' não está finalizada como esperado.');
      } else {
        throw new Error('uma entrada: script não suportado; use p2pkh, p2sh-p2wpkh, p2wpkh ou p2tr key path.');
      }
      finalInputs.push({
        txid: tx.inputs[i].txid, vout: tx.inputs[i].vout,
        scriptSig: scriptSig, sequence: tx.inputs[i].sequence
      });
      witnesses.push(stack);
    }
    var final = {
      version: tx.version, inputs: finalInputs, outputs: tx.outputs,
      witnesses: witnesses, locktime: tx.locktime,
      segwit: witnesses.some(function (w) { return w.length > 0; })
    };
    var bytes = writeTx(final, true);
    /* ida e volta: o hex publicado tem de voltar como a mesma transação */
    var parsed = readTx(bytes);
    return { tx: parsed, hex: bytesToHex(bytes), txid: txidOf(parsed), vsize: vsizeOf(parsed) };
  }

  /* ------------------------------------------------ desvios de chave */
  function createSession(hd) {
    var cache = { chain: {}, at: {} };
    function account(id) {
      var acc = hd.accounts[id];
      if (!acc || !acc.node) throw new Error('conta ' + id + ' indisponível');
      return acc;
    }
    async function chainNode(id, chain) {
      var key = id + ':' + chain;
      if (!cache.chain[key]) cache.chain[key] = await ckdPriv(account(id).node, chain);
      return cache.chain[key];
    }
    async function at(id, chain, index) {
      var key = id + ':' + chain + ':' + index;
      if (!cache.at[key]) {
        var node = await ckdPriv(await chainNode(id, chain), index);
        var Q = pointFromD(node.d);
        cache.at[key] = {
          d: node.d, Q: Q, pub: pubCompressed(Q),
          kind: account(id).kind, accountId: id, chain: chain, index: index,
          indices: parsePath(account(id).path).concat([chain, index])
        };
      }
      return cache.at[key];
    }
    return { at: at, account: account, hd: hd };
  }

  async function findKeyForScript(session, script, map, isOutput) {
    var kind = normalizeKind(scriptKind(script));
    if (kind === 'p2wsh' || kind === 'outro' || kind === 'witness') {
      throw new Error('tipo de script não suportado (' + kind + ')');
    }
    var wanted = bytesToHex(script);
    var i, j;

    /* Informação de derivação que o PSBT já carrega. BIP174 usa 0x06
       (bip32) e 0x16 (tap_bip32) nas entradas; nas saídas são 0x02 e 0x07. */
    var bip32Type = isOutput ? 0x02 : 0x06;
    var tapType = isOutput ? 0x07 : 0x16;
    var derivs = mapFindAll(map, kind === 'p2tr' ? tapType : bip32Type).map(function (e) {
      return { key: e.key.subarray(1), value: e.value };
    });
    for (i = 0; i < derivs.length; i++) {
      var d = derivs[i];
      /* BIP371: em tap_bip32_derivation o valor começa pelo compact size da
         quantidade de hashes (0 no key path); o fingerprint vem depois. */
      var offset = kind === 'p2tr' ? 1 : 0;
      if (kind === 'p2tr' && d.value[0] !== 0) continue;
      if (d.value.length < 4 + offset + 4) continue;
      var fp = bytesToHex(d.value.subarray(offset, offset + 4));
      var num = (d.value.length - 4 - offset) / 4;
      if (num < 1 || num % 1 !== 0) continue;
      var idxs = [];
      for (j = 0; j < num; j++) idxs.push(readLE32(d.value, 4 + offset + j * 4));
      /* O PSBT do Monitor BTC carrega a impressão digital da CONTA (a única
         chave que o lado watch-only tem), não a da raiz. O caminho continua
         sendo o completo; se a raiz não casar, confere a conta dos três
         primeiros níveis. A chave e o script são verificados abaixo, então
         aceitar a conta não afrouxa a checagem. */
      if (fp !== session.hd.fingerprint) {
        if (idxs.length < 3) continue;
        var accPath = pathText(idxs.slice(0, 3));
        session.fpCache = session.fpCache || {};
        if (!session.fpCache[accPath]) {
          session.fpCache[accPath] = bytesToHex(fingerprintOf(
            await derivePath(session.hd.master, accPath)));
        }
        if (session.fpCache[accPath] !== fp) continue;
      }
      var node = await derivePath(session.hd.master, pathText(idxs));
      var Q = pointFromD(node.d);
      var pub = pubCompressed(Q);
      if (kind === 'p2tr' && bytesToHex(pad32(Q.x)) !== bytesToHex(d.key)) continue;
      if (kind !== 'p2tr' && bytesToHex(pub) !== bytesToHex(d.key)) continue;
      if (bytesToHex(scriptForKind(kind, Q)) !== wanted) continue;
      return {
        d: node.d, Q: Q, pub: pub, kind: kind,
        accountId: kind === 'p2pkh' ? 'bip44' : kind === 'p2sh-p2wpkh' ? 'bip49' : kind === 'p2wpkh' ? 'bip84' : 'bip86',
        chain: idxs[idxs.length - 2], index: idxs[idxs.length - 1], indices: idxs
      };
    }

    /* Sem origem declarada não há varredura: a entrada é recusada na análise
       (não há chave para assinar) e a saída fica externa. A conferência acima
       já validou a origem contra o script real. */
    return null;
  }

  function redeemFor(key) {
    if (key.kind !== 'p2sh-p2wpkh') return null;
    return p2wpkhScript(key.pub);
  }

  /* ------------------------------------------------------------- sighash */
  function outpointBytes(inp) {
    return concatBytes(reverseBytes(hexToBytes(inp.txid)), le32(inp.vout >>> 0));
  }
  function pushData(data) {
    if (data.length < 0x4c) return concatBytes(new Uint8Array([data.length]), data);
    if (data.length <= 0xff) return concatBytes(new Uint8Array([0x4c, data.length]), data);
    return concatBytes(new Uint8Array([0x4d]), le16(data.length), data);
  }

  function sighashLegacy(tx, index, scriptCode, hashType) {
    if ((hashType & 0x1f) !== 1) throw new Error('só SIGHASH_ALL é assinado');
    var parts = [le32(tx.version >>> 0), writeVarInt(tx.inputs.length)];
    tx.inputs.forEach(function (inp, i) {
      parts.push(outpointBytes(inp));
      var script = i === index ? scriptCode : new Uint8Array(0);
      parts.push(writeVarInt(script.length), script);
      parts.push(le32(inp.sequence >>> 0));
    });
    parts.push(writeVarInt(tx.outputs.length));
    tx.outputs.forEach(function (out) {
      parts.push(le64(out.value), writeVarInt(out.script.length), out.script);
    });
    parts.push(le32(tx.locktime >>> 0), le32(hashType >>> 0));
    return dsha256(concatBytes.apply(null, parts));
  }

  function sighashV0(tx, index, scriptCode, amount, hashType) {
    if ((hashType & 0x1f) !== 1) throw new Error('só SIGHASH_ALL é assinado');
    var prevouts = [], sequences = [], outputs = [];
    tx.inputs.forEach(function (inp) {
      prevouts.push(outpointBytes(inp));
      sequences.push(le32(inp.sequence >>> 0));
    });
    tx.outputs.forEach(function (out) {
      outputs.push(concatBytes(le64(out.value), writeVarInt(out.script.length), out.script));
    });
    var pre = concatBytes(
      le32(tx.version >>> 0),
      dsha256(concatBytes.apply(null, prevouts)),
      dsha256(concatBytes.apply(null, sequences)),
      outpointBytes(tx.inputs[index]),
      writeVarInt(scriptCode.length), scriptCode,
      le64(amount),
      le32(tx.inputs[index].sequence >>> 0),
      dsha256(concatBytes.apply(null, outputs)),
      le32(tx.locktime >>> 0),
      le32(hashType >>> 0)
    );
    return dsha256(pre);
  }

  function sighashTaproot(tx, index, prevouts, hashType) {
    if (hashType !== 0x00 && hashType !== 0x01) throw new Error('só SIGHASH_DEFAULT/ALL é assinado');
    var prev = [], amounts = [], scripts = [], seqs = [], outs = [];
    tx.inputs.forEach(function (inp) {
      prev.push(outpointBytes(inp));
      seqs.push(le32(inp.sequence >>> 0));
    });
    prevouts.forEach(function (p) {
      amounts.push(le64(p.value));
      scripts.push(concatBytes(writeVarInt(p.script.length), p.script));
    });
    tx.outputs.forEach(function (out) {
      outs.push(concatBytes(le64(out.value), writeVarInt(out.script.length), out.script));
    });
    var msg = concatBytes(
      new Uint8Array([hashType]),
      le32(tx.version >>> 0),
      le32(tx.locktime >>> 0),
      sha256(concatBytes.apply(null, prev)),
      sha256(concatBytes.apply(null, amounts)),
      sha256(concatBytes.apply(null, scripts)),
      sha256(concatBytes.apply(null, seqs)),
      sha256(concatBytes.apply(null, outs)),
      new Uint8Array([0x00]),        /* spend_type: key path, sem annex */
      le32(index >>> 0)
    );
    return taggedHash('TapSighash', concatBytes(new Uint8Array([0x00]), msg));
  }

  /* ---------------------------------------------------- Schnorr (BIP340) */
  function xonlyOf(Q) { return pad32(Q.x); }
  function hasEvenY(Q) { return (Q.y & 1n) === 0n; }
  function bip340Sign(d, msg, aux) {
    var dd = mod(d, N);
    var Q = pointFromD(dd);
    if (!hasEvenY(Q)) dd = mod(N - dd, N);
    var Px = xonlyOf(pointFromD(dd));
    var auxRand = aux && aux.length === 32 ? aux : new Uint8Array(32);
    var t = new Uint8Array(32);
    for (var i = 0; i < 32; i++) t[i] = pad32(dd)[i] ^ taggedHash('BIP0340/aux', auxRand)[i];
    var k0 = BigInt('0x' + bytesToHex(taggedHash('BIP0340/nonce', concatBytes(t, Px, msg)))) % N;
    if (k0 === 0n) throw new Error('nonce Schnorr nulo');
    var R = pointFromD(k0);
    var k = hasEvenY(R) ? k0 : mod(N - k0, N);
    var Rx = xonlyOf(pointFromD(k));
    var e = BigInt('0x' + bytesToHex(taggedHash('BIP0340/challenge', concatBytes(Rx, Px, msg)))) % N;
    var s = mod(k + e * dd, N);
    var sig = concatBytes(Rx, pad32(s));
    if (!bip340Verify(Px, msg, sig)) throw new Error('assinatura Schnorr não verificou');
    return sig;
  }
  function bip340Verify(xonly, msg, sig) {
    if (sig.length !== 64 || xonly.length !== 32) return false;
    var Ppt = liftX(BigInt('0x' + bytesToHex(xonly)));
    if (!Ppt) return false;
    var r = BigInt('0x' + bytesToHex(sig.subarray(0, 32)));
    var s = BigInt('0x' + bytesToHex(sig.subarray(32)));
    if (r >= P || s >= N) return false;
    var e = BigInt('0x' + bytesToHex(taggedHash('BIP0340/challenge', concatBytes(sig.subarray(0, 32), xonly, msg)))) % N;
    var R = toAffine(jAdd(jMul(s), jMul(mod(N - e, N), { x: Ppt.x, y: Ppt.y })));
    if (!R) return false;
    if (R.y & 1n) return false;
    return mod(R.x) === r;
  }

  /* BIP341: o ponto interno é lift_x(x(P)), sempre de ordenada par. Se a
     chave derivada tem ordenada ímpar, o escalar correspondente é n - d —
     sem isso o tweak gera a chave de saída errada e a assinatura não vale. */
  function tweakPrivate(d, merkleRoot) {
    var Q = pointFromD(d);
    var xonly = pad32(Q.x);
    var base = (Q.y & 1n) ? mod(N - d, N) : d;
    var t = BigInt('0x' + bytesToHex(taggedHash('TapTweak', concatBytes(xonly, merkleRoot || new Uint8Array(0)))));
    if (t >= N) throw new Error('tweak taproot inválido');
    var out = mod(base + t, N);
    if (out === 0n) throw new Error('chave ajustada inválida');
    return out;
  }

  /* -------------------------------------------------- formatação e taxa */
  function formatSats(v) {
    var neg = v < 0n;
    var s = neg ? -v : v;
    var whole = s / 100000000n;
    var frac = (s % 100000000n).toString();
    while (frac.length < 8) frac = '0' + frac;
    return (neg ? '-' : '') + whole.toString() + '.' + frac;
  }
  /* Tamanho estimado da transação, em vB, ANTES de assinar: é o número que
     vira taxa (taxa = preço × vsize), então ele precisa ser um limite
     superior do tamanho real — estimativa curta faria a transação cair abaixo
     do preço pedido, e no piso de relay isso é recusa.

     - peso de cada entrada é o do pior caso de assinatura (72 bytes no ECDSA,
       65 no taproot, que é o SIGHASH_ALL: o SIGHASH_DEFAULT usa 64);
     - `marker` + `flag` do witness (2 wu) entram quando há entrada segwit —
       sem eles a conta dava 1 vB a menos em toda transação segwit;
     - as contagens usam o varint de verdade (1, 3, 5 ou 9 bytes), não uma
       aproximação: uma transação com 253+ entradas é 8 wu maior que a conta
       antiga.

     O preço efetivo pode ficar um fio acima do pedido — no pior caso ~1 vB a
     cada 4 entradas —, mas nunca abaixo. */
  function estimateVsize(inputKinds, scripts) {
    var varIntSize = function (n) {
      return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
    };
    var weight = 4 * (4 + 4) + /* versão e locktime */
      4 * (varIntSize(inputKinds.length) + varIntSize(scripts.length));
    var segwit = false;
    inputKinds.forEach(function (kind) {
      if (kind !== 'p2pkh') segwit = true;
      weight += kind === 'p2pkh' ? 592 : kind === 'p2sh-p2wpkh' ? 364 : kind === 'p2wpkh' ? 272 : 231;
    });
    if (segwit) weight += 2; /* marker + flag, contados como witness */
    scripts.forEach(function (script) {
      weight += 4 * (8 + (script.length < 0xfd ? 1 : 3) + script.length);
    });
    return Math.ceil(weight / 4);
  }
  function vsizeOf(tx) {
    var base = writeTx(tx, false).length;
    var full = writeTx(tx, true).length;
    return Math.ceil((base * 4 + (full - base)) / 4);
  }

  /* ------------------------------------------------ prevouts do PSBT */
  function prevoutOf(map, outpoint) {
    var wu = mapFind(map, 0x01);
    var nwu = mapFind(map, 0x00);
    var fromW = null;
    if (wu) {
      fromW = readTxOut(wu.value, 0);
      if (fromW.size !== wu.value.length) throw new Error('witness_utxo com bytes sobrando');
    }
    var fromN = null;
    if (nwu) {
      var full = readTx(nwu.value);
      if (txidOf(full) !== outpoint.txid) throw new Error('non_witness_utxo não corresponde ao txid da entrada');
      if (outpoint.vout >= full.outputs.length) throw new Error('vout fora do non_witness_utxo');
      fromN = full.outputs[outpoint.vout];
    }
    if (fromW && fromN) {
      if (fromW.value !== fromN.value || bytesToHex(fromW.script) !== bytesToHex(fromN.script)) {
        throw new Error('witness_utxo contradiz o non_witness_utxo');
      }
    }
    var prev = fromW || fromN;
    if (!prev) throw new Error('entrada sem witness_utxo nem non_witness_utxo');
    return prev;
  }

  /* Uma entrada já assinada traz partial_sigs, tap_key_sig ou a finalização
     (final_scriptSig/final_scriptWitness). Campos finais vazios não contam:
     no segwit o final_scriptSig fica vazio e o witness leva a assinatura. */
  function inputSigned(map) {
    if (mapFindAll(map, 0x02).some(function (e) { return e.value.length > 0; })) return true;
    var tapSig = mapFind(map, 0x13);
    if (tapSig && tapSig.value.length > 0) return true;
    var finalSig = mapFind(map, 0x07);
    if (finalSig && finalSig.value.length > 0) return true;
    var finalWitness = mapFind(map, 0x08);
    return !!(finalWitness && finalWitness.value.length > 0);
  }

  /* BIP174/BIP371: depois de finalizada, a entrada conserva o UTXO e os
     campos finais; os demais campos conhecidos saem. Desconhecidos ficam. */
  var FINALIZED_DROP = {
    0x02: 1, 0x03: 1, 0x04: 1, 0x05: 1, 0x06: 1, 0x09: 1, 0x0a: 1, 0x0b: 1,
    0x0c: 1, 0x0d: 1, 0x11: 1, 0x12: 1, 0x13: 1, 0x14: 1, 0x15: 1, 0x16: 1,
    0x17: 1, 0x18: 1
  };
  function clearFinalizedFields(map) {
    for (var i = map.length - 1; i >= 0; i--) {
      if (FINALIZED_DROP[map[i].key[0]]) map.splice(i, 1);
    }
  }

  /* ---------------------------------------------- análise de um PSBT */
  async function analyzePsbt(bytes, hd) {
    var psbt = parsePsbt(bytes);
    var tx = psbt.tx;
    var session = createSession(hd);
    var inputs = [], warnings = [];
    var totalIn = 0n;
    var signedInputs = 0;
    var allFinalized = psbt.inputs.length > 0 && psbt.inputs.every(inputSigned);
    for (var i = 0; i < tx.inputs.length; i++) {
      var map = psbt.inputs[i];
      if (inputSigned(map)) signedInputs++;
      var prev = prevoutOf(map, tx.inputs[i]);
      var kind = normalizeKind(scriptKind(prev.script));
      if (kind === 'p2wsh') throw new Error('entrada ' + i + ' é P2WSH, não suportada');
      if (kind === 'outro' || kind === 'witness') throw new Error('entrada ' + i + ' tem script não suportado');
      if (mapFind(map, 0x05)) throw new Error('entrada ' + i + ' tem witness_script, não suportada');
      if (mapFind(map, 0x14) || mapFind(map, 0x15) || mapFind(map, 0x18)) {
        throw new Error('entrada ' + i + ' tem dados de script no Taproot, não suportados');
      }
      if (mapFind(map, 0x11) || mapFind(map, 0x12)) {
        throw new Error('entrada ' + i + ' exige time lock; este signer não confere travas de tempo');
      }
      var key = await findKeyForScript(session, prev.script, map);
      if (!key) {
        /* O finalizador do BIP174 limpa a origem do PSBT já finalizado; sem
           ela, a entrada só pode ser exibida, nunca assinada. */
        if (!(allFinalized && inputSigned(map))) {
          throw new Error('entrada ' + i + ' não pertence às contas derivadas dos 256 bits');
        }
      } else if (bytesToHex(scriptForKind(key.kind, key.Q)) !== bytesToHex(prev.script)) {
        throw new Error('entrada ' + i + ': chave derivada não corresponde ao script');
      }
      if (tx.inputs[i].scriptSig && tx.inputs[i].scriptSig.length) {
        throw new Error('entrada ' + i + ' já tem scriptSig na transação não assinada');
      }
      var sigTypeField = mapFind(map, 0x03);
      var hashType = sigTypeField ? readLE32(sigTypeField.value, 0) : (kind === 'p2tr' ? 0x00 : 0x01);
      if (kind === 'p2tr' ? (hashType !== 0x00 && hashType !== 0x01) : hashType !== 0x01) {
        throw new Error('entrada ' + i + ': só SIGHASH_ALL é suportado (hash type ' + hashType + ')');
      }
      totalIn += prev.value;
      inputs.push({
        index: i, outpoint: tx.inputs[i].txid + ':' + tx.inputs[i].vout,
        value: prev.value, script: prev.script, kind: kind, key: key,
        address: addressFromScript(prev.script),
        path: key ? pathText(key.indices) : ''
      });
    }
    var outputs = [], totalOut = 0n;
    for (var j = 0; j < tx.outputs.length; j++) {
      var out = tx.outputs[j];
      totalOut += out.value;
      var outKind = scriptKind(out.script);
      var own = null;
      /* Saída: só a origem que o PSBT declara, conferida contra o script.
         Sem origem válida não há varredura; a saída fica externa. */
      try { own = await findKeyForScript(session, out.script, psbt.outputs[j], true); } catch (e) { own = null; }
      outputs.push({
        index: j, value: out.value, script: out.script, kind: outKind,
        address: addressFromScript(out.script),
        own: (outKind === 'outro' || outKind === 'witness') ? 'outro'
          : own ? (own.chain === 1 ? 'troco' : 'recebimento') : 'externo',
        path: own ? pathText(own.indices) : ''
      });
    }
    if (totalIn < totalOut) throw new Error('as saídas somam mais que as entradas');
    var fee = totalIn - totalOut;
    var vsize = estimateVsize(inputs.map(function (x) { return x.kind; }), tx.outputs.map(function (x) { return x.script; }));
    var feerate = vsize > 0 ? Number(fee) / vsize : 0;
    if (feerate > 0 && feerate < 0.1) warnings.push('taxa abaixo de 0,1 sat/vB: a transação pode ser recusada pelo piso de relay padrão');
    if (feerate > 500) warnings.push('taxa acima de 500 sat/vB: confira o valor da taxa');
    if (fee === 0n) warnings.push('taxa zero: a rede pode recusar a transação');
    /* No p2pkh o valor não entra no sighash: aceitar só o witness_utxo
       deixaria o coordenador mentir sobre a taxa. Exigimos a transação
       anterior inteira e conferimos o txid em prevoutOf. */
    inputs.forEach(function (inp) {
      if (inp.kind === 'p2pkh' && !mapFind(psbt.inputs[inp.index], 0x00)) {
        throw new Error('entrada ' + inp.index + ' é p2pkh e veio sem non_witness_utxo; o valor da entrada não pode ser conferido');
      }
      /* No segwit o valor entra no sighash: com só witness_utxo, o
         coordenador pode mentir sobre o valor e a taxa exibida não é
         conferível. A assinatura resultante seria recusada na rede. */
      if (inp.kind !== 'p2pkh' && !mapFind(psbt.inputs[inp.index], 0x00)) {
        warnings.push('a entrada ' + inp.index + ' é segwit e veio sem non_witness_utxo; o valor da entrada não pode ser conferido.');
      }
    });
    outputs.forEach(function (out) {
      /* O destino externo não vira aviso: cada saída já traz `own`, e a
         revisão que o apresenta (Cofre BTC) marca o endereço em vez de
         repetir a informação na lista. */
      if (out.own === 'outro') warnings.push('saída ' + out.index + ' tem script não padronizado; confira no coordenador');
    });
    if (tx.inputs.length === 0) throw new Error('a transação não tem entradas');
    if (tx.outputs.length === 0) throw new Error('a transação não tem saídas');
    if (signedInputs > 0 && signedInputs < tx.inputs.length) {
      warnings.push('algumas entradas já têm assinatura; assinar de novo substitui as assinaturas existentes.');
    }
    return {
      psbt: psbt, tx: tx, session: session,
      inputs: inputs, outputs: outputs,
      totalIn: totalIn, totalOut: totalOut, fee: fee,
      signedInputs: signedInputs, alreadySigned: signedInputs === tx.inputs.length,
      txid: txidOf(tx), vsize: vsize, feerate: feerate, warnings: warnings,
      /* Em p2pkh e p2sh-p2wpkh o scriptSig só existe depois da assinatura e
         muda o txid; nas demais entradas o txid já é o final. */
      txidEstimated: inputs.some(function (x) {
        return x.kind === 'p2pkh' || x.kind === 'p2sh-p2wpkh';
      })
    };
  }

  /* ------------------------------------------------ assinatura do PSBT */
  async function signPsbt(bytes, hd, auxRand) {
    var a = await analyzePsbt(bytes, hd);
    if (a.alreadySigned) throw new Error('este psbt já está assinado');
    var psbt = a.psbt, tx = a.tx;
    a.inputs.forEach(function (inp) {
      var map = psbt.inputs[inp.index];
      var sigType = mapFind(map, 0x03);
      var hashType = sigType ? readLE32(sigType.value, 0) : (inp.kind === 'p2tr' ? 0x00 : 0x01);
      if (inp.kind === 'p2tr') {
        if (hashType !== 0x00 && hashType !== 0x01) throw new Error('entrada ' + inp.index + ': hash type taproot não suportado');
        var prevouts = a.inputs.map(function (x) { return { value: x.value, script: x.script }; });
        var digest = sighashTaproot(tx, inp.index, prevouts, hashType);
        var tweaked = tweakPrivate(inp.key.d, null);
        var check = taprootOutputKey(pad32(inp.key.Q.x));
        if (bytesToHex(check) !== bytesToHex(inp.script.subarray(2))) {
          throw new Error('entrada ' + inp.index + ': a chave ajustada não é a do script');
        }
        var ssig = bip340Sign(tweaked, digest, auxRand);
        mapSet(map, 0x13, new Uint8Array(0), hashType === 0x00 ? ssig : concatBytes(ssig, new Uint8Array([hashType])));
        mapSet(map, 0x17, new Uint8Array(0), pad32(inp.key.Q.x));
        var tapPath = concatBytes(new Uint8Array([0x00]), hexToBytes(hd.fingerprint), pathBytes(inp.key.indices));
        mapSet(map, 0x16, pad32(inp.key.Q.x), tapPath);
        mapSet(map, 0x07, new Uint8Array(0), new Uint8Array(0));
        mapSet(map, 0x08, new Uint8Array(0), concatBytes(writeVarInt(1), writeVarInt(ssig.length), ssig));
      } else {
        if (hashType !== 0x01) throw new Error('entrada ' + inp.index + ': só SIGHASH_ALL é suportado');
        var code = inp.kind === 'p2pkh' ? inp.script : p2pkhScript(inp.key.pub);
        var dg = inp.kind === 'p2pkh'
          ? sighashLegacy(tx, inp.index, code, hashType)
          : sighashV0(tx, inp.index, code, inp.value, hashType);
        var sig = signDigest(inp.key.d, dg);
        if (!verifyDigest(inp.key.Q, dg, sig.r, sig.s)) {
          throw new Error('entrada ' + inp.index + ': a assinatura ECDSA não verificou');
        }
        var sigWithType = concatBytes(sig.der, new Uint8Array([hashType]));
        mapSet(map, 0x02, inp.key.pub, sigWithType);
        mapSet(map, 0x06, inp.key.pub, concatBytes(hexToBytes(hd.fingerprint), pathBytes(inp.key.indices)));
        if (inp.kind === 'p2pkh') {
          mapSet(map, 0x07, new Uint8Array(0), concatBytes(pushData(sigWithType), pushData(inp.key.pub)));
        } else if (inp.kind === 'p2sh-p2wpkh') {
          var redeem = redeemFor(inp.key);
          mapSet(map, 0x04, new Uint8Array(0), redeem);
          mapSet(map, 0x07, new Uint8Array(0), pushData(redeem));
          mapSet(map, 0x08, new Uint8Array(0), concatBytes(writeVarInt(2),
            writeVarInt(sigWithType.length), sigWithType, writeVarInt(inp.key.pub.length), inp.key.pub));
        } else {
          mapSet(map, 0x07, new Uint8Array(0), new Uint8Array(0));
          mapSet(map, 0x08, new Uint8Array(0), concatBytes(writeVarInt(2),
            writeVarInt(sigWithType.length), sigWithType, writeVarInt(inp.key.pub.length), inp.key.pub));
        }
      }
      clearFinalizedFields(map);
    });

    var fin = psbtFinalTx(psbt);
    var feerate = fin.vsize > 0 ? Number(a.fee) / fin.vsize : 0;
    var signedBytes = writePsbt(psbt);
    return {
      psbt: signedBytes,
      psbtBase64: b64encode(signedBytes),
      txHex: fin.hex,
      txid: fin.txid,
      fee: a.fee, vsize: fin.vsize, feerate: feerate,
      inputs: a.inputs, outputs: a.outputs,
      totalIn: a.totalIn, totalOut: a.totalOut,
      warnings: a.warnings
    };
  }
  function readWitness(bytes) {
    var p = 0, out = [];
    var count = readVarInt(bytes, p); p += count.size;
    for (var i = 0; i < count.value; i++) {
      var len = readVarInt(bytes, p); p += len.size;
      out.push(bytes.subarray(p, p + len.value)); p += len.value;
    }
    if (p !== bytes.length) throw new Error('witness final truncado');
    return out;
  }

  /* -------------------------------------------------------------- derivar */
  function derive(bits) {
    if (bits.length !== 256) throw new Error('são necessários exatamente 256 bits');
    var d = BigInt('0b' + bits);
    if (d <= 0n || d >= N) throw new Error('os 256 bits caem fora do intervalo válido da curva (0 ou ≥ n)');
    var Q = pointFromD(d);
    var pubC = pubCompressed(Q);
    var pubU = pubUncompressed(Q);
    var xonly = pad32(Q.x);
    return {
      bits: bits,
      hex: bytesToHex(pad32(d)),
      mnemonic: bip39Mnemonic(bits),
      d: d,
      Q: Q,
      pubCompressed: pubC,
      pubUncompressed: pubU,
      wifCompressed: wif(d, true),
      wifUncompressed: wif(d, false),
      addresses: {
        p2pkh: p2pkh(pubC),
        p2pkhUncompressed: p2pkh(pubU),
        p2shP2wpkh: p2shP2wpkh(pubC),
        p2wpkh: p2wpkh(pubC),
        p2tr: p2tr(taprootOutputKey(xonly))
      }
    };
  }

  return {
    bytesToHex: bytesToHex, hexToBytes: hexToBytes, utf8: utf8, concatBytes: concatBytes,
    sha256: sha256, ripemd160: ripemd160, hash160: hash160, hmacSha256: hmacSha256,
    base58check: base58check, base58Encode: base58Encode,
    segwitAddress: segwitAddress, bechPolymod: bechPolymod,
    pad32: pad32, pointFromD: pointFromD, pubCompressed: pubCompressed, pubUncompressed: pubUncompressed,
    taprootOutputKey: taprootOutputKey, taggedHash: taggedHash,
    signDigest: signDigest, verifyDigest: verifyDigest, encodeDer: encodeDer,
    derive: derive, deriveHD: deriveHD, bip39Seed: bip39Seed,
    bip39Mnemonic: bip39Mnemonic, bip39Words: bip39Words,
    masterFromSeed: masterFromSeed, derivePath: derivePath, ckdPriv: ckdPriv,
    extendedKey: extendedKey, addressFor: addressFor, HD_ACCOUNTS: HD_ACCOUNTS,
    readTx: readTx, writeTx: writeTx, txidOf: txidOf, readTxOut: readTxOut, vsizeOf: vsizeOf,
    scriptForKind: scriptForKind, scriptKind: scriptKind, addressFromScript: addressFromScript,
    b64encode: b64encode, b64decode: b64decode,
    parsePsbt: parsePsbt, writePsbt: writePsbt, buildPsbt: buildPsbt, psbtParseInput: psbtParseInput,
    scriptFromAddress: scriptFromAddress, segwitDecode: segwitDecode, base58checkDecode: base58checkDecode,
    estimateVsize: estimateVsize,
    sighashLegacy: sighashLegacy, sighashV0: sighashV0, sighashTaproot: sighashTaproot,
    bip340Sign: bip340Sign, bip340Verify: bip340Verify, tweakPrivate: tweakPrivate,
    analyzePsbt: analyzePsbt, signPsbt: signPsbt, psbtFinalTx: psbtFinalTx,
    prevoutOf: prevoutOf, formatSats: formatSats,
    pathText: pathText, pathBytes: pathBytes, parsePath: parsePath,
    jAdd: jAdd, jMul: jMul, toAffine: toAffine, liftX: liftX,
    hmacSha512: hmacSha512, readWitness: readWitness, writeVarInt: writeVarInt,
    N: N, P: P
  };
})();


var __electrum = (function (BTC) {
/* Cliente mínimo do protocolo Electrum (JSON-RPC 1.4) sobre TCP/TLS.
   Usa `connect()` de `cloudflare:sockets`; o transporte é injetável
   (setConnectOverride) para os testes rodarem em Node.

   Sem chave privada: a consulta é por scripthash = sha256(scriptPubKey)
   com os bytes invertidos. Métodos usados:
     server.version
     server.ping
     blockchain.scripthash.get_history
     blockchain.scripthash.get_mempool
     blockchain.scripthash.subscribe
     blockchain.estimatefee
     blockchain.transaction.get
     blockchain.transaction.broadcast (só no proxy, com a transação já
       conferida pelo navegador)
   Uma conexão responde a muitas consultas (pipelining), então não há o
   limite de subrequests do fetch. */

/* Verificados em 2026-11: TLS 50002 e texto puro 50001 respondem
   `server.version` e `get_balance`. O TLS é o padrão; o texto puro só
   entra quando pedido explicitamente com `:tcp` (o caminho da rede vê os
   endereços consultados). */
const DEFAULT_SERVERS = [
  { host: 'electrum.blockstream.info', port: 50002, secure: true }
];

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_CONNECT_TIMEOUT = 6000;
const DEFAULT_CONCURRENCY = 20;
const MAX_BUFFER = 8 * 1024 * 1024;

function scripthash(script) {
  if (!script || typeof script.length !== 'number' || !script.length) {
    throw new Error('script inválido para scripthash');
  }
  const bytes = script instanceof Uint8Array ? script : new Uint8Array(script);
  const h = BTC.sha256(bytes);
  let out = '';
  for (let i = h.length - 1; i >= 0; i--) out += h[i].toString(16).padStart(2, '0');
  return out;
}

/* "host:porta[:tls|:tcp],..." — TLS por padrão; texto puro só com `:tcp`
   explícito. IPv6 entra entre colchetes: "[::1]:50002:tls". */
function parseServerList(text) {
  const out = [];
  for (const raw of String(text || '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    let host, portText, modeText;
    if (item[0] === '[') {
      const close = item.indexOf(']');
      if (close < 0) throw new Error('servidor Electrum inválido: ' + item);
      host = item.slice(1, close);
      const rest = item.slice(close + 1);
      const parts = rest[0] === ':' ? rest.slice(1).split(':') : [];
      if (!parts.length || parts.length > 2) {
        throw new Error('servidor Electrum inválido: ' + item);
      }
      portText = parts[0];
      modeText = parts[1];
    } else {
      const parts = item.split(':');
      if (parts.length > 3) throw new Error('servidor Electrum inválido: ' + item);
      host = parts[0];
      portText = parts[1];
      modeText = parts[2];
    }
    const port = Number(portText);
    if (!host || !portText || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('servidor Electrum inválido: ' + item);
    }
    const mode = String(modeText || 'tls').toLowerCase();
    if (mode !== 'tls' && mode !== 'tcp') {
      throw new Error('transporte inválido em ' + item + ' (use tls ou tcp)');
    }
    out.push({ host, port, secure: mode === 'tls' });
  }
  if (!out.length) throw new Error('lista de servidores Electrum vazia');
  return out;
}

let connectOverride = null;
/* Seam de teste: em Node não existe `cloudflare:sockets`. */
function setConnectOverride(fn) { connectOverride = fn || null; }

async function loadConnect() {
  if (connectOverride) return connectOverride;
  const mod = await import('cloudflare:sockets');
  return mod.connect;
}

function withDeadline(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

class ElectrumClient {
  constructor(socket, info, opts) {
    const o = opts || {};
    this.socket = socket;
    this.server = { host: info.host, port: info.port, secure: !!info.secure };
    this.timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT;
    this.version = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.dead = null;
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    this.writeQueue = Promise.resolve();
    this.onNotification = null;
    this.pump = this._read();
  }

  get name() { return this.server.host + ':' + this.server.port; }

  _fail(err) {
    if (this.dead) return;
    this.dead = err instanceof Error ? err : new Error('' + err);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.dead);
    }
    this.pending.clear();
    try { if (this.socket.close) this.socket.close(); } catch (e) {}
    try { this.reader.cancel().catch(() => {}); } catch (e) {}
    try { this.writer.close().catch(() => {}); } catch (e) {}
  }

  _line(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return this._fail(new Error('resposta não-JSON do Electrum')); }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      if (m.method && m.id === undefined) {
        if (this.onNotification) {
          try { this.onNotification(m.method, m.params || []); } catch (e) {}
        }
        continue; // notificação (scripthash.subscribe, headers.subscribe)
      }
      const p = this.pending.get(m.id);
      if (!p) continue; // notificação ou resposta já expirada
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error((p.method || 'electrum') + ': ' + (m.error.message || JSON.stringify(m.error))));
      } else {
        p.resolve(m.result);
      }
    }
  }

  async _read() {
    try {
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        if (this.buffer.length > MAX_BUFFER) throw new Error('resposta grande demais do Electrum');
        let cut;
        while ((cut = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, cut).trim();
          this.buffer = this.buffer.slice(cut + 1);
          if (line) this._line(line);
        }
      }
      this._fail(new Error('conexão Electrum encerrada pelo servidor'));
    } catch (e) {
      this._fail(e);
    }
  }

  _write(text) {
    const data = this.encoder.encode(text);
    this.writeQueue = this.writeQueue.then(() => this.writer.write(data));
    return this.writeQueue;
  }

  request(method, params) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        /* só este pedido falha: derrubar a conexão por um timeout de
           consulta matava todos os pedidos em voo de um lote. O socket
           continua válido; uma resposta atrasada cai no `pending` vazio.
           Falha de socket é outra coisa: _read/_write chamam _fail. */
        this.pending.delete(id);
        reject(new Error('timeout de ' + this.timeoutMs + ' ms em ' + method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this._write(JSON.stringify({ id, method, params: params || [] }) + '\n')
      .catch(e => this._fail(e));
    return promise;
  }

  /* Pipelining com janela: mantém `concurrency` pedidos em voo, devolve na ordem. */
  async requestMany(items, concurrency) {
    const limit = Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY);
    const out = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await this.request(items[i].method, items[i].params);
      }
    };
    const workers = [];
    for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  async serverVersion(label) {
    this.version = await this.request('server.version', [label || 'btc/1.0', '1.4']);
    return this.version;
  }

  async ping() {
    return await this.request('server.ping', []);
  }

  async close() {
    if (this.dead) {
      this.dead = this.dead || new Error('fechado');
      return;
    }
    this.dead = new Error('conexão Electrum fechada pelo cliente');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.dead);
    }
    this.pending.clear();
    try { await this.socket.close(); } catch (e) {}
  }
}

/* Abre a primeira conexão que responder, na ordem da lista. */
async function openElectrum(opts) {
  const o = opts || {};
  const servers = o.servers && o.servers.length ? o.servers : DEFAULT_SERVERS;
  const connectTimeoutMs = Number(o.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT;
  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT;
  const label = o.label || 'btc/1.0';

  let connectFn;
  try {
    connectFn = await loadConnect();
  } catch (e) {
    throw new Error('TCP indisponível neste runtime (cloudflare:sockets): ' +
      (e && e.message ? e.message : e));
  }
  if (typeof connectFn !== 'function') throw new Error('connect() TCP indisponível neste runtime');

  const failures = [];
  for (const server of servers) {
    let socket = null;
    let client = null;
    try {
      const address = { hostname: server.host, port: server.port };
      const options = server.secure ? { secureTransport: 'on' } : {};
      socket = connectFn(address, options);
      await withDeadline(Promise.resolve(socket.opened), connectTimeoutMs,
        'timeout de conexão com ' + server.host + ':' + server.port);
      client = new ElectrumClient(socket, server, { timeoutMs });
      await client.serverVersion(label);
      return client;
    } catch (e) {
      failures.push(server.host + ':' + server.port + ' → ' + (e && e.message ? e.message : e));
      if (client) { try { await client.close(); } catch (_) {} }
      else if (socket) { try { await socket.close(); } catch (_) {} }
    }
  }
  const err = new Error('nenhum servidor Electrum respondeu: ' + failures.join('; '));
  err.failures = failures;
  throw err;
}

/* Histórico + mempool de vários scripts numa conexão só.
   Devolve, por script, um Map txid → altura (0 = mempool). */
async function historiesMany(client, scripts, opts) {
  const o = opts || {};
  const shs = scripts.map(s => scripthash(s));
  const items = [];
  for (const sh of shs) {
    items.push({ method: 'blockchain.scripthash.get_history', params: [sh] });
    items.push({ method: 'blockchain.scripthash.get_mempool', params: [sh] });
  }
  const out = await client.requestMany(items, o.concurrency);
  return shs.map((sh, i) => {
    const heights = new Map();
    for (const h of (out[i * 2] || [])) {
      if (h && h.tx_hash) heights.set(h.tx_hash, Number(h.height) > 0 ? Number(h.height) : 0);
    }
    for (const m of (out[i * 2 + 1] || [])) {
      if (m && m.tx_hash && !heights.has(m.tx_hash)) heights.set(m.tx_hash, 0);
    }
    return { scripthash: sh, heights, txids: [...heights.keys()], txCount: heights.size };
  });
}

/* Transações cruas (hex) em lote. Tolera txid que sumiu (mempool que caiu,
   reorg): devolve o que veio e o erro por txid, sem derrubar o lote. */
async function transactionsMany(client, txids, opts) {
  const o = opts || {};
  const limit = Math.max(1, Number(o.concurrency) || 8);
  const raw = new Map();
  const errors = new Map();
  if (typeof client.requestManySettled === 'function') {
    const settled = await client.requestManySettled(txids.map(txid => ({
      method: 'blockchain.transaction.get', params: [txid]
    })));
    settled.forEach((item, i) => {
      const txid = txids[i];
      if (item.status === 'fulfilled') raw.set(txid, item.value);
      else errors.set(txid, item.reason && item.reason.message ? item.reason.message : '' + item.reason);
    });
    return { raw, errors };
  }
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= txids.length) return;
      const txid = txids[i];
      try { raw.set(txid, await client.request('blockchain.transaction.get', [txid])); }
      catch (e) { errors.set(txid, e && e.message ? e.message : '' + e); }
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(limit, txids.length); k++) workers.push(worker());
  await Promise.all(workers);
  return { raw, errors };
}

/* Taxa ao vivo: só o `blockchain.estimatefee` do Bitcoin Core.

   O valor vem em BTC/kvB e é usado como veio, sem histograma, mediana,
   corte de fila ou passo de arredondamento. O alvo é 2 blocos porque o Core
   se recusa a estimar 1 ("It's not possible to get reasonable estimates for
   confTarget of 1").

   O estimador é histórico: olha o que os blocos já minerados cobraram, não a
   fila atual. Por isso pode ficar acima da fila quando ela está baixa e
   abaixo quando ela sobe. É a única fonte de taxa do projeto; não há
   fallback para histograma.

   O valor NÃO é arredondado: BTC/kvB × 1e8 dá sat/kvB inteiro exato (é a
   unidade em que o servidor de fato responde: 1926, 970, 112), e `sat_per_vb`
   é só a leitura ÷1000. Arredondar a taxa antes de multiplicar pela vsize
   erra sempre para cima, então o PSBT recebe o valor exato e arredonda
   apenas a taxa final, em satoshis (ver `feeSats` em psbt.js).

   `levels` (o que a tela escolhe e o PSBT usa) pode ficar abaixo de 1 sat/vB:
   não há piso econômico na carteira, só o piso de relay. `floored` marca o
   nível abaixo do piso padrão atual do Bitcoin Core (`-minrelaytxfee` =
   0,1 sat/vB desde a v30) e a tela mostra o aviso para o nível escolhido. */
const ESTIMATE_TARGETS = { next: 2 };

/* Piso de relay padrão do Bitcoin Core (`-minrelaytxfee`): 100 sat/kvB =
   0,1 sat/vB desde a v30 (nas versões anteriores era 1000 sat/kvB). */
const RELAY_MIN_KVB = 100;

async function estimateFees(client) {
  const keys = Object.keys(ESTIMATE_TARGETS);
  // um nível que o servidor não estima vira null (a tela desabilita aquele
  // nível); não há outra fonte de taxa.
  const values = await Promise.all(keys.map(k =>
    client.request('blockchain.estimatefee', [ESTIMATE_TARGETS[k]]).catch(() => null)
  ));
  const levels = {};
  const satPerKvb = {};
  const satPerVb = {};
  const floored = {};
  keys.forEach((k, i) => {
    const v = Number(values[i]);
    // × 1e8 em vez de × 1e5: sat/kvB é inteiro e exato; 0.0000097 * 1e5 daria
    // 0.9700000000000001, e sat/vB só existe para a tela
    const kvb = Number.isFinite(v) && v > 0 ? Math.round(v * 1e8) : null;
    satPerKvb[k] = kvb;
    satPerVb[k] = kvb === null ? null : kvb / 1000;
    floored[k] = kvb !== null && kvb < RELAY_MIN_KVB;
    levels[k] = kvb === null ? null : kvb / 1000;
  });
  return {
    levels,
    targets: { ...ESTIMATE_TARGETS },
    sat_per_kvb: satPerKvb,
    sat_per_vb: satPerVb,
    floored,
    relay_min_kvb: RELAY_MIN_KVB,
    unit: 'sat/vB',
    source: 'electrum',
    updated_at: new Date().toISOString()
  };
}

return {
  historiesMany: historiesMany, transactionsMany: transactionsMany,
  estimateFees: estimateFees, scripthash: scripthash,
  RELAY_MIN_KVB: RELAY_MIN_KVB
};
})(BTC);
var __deriv = (function (BTC) {

/* Derivação pública (CKDpub) e endereços dos quatro tipos de conta.
   Tudo local; a xpub é a única entrada. */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const TYPE_INFO = {
  bip86: { label: 'bip86 · taproot (p2tr)', purpose: 86, kind: 'p2tr' },
  bip84: { label: 'bip84 · segwit (p2wpkh)', purpose: 84, kind: 'p2wpkh' },
  bip49: { label: 'bip49 · segwit aninhado (p2sh-p2wpkh)', purpose: 49, kind: 'p2sh-p2wpkh' },
  bip44: { label: 'bip44 · legacy (p2pkh)', purpose: 44, kind: 'p2pkh' }
};

function hex(b) { return BTC.bytesToHex(b); }
function fromHex(h) { return BTC.hexToBytes(h); }
function bytes() { return BTC.concatBytes.apply(null, arguments); }

function b58decode(text) {
  const s = String(text).trim();
  /* O laço abaixo é quadrático no tamanho da entrada: um texto arbitrariamente
     longo prende o isolate antes de qualquer validação de formato. */
  if (s.length > 256) throw new Error('texto base58 grande demais');
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

function parseXpub(text) {
  const s = String(text).trim();
  if (s.length > 111) throw new Error('xpub com tamanho inválido');
  const raw = b58decode(s);
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

function parsePoint(pub) {
  if (pub.length !== 33 || (pub[0] !== 2 && pub[0] !== 3)) throw new Error('ponto inválido');
  const x = BigInt('0x' + hex(pub.subarray(1)));
  let Q = BTC.liftX(x);
  if (!Q) throw new Error('ponto inválido');
  if ((pub[0] & 1) !== Number(Q.y & 1n)) Q = { x: Q.x, y: BTC.P - Q.y };
  return Q;
}

async function ckdPub(node, index) {
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

function p2pkhAddress(node) {
  return BTC.base58check(bytes(Uint8Array.of(0x00), BTC.hash160(node.pub)));
}
function p2wpkhScript(node) {
  return bytes(Uint8Array.of(0x00, 0x14), BTC.hash160(node.pub));
}
function p2wpkhAddress(node) {
  return BTC.segwitAddress('bc', 0, BTC.hash160(node.pub));
}
function p2shP2wpkhScript(node) {
  return bytes(Uint8Array.of(0xa9, 0x14), BTC.hash160(p2wpkhScript(node)), Uint8Array.of(0x87));
}
function p2shP2wpkhAddress(node) {
  return BTC.base58check(bytes(Uint8Array.of(0x05), BTC.hash160(p2wpkhScript(node))));
}
function p2pkhScript(node) {
  return bytes(Uint8Array.of(0x76, 0xa9, 0x14), BTC.hash160(node.pub), Uint8Array.of(0x88, 0xac));
}
function p2trScript(node) {
  return bytes(Uint8Array.of(0x51, 0x20), BTC.taprootOutputKey(node.pub.subarray(1)));
}
function p2trAddress(node) {
  return BTC.segwitAddress('bc', 1, BTC.taprootOutputKey(node.pub.subarray(1)));
}

function addressForType(type, node) {
  if (type === 'bip84') return p2wpkhAddress(node);
  if (type === 'bip49') return p2shP2wpkhAddress(node);
  if (type === 'bip44') return p2pkhAddress(node);
  return p2trAddress(node);
}
function scriptForType(type, node) {
  if (type === 'bip84') return p2wpkhScript(node);
  if (type === 'bip49') return p2shP2wpkhScript(node);
  if (type === 'bip44') return p2pkhScript(node);
  return p2trScript(node);
}

function pathFor(type, chain, index) {
  const p = TYPE_INFO[type] ? TYPE_INFO[type].purpose : 86;
  return "m/" + p + "'/0'/0'/" + chain + "/" + index;
}

async function chainNode(account, chain) {
  if (chain !== 0 && chain !== 1) throw new Error('cadeia inválida');
  return ckdPub(account, chain);
}

async function deriveChild(type, chainNodeValue, chain, index) {
  const child = await ckdPub(chainNodeValue, index);
  return {
    address: addressForType(type, child),
    pub: child.pub,
    script: scriptForType(type, child),
    path: pathFor(type, chain, index)
  };
}

async function deriveAddress(type, account, chain, index) {
  const cn = await chainNode(account, chain);
  return deriveChild(type, cn, chain, index);
}

return {
  parseXpub: parseXpub, chainNode: chainNode, deriveChild: deriveChild,
  deriveAddress: deriveAddress, addressForType: addressForType,
  scriptForType: scriptForType, pathFor: pathFor, TYPE_INFO: TYPE_INFO
};
})(BTC);
var __totals = (function (BTC) {
/* Totais por endereço a partir das transações cruas.

   É a mesma conta que o Electrum e o Sparrow fazem: o saldo de um script é
   a soma das saídas que pagam esse script menos as que já foram gastas;
   `received` é a soma de todas as saídas e `spent` a soma das gastas.
   A altura vem do histórico do servidor (0 = mempool): o que ainda não está
   em bloco fica separado do confirmado, tanto na entrada (received) quanto na
   saída (spent). O saldo disponível que a tela exibe (e que o envio usa) é o
   de `utxosForScripts`: confirmado não gasto mais o troco de uma transação
   nossa ainda pendente; pagamento de terceiro só conta depois de confirmar.

   Entrada:
     entries = [{ txid, height, outputs: [{value, script}], inputs: [{txid, vout}] }]
     scripts = Set de scriptPubKey em hex que pertencem à carteira
   Saída: Map<hexScript, {received, spent, balance, confirmed, unconfirmed,
     receivedConfirmed, spentConfirmed, unconfirmedIn, unconfirmedOut, txCount}> */

function hex(bytes) { return BTC.bytesToHex(bytes); }

function totalsForScripts(entries, scripts) {
  const acc = new Map();
  const ensure = script => {
    let a = acc.get(script);
    if (!a) {
      a = { received: 0, spent: 0, receivedConfirmed: 0, spentConfirmed: 0, txids: new Set() };
      acc.set(script, a);
    }
    return a;
  };

  // 1. todas as saídas que pagam um script nosso (o mesmo outpoint pode ser
  //    referenciado por uma transação que aparece antes na lista).
  const ownOutputs = new Map();
  for (const tx of entries) {
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const script = hex(tx.outputs[vout].script);
      if (!scripts.has(script)) continue;
      const value = Number(tx.outputs[vout].value) || 0;
      const a = ensure(script);
      a.received += value;
      if (tx.height > 0) a.receivedConfirmed += value;
      a.txids.add(tx.txid);
      ownOutputs.set(tx.txid + ':' + vout, { script, value });
    }
  }

  // 2. entradas que gastam uma saída nossa (o valor está na transação de origem)
  for (const tx of entries) {
    for (const input of tx.inputs) {
      const prev = ownOutputs.get(input.txid + ':' + input.vout);
      if (!prev) continue;
      const a = ensure(prev.script);
      a.spent += prev.value;
      if (tx.height > 0) a.spentConfirmed += prev.value;
      a.txids.add(tx.txid);
    }
  }

  const out = new Map();
  for (const [script, a] of acc) {
    const balance = a.received - a.spent;
    const confirmed = a.receivedConfirmed - a.spentConfirmed;
    out.set(script, {
      received: a.received,
      spent: a.spent,
      balance,
      confirmed,
      unconfirmed: balance - confirmed,
      receivedConfirmed: a.receivedConfirmed,
      spentConfirmed: a.spentConfirmed,
      unconfirmedIn: a.received - a.receivedConfirmed,
      unconfirmedOut: a.spent - a.spentConfirmed,
      txCount: a.txids.size
    });
  }
  return out;
}

/* Saídas ainda não gastas que pagam um script da carteira.

   Mesma entrada de totalsForScripts. Uma saída nossa só deixa de ser UTXO
   quando alguma transação conhecida (do histórico dos nossos scripts) a
   gasta; é o mesmo conjunto de transações que fecha o saldo, então os dois
   números não divergem. `height` 0 é mempool.

   Cada saída leva `own`: true quando a transação que a criou gasta uma saída
   nossa que já é gastável (confirmada ou troco de uma transação nossa
   anterior). É o troco/autotransferência de uma transação nossa ainda
   pendente — ele pode ser gasto antes da confirmação. Pagamento de terceiro
   também tem `height` 0, mas fica com `own` false: ainda não é saldo. */
function utxosForScripts(entries, scripts) {
  const own = new Map();
  const outputsOf = new Map();
  for (const tx of entries) {
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const out = tx.outputs[vout];
      const script = hex(out.script);
      if (!scripts.has(script)) continue;
      const key = tx.txid + ':' + vout;
      own.set(key, {
        txid: tx.txid, vout, value: Number(out.value) || 0,
        script, height: tx.height || 0, own: false
      });
      if (!outputsOf.has(tx.txid)) outputsOf.set(tx.txid, []);
      outputsOf.get(tx.txid).push(key);
    }
  }

  const spenders = new Map();
  for (const tx of entries) {
    for (const input of tx.inputs) {
      const key = input.txid + ':' + input.vout;
      if (!own.has(key)) continue;
      if (!spenders.has(key)) spenders.set(key, []);
      spenders.get(key).push(tx.txid);
    }
  }

  /* Percorre a partir das saídas confirmadas: quem gasta uma saída nossa
     gastável é uma transação nossa (só o dono assina), e as saídas dela que
     pagam a carteira passam a ser troco gastável. O laço cobre o gasto
     encadeado do próprio troco (troco do troco). */
  const ownTx = new Set();
  const queue = [];
  for (const [key, utxo] of own) if (utxo.height > 0) queue.push(key);
  while (queue.length) {
    const key = queue.pop();
    for (const txid of spenders.get(key) || []) {
      if (ownTx.has(txid)) continue;
      ownTx.add(txid);
      for (const outKey of outputsOf.get(txid) || []) queue.push(outKey);
    }
  }

  const spent = new Set();
  for (const tx of entries) {
    for (const input of tx.inputs) {
      const key = input.txid + ':' + input.vout;
      if (own.has(key)) spent.add(key);
    }
  }
  return [...own.entries()]
    .filter(([key]) => !spent.has(key))
    .map(([, utxo]) => ({ ...utxo, own: ownTx.has(utxo.txid) }))
    .sort((a, b) => (a.height === 0 ? 1 : 0) - (b.height === 0 ? 1 : 0) || b.value - a.value);
}

return { totalsForScripts: totalsForScripts, utxosForScripts: utxosForScripts };
})(BTC);
var __psbt = (function (BTC) {
/* Montagem do PSBT de envio (v0, sem assinatura).

   O lado watch-only só tem chaves públicas/scripts derivados: escolhe UTXOs, calcula a taxa pela vsize
   estimada, deriva o troco e escreve o PSBT com a origem BIP32 de cada
   entrada. A chave privada nunca chega aqui; quem assina é o Cofre BTC,
   offline.

   A origem leva a impressão digital da CONTA, e não a da raiz: é o máximo
   que a xpub permite conhecer. O caminho continua completo (m/84'/0'/0'/0/i)
   e o assinante confere a chave e o script antes de usar, então a origem é
   uma dica de derivação, não uma prova de identidade. */

/* Abaixo disso a saída de troco vira pó e é mais barato somar à taxa. O
   valor é conservador: cobre p2pkh (546) e fica acima do pó de p2wpkh e
   p2tr, que é menor. */
const DUST_SATS = 546;

/* Faixa aceita para a taxa, em sat/vB. O estimador responde em sat/kvB, então
   a taxa pode ter casas decimais; a conta é feita em sat/kvB inteiro e só o
   valor final da taxa vira satoshi inteiro (ver `feeSats`). Não há piso de
   relay: a taxa estimada é usada como veio, inclusive abaixo de 1 sat/vB. O
   mínimo é o menor valor que o sat/kvB representa (1 sat/kvB). */
const FEE_RATE_MIN = 0.001;
const FEE_RATE_MAX = 10000;

/* sat/vB (com casas, se vier do estimador) → sat/kvB inteiro, que é a unidade
   exata do dado. Recusa o que está fora da faixa ou não é número. */
function feeRateKvb(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n < FEE_RATE_MIN || n > FEE_RATE_MAX) {
    throw new Error('taxa inválida: use de 0,001 a 10 000 sat/vB');
  }
  return Math.round(n * 1000);
}

/* Taxa em satoshis: sat/kvB × vsize ÷ 1000, arredondada para cima só aqui.
   O produto (kvb ≤ 1e7, vsize de alguns milhares) é exato em double, e manter
   a taxa sem arredondar evita pagar a mais: 1,926 sat/vB em 141 vB custa 272
   sats, e não os 282 que 2 sat/vB custariam. */
function feeSats(kvb, vsize) {
  return Math.ceil(kvb * vsize / 1000);
}

function hex(bytes) { return BTC.bytesToHex(bytes); }

/* No modo watch o cliente manda a impressão digital já calculada; no modo
   legado ela sai da chave pública da conta. */
function accountFingerprint(account, fingerprint) {
  const fp = String(fingerprint || '').toLowerCase();
  if (/^[0-9a-f]{8}$/.test(fp)) return fp;
  if (account && account.pub) return hex(BTC.hash160(account.pub)).slice(0, 8);
  throw new Error('impressão digital da conta indisponível');
}

/* Endereço de troco → linha do scanner (já derivada), no mesmo formato das
   entradas. */
function rowOrigin(row, fingerprint) {
  return {
    fingerprint,
    path: row.path,
    pub: BTC.hexToBytes(row.pub)
  };
}

function utxoInput(utxo, fingerprint) {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    value: utxo.value,
    script: BTC.hexToBytes(utxo.script),
    kind: utxo.row.kind,
    pub: BTC.hexToBytes(utxo.row.pub),
    path: utxo.row.path,
    fingerprint
  };
}

function estimateFor(selected, scripts) {
  return BTC.estimateVsize(
    selected.map(u => u.row.kind),
    scripts
  );
}

/* Entram na escolha a saída confirmada e o troco de uma transação nossa
   ainda pendente (gasto encadeado). O que está no mempool por pagamento de
   terceiro não é saldo, então fica de fora do envio e do limite. */
function spendableUtxos(utxos) {
  return (utxos || []).filter(u => Number(u.height) > 0 || u.own);
}

/* Entradas que valem menos que a taxa de gastá-las saem do máximo enviável:
   incluí-las custa mais do que elas valem. Continuam sendo suas (entram no
   saldo), mas não compensam entrar numa transação. A diferença de taxa entre
   gastar a carteira toda e gastar sem uma entrada é exatamente a taxa daquela
   entrada, e é isso que a comparação usa. */
function economicalUtxos(utxos, rateKvb, recipientScript) {
  if (!utxos.length) return utxos;
  const kinds = utxos.map(u => u.row.kind);
  const feeAll = feeSats(rateKvb, BTC.estimateVsize(kinds, [recipientScript]));
  /* Teto da taxa de uma entrada (p2pkh é a mais pesada). Acima dele a entrada
     compensa com certeza, e a conta exata só roda para as pequenas — que são
     poucas, mas podem ser muitas: com muitas, o corte continua O(n) vezes o
     custo de uma vsize. */
  const heaviest = feeSats(rateKvb,
    BTC.estimateVsize(['p2pkh'], [recipientScript]) - BTC.estimateVsize([], [recipientScript]));
  return utxos.filter((u, i) => {
    if (u.value > heaviest) return true;
    const rest = kinds.slice(0, i).concat(kinds.slice(i + 1));
    const feeRest = feeSats(rateKvb, BTC.estimateVsize(rest, [recipientScript]));
    return u.value > feeAll - feeRest;
  });
}

/* Peso relativo de cada tipo de entrada, só para o desempate: gastar p2tr
   custa menos vB que gastar p2pkh. A taxa calculada já carrega essa
   diferença; este ranking serve para ordenar a busca de forma estável. */
const KIND_ORDER = { p2tr: 0, p2wpkh: 1, 'p2sh-p2wpkh': 2, p2pkh: 3 };

function kindOf(utxo) {
  return (utxo && utxo.row && utxo.row.kind) || 'p2wpkh';
}
function kindRank(utxo) {
  const r = KIND_ORDER[kindOf(utxo)];
  return r === undefined ? 9 : r;
}

/* Um arranjo de entradas vira candidato quando cobre o valor. Há duas formas
   e elas não se misturam:
   - com troco, quando o resto passa do pó e vira saída;
   - sem troco, quando o resto fica abaixo do pó: ele é somado à taxa, porque
     criar a saída custaria mais do que esse resto.
   `stake` é o que sobra para o usuário ou para a taxa: é o número que a
   escolha minimiza dentro de cada forma. */
function candidateFor(selected, amountSats, rateKvb, recipientScript, changeScript) {
  let total = 0;
  for (const u of selected) total += u.value;
  const vsizeNoChange = estimateFor(selected, [recipientScript]);
  const feeNoChange = feeSats(rateKvb, vsizeNoChange);
  if (total < amountSats + feeNoChange) return null;
  if (changeScript) {
    const vsizeChange = estimateFor(selected, [recipientScript, changeScript]);
    const feeChange = feeSats(rateKvb, vsizeChange);
    const change = total - amountSats - feeChange;
    if (change >= DUST_SATS) {
      return {
        selected, total, fee: feeChange, change, vsize: vsizeChange,
        withChange: true, stake: change
      };
    }
  }
  return {
    selected, total, fee: total - amountSats, change: 0, vsize: vsizeNoChange,
    withChange: false, stake: total - amountSats - feeNoChange
  };
}

/* Altura só compara o que está confirmado: entrada no mempool é tratada
   como a menos assentada, e não como a "mais antiga" (altura 0). */
function oldestHeight(selected) {
  let h = Infinity;
  for (const u of selected) {
    const height = Number(u.height) || 0;
    if (height > 0 && height < h) h = height;
  }
  return h;
}

/* Desempate final, reprodutível: primeiro a derivação (cadeia e índice, na
   ordem em que aparecem), depois a própria saída. Sem isto, dois candidatos
   equivalentes ficariam na ordem em que o servidor devolveu os UTXOs. */
function tieKey(selected) {
  const byDerivation = selected
    .map(u => String(u.row && u.row.chain) + ':' + String(u.row && u.row.idx).padStart(10, '0'))
    .sort().join(',');
  const byOutpoint = selected.map(u => u.txid + ':' + u.vout).sort().join(',');
  return byDerivation + '|' + byOutpoint;
}

/* Ordem reprodutível de uma saída: cadeia, índice, outpoint. */
function cmpUtxo(a, b) {
  return (a.row.chain - b.row.chain) || (a.row.idx - b.row.idx) ||
    (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0) || (a.vout - b.vout);
}

/* Ordem da escolha, do critério mais forte para o mais fraco:
   1. menos entradas (menos taxa e menos vínculo entre notas);
   2. sem troco antes de com troco (não publica saída de troco);
   3. menor sobra/troco;
   4. menor taxa (o que resolve "tipo mais barato");
   5. mais confirmações (bloco mais antigo);
   6. menor índice de derivação, depois o outpoint. */
function better(a, b) {
  if (!b) return true;
  if (a.selected.length !== b.selected.length) return a.selected.length < b.selected.length;
  if (a.withChange !== b.withChange) return !a.withChange;
  if (a.stake !== b.stake) return a.stake < b.stake;
  if (a.fee !== b.fee) return a.fee < b.fee;
  const ha = oldestHeight(a.selected);
  const hb = oldestHeight(b.selected);
  if (ha !== hb) return ha < hb;
  return tieKey(a.selected) < tieKey(b.selected);
}

function consider(best, selected, amountSats, rateKvb, recipientScript, changeScript) {
  const c = candidateFor(selected, amountSats, rateKvb, recipientScript, changeScript);
  return c && better(c, best) ? c : best;
}

/* Duas entradas: por par de tipos, a menor soma que cobre. A taxa é fixa
   dentro do par, então a menor soma é também o menor troco. São dez
   combinações de tipo no máximo e, em cada uma, uma busca binária por
   entrada: o custo é O(n log n) por combinação. */
function bestPair(pool, amountSats, rateKvb, recipientScript, changeScript) {
  const byKind = new Map();
  for (const u of pool) {
    const k = kindOf(u);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(u);
  }
  const kinds = [...byKind.keys()];
  const asc = (a, b) => (a.value - b.value) || cmpUtxo(a, b);
  for (const list of byKind.values()) list.sort(asc);
  let best = null;
  for (let i = 0; i < kinds.length; i++) {
    for (let j = i; j < kinds.length; j++) {
      const a = byKind.get(kinds[i]);
      const b = byKind.get(kinds[j]);
      const same = i === j;
      if (same && a.length < 2) continue;
      const target = amountSats + feeSats(rateKvb,
        BTC.estimateVsize([kinds[i], kinds[j]], [recipientScript]));
      for (let p = 0; p < a.length; p++) {
        const lo = same ? p + 1 : 0;
        if (lo >= b.length) continue;
        const need = target - a[p].value;
        let left = lo;
        let right = b.length;
        while (left < right) {
          const mid = (left + right) >> 1;
          if (b[mid].value >= need) right = mid;
          else left = mid + 1;
        }
        if (left < b.length) {
          best = consider(best, [a[p], b[left]], amountSats, rateKvb,
            recipientScript, changeScript);
        }
      }
    }
  }
  return best;
}

/* Três ou mais entradas (só quando uma ou duas não cobrem): as maiores
   primeiro, que é o que fecha com menos entradas, e depois uma passada que
   devolve entradas enquanto o resto ainda cobre. Quando a seleção usa a
   carteira inteira, nada é devolvido: o máximo enviável é justamente a
   transação que gasta tudo. */
function bestMany(pool, amountSats, rateKvb, recipientScript, changeScript) {
  const desc = [...pool].sort((a, b) => (b.value - a.value) || (kindRank(a) - kindRank(b)) ||
    cmpUtxo(a, b));
  const selected = [];
  let best = null;
  for (const u of desc) {
    selected.push(u);
    const c = candidateFor(selected, amountSats, rateKvb, recipientScript, changeScript);
    if (c) { best = c; break; }
  }
  if (!best || best.selected.length === pool.length) return best;
  let again = true;
  while (again) {
    again = false;
    const order = best.selected.slice().sort((a, b) => a.value - b.value);
    for (const u of order) {
      if (best.selected.length < 3) break;
      const rest = best.selected.filter(x => x !== u);
      const c = candidateFor(rest, amountSats, rateKvb, recipientScript, changeScript);
      if (c) { best = c; again = true; break; }
    }
  }
  return best;
}

/* Ordem das entradas do PSBT: derivação e outpoint, para o resultado não
   depender de como o servidor devolveu a lista nem de qual regra escolheu. */
function finalize(pick) {
  const selected = pick.selected.slice().sort(cmpUtxo);
  return {
    selected, total: pick.total, fee: pick.fee, change: pick.change,
    vsize: pick.vsize, withChange: pick.withChange
  };
}

function bestFor(pool, amountSats, rateKvb, recipientScript, changeScript) {
  if (!pool.length) return null;
  let best = null;
  /* 1 e 2: uma entrada que cobre, sem troco antes de com troco. */
  for (const u of pool) {
    best = consider(best, [u], amountSats, rateKvb, recipientScript, changeScript);
  }
  if (best) return best;
  /* 3: duas entradas, o menor par que cobre. */
  best = bestPair(pool, amountSats, rateKvb, recipientScript, changeScript);
  if (best) return best;
  /* 4: três ou mais. */
  return bestMany(pool, amountSats, rateKvb, recipientScript, changeScript);
}

/* Escolhe as entradas nesta ordem: a menor que cobre sozinha (com troco ou
   com o resto virando pó), depois o menor par que cobre e, por fim, as
   maiores de todas. As confirmadas vêm antes do troco pendente: só quando
   elas não bastam o troco nosso que ainda está no mempool entra. Nada de
   aviso: o resultado é o mesmo pedido de sempre, só que com a sobra menor e
   sem publicar saída de troco quando ela não é necessária. */
function selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript) {
  const rateKvb = feeRateKvb(feeRate);
  const spendable = spendableUtxos(utxos);
  const confirmed = spendable.filter(u => Number(u.height) > 0);
  let pick = bestFor(confirmed, amountSats, rateKvb, recipientScript, changeScript);
  if (!pick && confirmed.length !== spendable.length) {
    pick = bestFor(spendable, amountSats, rateKvb, recipientScript, changeScript);
  }
  if (pick) return finalize(pick);
  const available = spendable.reduce((s, u) => s + u.value, 0);
  const error = new Error('saldo disponível insuficiente: disponível ' + available +
    ' sats, precisa de ' + amountSats + ' sats + taxa' +
    ' (entrada de terceiro no mempool só conta depois de confirmada)');
  error.available = available;
  error.needed = amountSats;
  throw error;
}

/* Limite de envio para a taxa escolhida: o máximo é o total disponível
   (confirmado + troco nosso ainda pendente) menos a taxa da transação que
   gasta todas as entradas e manda todo o resto ao destino (sem troco).
   Entrada que vale menos do que a taxa de gastá-la fica fora dessa conta:
   mandá-la custa mais do que ela vale, então ela continua no saldo mas não
   entra no máximo. Sem esse corte, `selectCoins` deixaria a nota de fora e
   devolveria troco num envio "de tudo". Assim o máximo anunciado é sempre
   aceito e gasto até o fim.
   Com `quoteRates`, devolve também `quotes`: a taxa de cada nível estimado
   para o mesmo valor, que a legenda do seletor mostra em BTC. */
function sendLimits({ utxos, address, feeRate, amountSats, changeScript, quoteRates }) {
  const rateKvb = feeRateKvb(feeRate);
  const recipientScript = BTC.scriptFromAddress(address);
  const spendable = spendableUtxos(utxos);
  const available = spendable.reduce((sum, u) => sum + u.value, 0);
  const economical = economicalUtxos(spendable, rateKvb, recipientScript);
  const spendableTotal = economical.reduce((sum, u) => sum + u.value, 0);
  const vsize = BTC.estimateVsize(economical.map(u => u.row.kind), [recipientScript]);
  const feeAtMax = feeSats(rateKvb, vsize);
  const max = spendableTotal - feeAtMax;
  const limits = {
    recipient: address,
    available_sats: available,
    min_sats: DUST_SATS,
    max_send_sats: max >= DUST_SATS ? max : 0,
    fee_sats_at_max: feeAtMax,
    vsize_at_max: vsize,
    fee_rate: feeRate,
    fee_rate_kvb: rateKvb
  };
  /* Com o valor em mãos, o preview devolve a taxa (e o troco) exatos da
     seleção que o PSBT usaria, para a tela mostrar a taxa ao lado do valor
     antes de montar qualquer coisa. Valor que não couber fica sem taxa. */
  if (Number.isInteger(amountSats) && amountSats > 0 && changeScript) {
    limits.amount_sats = amountSats;
    try {
      const pick = selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript);
      limits.fee_sats = pick.fee;
      limits.change_sats = pick.change;
      limits.vsize = pick.vsize;
      limits.inputs_used = pick.selected.length;
    } catch (e) {
      limits.fee_sats = null;
      limits.change_sats = null;
      limits.vsize = null;
      limits.inputs_used = null;
    }
  }
  /* Custo de cada nível para o mesmo valor: uma seleção de entradas por
     taxa, na mesma regra do PSBT. Nível em que o valor não cabe fica com
     `fee_sats: null`, e a tela escreve `—`. */
  if (Array.isArray(quoteRates) && quoteRates.length && Number.isInteger(amountSats) &&
    amountSats > 0 && changeScript) {
    limits.quotes = quoteRates.map(rate => {
      try {
        const pick = selectCoins(utxos, amountSats, rate, recipientScript, changeScript);
        return { fee_rate: rate, fee_sats: pick.fee, vsize: pick.vsize };
      } catch (e) {
        return { fee_rate: rate, fee_sats: null, vsize: null };
      }
    });
  }
  return limits;
}

/* Monta o PSBT. `utxos` vem do scanner com a linha de origem já anexada;
   `changeRow` é o próximo endereço livre do ramo de troco; `rawTxFor` devolve
   a transação anterior crua, obrigatória em toda entrada: ela vai como
   `non_witness_utxo` para o assinante conferir o valor. `ownScripts` é o mapa
   de scripts derivados da carteira (`script -> linha`): é o que distingue um
   destino externo de um recebimento para a própria carteira e fornece a
   origem BIP32 quando o destino também é nosso. */
async function preparePsbt({
  account, fingerprint, utxos, address, amountSats, feeRate, changeRow, rawTxFor, ownScripts
}) {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('valor inválido');
  }
  const rateKvb = feeRateKvb(feeRate);
  if (amountSats < DUST_SATS) {
    throw new Error('valor abaixo do pó: o mínimo é ' + DUST_SATS + ' sats');
  }
  let recipientScript;
  try { recipientScript = BTC.scriptFromAddress(address); }
  catch (e) { throw new Error('endereço de destino: ' + e.message); }
  const recipientKey = hex(recipientScript);
  const recipientRow = ownScripts && ownScripts.get ? ownScripts.get(recipientKey) : null;
  const recipientOwn = !!(ownScripts && ownScripts.has(recipientKey));
  const recipientKind = recipientOwn ? 'recebimento' : 'externo';
  if (!changeRow) throw new Error('endereço de troco indisponível');
  const changeScript = BTC.hexToBytes(changeRow.script);
  const fp = accountFingerprint(account, fingerprint);

  const pick = selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript);

  const inputs = [];
  for (const utxo of pick.selected) {
    const origin = utxoInput(utxo, fp);
    if (!rawTxFor) throw new Error('entrada sem acesso à transação anterior (non_witness_utxo)');
    const raw = await rawTxFor(utxo.txid);
    if (!raw) throw new Error('transação anterior da entrada ' + utxo.txid + ' não encontrada');
    origin.rawTx = raw;
    inputs.push(origin);
  }

  const outputs = [{ value: amountSats, script: recipientScript }];
  /* Destino da própria carteira: leva a origem BIP32 na saída, como o troco.
     O assinador reconhece o endereço pela derivação que o PSBT traz, sem
     varrer as contas. A origem é conferida (chave e script) no assinador. */
  if (recipientRow) outputs[0].origin = rowOrigin(recipientRow, fp);
  if (pick.withChange) {
    outputs.push({
      value: pick.change,
      script: changeScript,
      origin: rowOrigin(changeRow, fp)
    });
  }

  const built = BTC.buildPsbt({ inputs, outputs });
  const paths = pick.selected.map(u => u.row.path);
  /* A taxa paga (`fee_sats`) é a da transação montada. `fee_sats_at_rate` é a
     que a tarifa pedida sozinha cobraria nela; a diferença é o valor que
     sobrou e não virou troco — porque o troco ficaria abaixo do pó (546) ou
     porque criar a saída custaria mais do que esse resto — e que a transação
     paga de taxa. Com troco, os dois números são iguais. */
  const feeAtRate = feeSats(rateKvb, pick.vsize);
  const tx = built.tx;
  const locktime = tx.locktime >>> 0;
  const rbf = (tx.version >>> 0) >= 2 && tx.inputs.some(inp => (inp.sequence >>> 0) < 0xfffffffe);
  return {
    psbt: built.base64,
    txid: built.txid,
    vsize: built.vsize,
    locktime,
    rbf,
    fee_sats: pick.fee,
    fee_sats_at_rate: feeAtRate,
    dust_sats: pick.fee - feeAtRate,
    fee_rate: pick.vsize ? pick.fee / pick.vsize : 0,
    fee_rate_requested: feeRate,
    fee_rate_kvb: rateKvb,
    total_in: pick.total,
    total_out: amountSats + (pick.withChange ? pick.change : 0),
    amount_sats: amountSats,
    change: pick.withChange
      ? { address: changeRow.address, value: pick.change, path: changeRow.path }
      : null,
    recipient: { address, value: amountSats, own: recipientKind },
    inputs: pick.selected.map((u, i) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      address: u.row.address, path: paths[i], type: u.row.account_type,
      pending: u.height === 0
    })),
    outputs: [
      { address, value: amountSats, own: recipientKind },
      ...(pick.withChange
        ? [{ address: changeRow.address, value: pick.change, own: 'troco', path: changeRow.path }]
        : [])
    ]
  };
}

/* CPFP: monta a transação filha que gasta uma saída da transação presa e
   devolve o resto para o próximo endereço de troco da carteira. O pai não é
   alterado; a taxa extra sai do valor dessa saída. A função é só a montagem:
   quem escolhe a saída e calcula a taxa do pacote é o chamador (wallet-sync),
   que tem a transação crua e os valores das entradas. */
async function prepareCpfpPsbt({
  account, fingerprint, spend, changeRow, childFee, feeRate, rawTxFor, parent, packageBefore
}) {
  if (!spend || !spend.row) throw new Error('saída do pai indisponível');
  if (!changeRow) throw new Error('endereço de troco indisponível');
  const fee = Number(childFee);
  if (!Number.isSafeInteger(fee) || fee <= 0) throw new Error('taxa do filho inválida');
  const value = Number(spend.value) - fee;
  if (!Number.isSafeInteger(value) || value < DUST_SATS) {
    throw new Error('a saída do pai não cobre a taxa necessária (o retorno ficaria abaixo do pó de ' +
      DUST_SATS + ' sats)');
  }
  const rawTx = rawTxFor ? await rawTxFor(spend.txid) : null;
  if (!rawTx) throw new Error('transação pai não encontrada para o non_witness_utxo');
  const fp = accountFingerprint(account, fingerprint);
  const changeScript = BTC.hexToBytes(changeRow.script);
  const inputs = [{
    txid: spend.txid,
    vout: spend.vout,
    value: spend.value,
    script: BTC.hexToBytes(spend.script),
    kind: spend.row.kind,
    pub: BTC.hexToBytes(spend.row.pub),
    path: spend.row.path,
    fingerprint: fp,
    rawTx
  }];
  const outputs = [{
    value,
    script: changeScript,
    origin: rowOrigin(changeRow, fp)
  }];
  const built = BTC.buildPsbt({ inputs, outputs });
  const tx = built.tx;
  const packageFee = Number(packageBefore.fee_sats) + fee;
  const packageVsize = Number(packageBefore.vsize) + built.vsize;
  const rateKvb = feeRateKvb(feeRate);
  return {
    psbt: built.base64,
    txid: built.txid,
    vsize: built.vsize,
    locktime: tx.locktime >>> 0,
    rbf: (tx.version >>> 0) >= 2 && tx.inputs.some(inp => (inp.sequence >>> 0) < 0xfffffffe),
    fee_sats: fee,
    fee_rate: built.vsize ? fee / built.vsize : 0,
    total_in: Number(spend.value),
    total_out: value,
    parent,
    package: {
      fee_sats: packageFee,
      vsize: packageVsize,
      fee_rate: packageVsize ? packageFee / packageVsize : 0,
      target_fee_sats: feeSats(rateKvb, packageVsize),
      target_fee_rate: Number(feeRate),
      ancestors: Math.max(0, Number(packageBefore.count || 1) - 1)
    },
    input: {
      txid: spend.txid, vout: spend.vout, value: spend.value,
      address: spend.row.address, path: spend.row.path,
      type: spend.row.account_type, kind: spend.row.kind
    },
    output: {
      address: changeRow.address, value, path: changeRow.path, own: 'troco'
    }
  };
}

return {
  DUST_SATS: DUST_SATS, feeRateKvb: feeRateKvb, feeSats: feeSats,
  selectCoins: selectCoins, sendLimits: sendLimits,
  preparePsbt: preparePsbt, prepareCpfpPsbt: prepareCpfpPsbt
};
})(BTC);
var __broadcast = (function (BTC, DUST_SATS, RELAY_MIN_KVB) {
/* Transmissão do PSBT assinado (fecha o ciclo do Monitor BTC).

   O Cofre BTC assina offline e devolve um PSBT v0 com todas
   as entradas finalizadas. Aqui ele é conferido contra a carteira watch-only
   antes de qualquer coisa sair para a rede:

   - toda entrada tem de gastar um script DERIVADO DESTA CARTEIRA (o scanner
     já tem os scripts em `byScript`) — um PSBT de outra carteira não passa;
   - quando a saída está entre os UTXOs conhecidos, o valor declarado no PSBT
     tem de bater com o da carteira (o p2pkh não assina o valor, então essa
     comparação é o que impede um valor inventado de virar taxa falsa na tela);
   - cada entrada tem de estar finalizada, com o scriptSig/witness no formato
     do tipo de script, e a transação final é escrita a partir dos campos
     finais (BIP174);
   - as saídas são classificadas em troco, recebimento e externo, e a taxa é
     a diferença real entre entradas e saídas da transação final.

   O navegador não faz conta nenhuma: a resposta é o resumo que o servidor
   conferiu, mais os avisos. A transmissão em si é
   `blockchain.transaction.broadcast` no Electrum, feito pelo Worker ou pelo
   Durable Object (que reaproveita a conexão e as assinaturas da sessão). */



/* Piso de relay padrão do Bitcoin Core (`-minrelaytxfee`):
   RELAY_MIN_KVB sat/kvB = 0,1 sat/vB desde a v30. */
const RELAY_MIN_RATE = RELAY_MIN_KVB / 1000;

/* Um PSBT de várias entradas fica na casa de dezenas de KB em base64; o teto
   existe para uma colagem gigante não virar trabalho à toa no Worker. */
const MAX_PSBT_TEXT = 400000;

/* Limite de padrão da rede para uma transação (peso 400 000 = 100 000 vB). */
const MAX_TX_VSIZE = 100000;

const KIND_LABEL = { p2pkh: 'pkh', 'p2sh-p2wpkh': 'sh(wpkh)', p2wpkh: 'wpkh', p2tr: 'tr' };

function mapFind(map, type) {
  for (let i = 0; i < map.length; i++) {
    if (map[i].key.length === 1 && map[i].key[0] === type) return map[i];
  }
  return null;
}

function normalizeKind(kind) {
  return kind === 'p2sh' ? 'p2sh-p2wpkh' : kind;
}

/* O formato final depende do tipo de script: p2pkh leva assinatura no
   scriptSig e nenhum witness; p2sh-p2wpkh leva os dois; p2wpkh e p2tr levam
   só o witness. Um witness em entrada não-segwit invalida a transação. */
function checkFinalization(input, map) {
  const fs = mapFind(map, 0x07);
  const fw = mapFind(map, 0x08);
  const scriptSig = fs ? fs.value : new Uint8Array(0);
  const witness = fw ? BTC.readWitness(fw.value) : [];
  const i = input.index;
  if (input.kind === 'p2pkh' && (!scriptSig.length || witness.length)) {
    throw new Error('entrada ' + i + ' p2pkh não está finalizada como esperado');
  }
  if (input.kind === 'p2sh-p2wpkh' && (!scriptSig.length || !witness.length)) {
    throw new Error('entrada ' + i + ' p2sh-p2wpkh não está finalizada como esperado');
  }
  if ((input.kind === 'p2wpkh' || input.kind === 'p2tr') &&
      (scriptSig.length || !witness.length)) {
    throw new Error('entrada ' + i + ' ' + input.kind + ' não está finalizada como esperado');
  }
}

/* Confere um PSBT assinado e devolve o resumo da transação final. Não
   transmite nada: quem chama decide (o Worker e o DO usam o `hex` daqui).
   `byScript` é o Map do scanner (script → linha derivada) e `utxos` a lista
   de saídas não gastas conhecidas na sessão. */
function inspectSignedPsbt({ psbtText, byScript, utxos }) {
  const text = String(psbtText == null ? '' : psbtText).trim();
  if (!text) throw new Error('informe o psbt assinado');
  if (text.length > MAX_PSBT_TEXT) {
    throw new Error('psbt grande demais (' + text.length + ' caracteres; o teto é ' +
      MAX_PSBT_TEXT + ')');
  }
  let bytes, psbt;
  try {
    bytes = BTC.psbtParseInput(text);
    psbt = BTC.parsePsbt(bytes);
  } catch (e) {
    throw new Error('psbt ilegível: ' + (e && e.message ? e.message : e));
  }
  if (!psbt.tx.inputs.length) throw new Error('a transação não tem entradas');
  if (!psbt.tx.outputs.length) throw new Error('a transação não tem saídas');

  const owned = byScript instanceof Map ? byScript : new Map();
  const known = new Map();
  for (const u of utxos || []) known.set(u.txid + ':' + u.vout, u);

  const seen = new Set();
  const inputs = [];
  let totalIn = 0;
  for (let i = 0; i < psbt.tx.inputs.length; i++) {
    const outpoint = psbt.tx.inputs[i].txid + ':' + psbt.tx.inputs[i].vout;
    if (seen.has(outpoint)) throw new Error('a entrada ' + outpoint + ' aparece duas vezes');
    seen.add(outpoint);
    let prev;
    try {
      prev = BTC.prevoutOf(psbt.inputs[i], psbt.tx.inputs[i]);
    } catch (e) {
      throw new Error('entrada ' + i + ': ' + (e && e.message ? e.message : e));
    }
    const script = BTC.bytesToHex(prev.script);
    const row = owned.get(script);
    if (!row) {
      throw new Error('o psbt não pertence a esta carteira');
    }
    const kind = normalizeKind(BTC.scriptKind(prev.script));
    if (kind === 'p2wsh' || kind === 'witness' || kind === 'outro') {
      throw new Error('entrada ' + i + ' tem script não suportado (' + kind + ')');
    }
    const mine = known.get(outpoint);
    if (mine) {
      if (mine.script !== script) {
        throw new Error('entrada ' + i + ': o script do psbt difere do da carteira');
      }
      if (Number(prev.value) !== Number(mine.value)) {
        throw new Error('entrada ' + i + ': o psbt declara ' + Number(prev.value) +
          ' sats, mas a carteira tem ' + Number(mine.value) + ' sats nessa saída');
      }
    }
    totalIn += Number(prev.value);
    inputs.push({
      index: i, outpoint, txid: psbt.tx.inputs[i].txid, vout: psbt.tx.inputs[i].vout,
      value: Number(prev.value), kind,
      label: KIND_LABEL[kind] || kind, script,
      address: row.address, path: row.path, type: row.account_type,
      known: !!mine
    });
  }

  let fin;
  try {
    fin = BTC.psbtFinalTx(psbt);
  } catch (e) {
    /* Arquivo que ainda não passou pelo assinante: nenhuma entrada tem o
       campo final. É o erro mais comum, e o nome do campo BIP174 só
       atrapalha na tela; o restante das recusas mantém o detalhe. */
    let semFinal = 0;
    for (let i = 0; i < psbt.inputs.length; i++) {
      if (!mapFind(psbt.inputs[i], 0x07) && !mapFind(psbt.inputs[i], 0x08)) semFinal++;
    }
    if (psbt.inputs.length && semFinal === psbt.inputs.length) throw new Error('o psbt não está assinado');
    throw new Error('entrada não finalizada: ' + (e && e.message ? e.message : e));
  }
  if (fin.vsize > MAX_TX_VSIZE) {
    throw new Error('transação com ' + fin.vsize + ' vB; acima de ' + MAX_TX_VSIZE +
      ' vB a rede recusa');
  }
  inputs.forEach(inp => checkFinalization(inp, psbt.inputs[inp.index]));

  let totalOut = 0;
  const outputs = fin.tx.outputs.map((out, index) => {
    const value = Number(out.value);
    if (!Number.isSafeInteger(value)) throw new Error('saída ' + index + ' com valor inválido');
    totalOut += value;
    const script = BTC.bytesToHex(out.script);
    const row = owned.get(script);
    return {
      index, value, script,
      address: BTC.addressFromScript(out.script),
      own: row ? (row.chain === 1 ? 'troco' : 'recebimento') : 'externo',
      path: row ? row.path : '',
      type: row ? row.account_type : ''
    };
  });
  if (totalOut > totalIn) throw new Error('as saídas somam mais que as entradas');

  const fee = totalIn - totalOut;
  const feeRate = fin.vsize > 0 ? fee / fin.vsize : 0;
  const locktime = fin.tx.locktime >>> 0;
  const rbf = (fin.tx.version >>> 0) >= 2 && fin.tx.inputs.some(inp => (inp.sequence >>> 0) < 0xfffffffe);
  const warnings = [];
  if (!fee) warnings.push('taxa zero: a rede pode recusar a transação');
  if (fee > 0 && feeRate < RELAY_MIN_RATE) {
    warnings.push('taxa de ' + feeRate.toFixed(2) +
      ' sat/vB, abaixo do piso de relay padrão (0,1 sat/vB): a transação pode ser recusada');
  }
  if (feeRate > 500) {
    warnings.push('taxa de ' + Math.round(feeRate) + ' sat/vB, acima de 500: confira o valor');
  }
  outputs.forEach(out => {
    if (out.value > 0 && out.value < DUST_SATS) {
      warnings.push('a saída ' + out.index + ' (' + out.address + ') está abaixo do pó de ' +
        DUST_SATS + ' sats e pode ser recusada');
    }
  });
  const externos = outputs.filter(out => out.own === 'externo');
  if (externos.length > 1) {
    warnings.push(externos.length + ' saídas pagam endereços externos: confira a lista');
  }
  inputs.forEach(inp => {
    if (!inp.known) {
      warnings.push('a entrada ' + inp.outpoint +
        ' não está entre as saídas não gastas que esta sessão conhece');
    }
  });

  return {
    hex: fin.hex,
    txid: fin.txid,
    vsize: fin.vsize,
    locktime,
    rbf,
    fee_sats: fee,
    fee_rate: feeRate,
    total_in: totalIn,
    total_out: totalOut,
    psbt_bytes: bytes.length,
    inputs, outputs, warnings
  };
}

/* Só a conferência (a tela mostra o resumo e espera o clique em transmitir).
   O `hex` fica no servidor: o navegador não precisa dele. */
function previewSignedPsbt({ scanner, psbtText }) {
  const inspected = inspectSignedPsbt({
    psbtText,
    byScript: scanner && scanner.byScript,
    utxos: scanner && scanner.utxos
  });
  const out = Object.assign({}, inspected, { preview: true });
  delete out.hex;
  return out;
}

/* Confere e transmite. O resumo devolvido é o que a tela mostra; o `hex` não
   sai daqui (o navegador não precisa dele e ele não é prova de nada). */
async function broadcastSignedPsbt({ client, scanner, psbtText }) {
  const inspected = inspectSignedPsbt({
    psbtText,
    byScript: scanner && scanner.byScript,
    utxos: scanner && scanner.utxos
  });
  let serverTxid = '';
  try {
    const result = await client.request('blockchain.transaction.broadcast', [inspected.hex]);
    if (typeof result === 'string') serverTxid = result.trim().toLowerCase();
  } catch (e) {
    throw new Error('o servidor recusou a transação: ' + (e && e.message ? e.message : e));
  }
  const warnings = inspected.warnings.slice();
  if (serverTxid && serverTxid !== inspected.txid) {
    warnings.push('o servidor devolveu txid diferente do calculado (' + serverTxid + ')');
  }
  const out = Object.assign({}, inspected, {
    broadcast: true,
    server_txid: serverTxid,
    warnings
  });
  delete out.hex;
  return out;
}

return {
  inspectSignedPsbt: inspectSignedPsbt, previewSignedPsbt: previewSignedPsbt,
  broadcastSignedPsbt: broadcastSignedPsbt
};
})(BTC, __psbt.DUST_SATS, __electrum.RELAY_MIN_KVB);
var __wallet = (function (BTC, chainNode, deriveChild, TYPE_INFO,
  historiesMany, transactionsMany, totalsForScripts, utxosForScripts,
  preparePsbt, sendLimits, prepareCpfpPsbt, feeRateKvb, feeSats, DUST_SATS) {
/* Varredura e estado de uma carteira — usado pelo Worker (consulta avulsa)
   e pelo Durable Object (tempo real com assinaturas). No modo watch, o
   conjunto de endereços vem pronto do navegador; no modo legado, ainda
   aceita xpub para os testes/compatibilidade.

   Fonte única: servidor Electrum, por scripthash, como Electrum e Sparrow:
   get_history + get_mempool + transaction.get (crua), parse local, conta de
   UTXO. Endereços e transações vivem só na memória desta varredura: nada é
   gravado, nem em D1 nem no Durable Object. Ao fechar a tela, tudo se perde
   e a próxima abertura refaz a varredura do zero. */





const DEFAULT_GAP = 50;
const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];

/* A varredura não tem teto de endereços: o fim de cada ramo é a margem de
   `gap` endereços vazios. O lote limita só quanto trabalho uma requisição
   faz por vez, para a tela mostrar progresso e continuar depois. */
const SCAN_BATCH = 200;
const HIST_CONCURRENCY = 100;
const TX_CONCURRENCY = 20;

function now() { return new Date().toISOString(); }
function hex(bytes) { return BTC.bytesToHex(bytes); }

function rowKey(type, chain) { return type + ':' + chain; }

/* Altura da atividade mais recente de uma linha: o maior bloco em que o
   endereço aparece. O mempool (altura 0) é atividade pendente e vale como a
   mais recente de todas, à frente de qualquer bloco confirmado. */
function activityOf(row) {
  let height = 0;
  let pending = 0;
  for (const h of row.heights.values()) {
    if (h > 0) {
      if (h > height) height = h;
    } else {
      pending = 1;
    }
  }
  return { height, pending };
}

/* ---------- scanner ---------- */

class WalletScanner {
  constructor({ env, xpub, account, client, gap, watch, walletId, fingerprint, versionType }) {
    this.env = env;
    this.xpub = xpub;
    this.account = account;
    this.client = client;
    this.gap = Math.max(1, Number(gap) || DEFAULT_GAP);
    /* Modo watch: o cliente já derivou os endereços; o servidor nunca vê a
       xpub. `watch` é a lista normalizada por watch-set.js. */
    this.watchMode = watch != null;
    this.initialWatch = watch || null;
    this.walletId = walletId || null;
    this.fingerprint = fingerprint || null;
    this.versionType = versionType || null;
    this.pendingRows = [];
    this.rows = new Map();
    this.txCache = new Map();   // txid -> hex cru, só nesta sessão
    this.infoCache = new Map(); // txid -> resumo da transação, invalidado por aviso
    this.chainNodes = new Map();
    this.byScript = new Map();
    this.bySh = new Map();
    this.shCache = new Map();
  }

  async init() {
    for (const type of TYPES) for (const chain of [0, 1]) {
      if (!this.rows.has(rowKey(type, chain))) this.rows.set(rowKey(type, chain), new Map());
    }
    if (this.watchMode) {
      this.addWatchRows(this.initialWatch || [], true);
      this.initialWatch = null;
      return this;
    }
    this.fingerprint = this.account
      ? BTC.bytesToHex(BTC.hash160(this.account.pub)).slice(0, 8)
      : null;
    this.reindex();
    return this;
  }

  /* Converte uma linha já derivada pelo cliente para a linha interna do
     scanner, sem chamar CKDpub. `replace` reinicia o conjunto (primeira
     consulta ou troca de carteira); sem ele, só a cauda nova entra. */
  addWatchRows(rows, replace) {
    if (!this.watchMode) throw new Error('scanner não está em modo watch');
    if (replace) {
      this.rows = new Map();
      for (const type of TYPES) for (const chain of [0, 1]) {
        this.rows.set(rowKey(type, chain), new Map());
      }
      this.pendingRows = [];
      this.infoCache.clear();
    }
    for (const r of rows || []) {
      const key = rowKey(r.account_type, r.chain);
      let branch = this.rows.get(key);
      if (!branch) { branch = new Map(); this.rows.set(key, branch); }
      if (branch.has(r.idx)) continue;
      const row = {
        account_type: r.account_type, chain: r.chain, idx: r.idx,
        address: r.address, path: r.path, script: r.script, pub: r.pub,
        kind: r.kind,
        used: 0, balance: 0, received: 0, spent: 0, tx_count: 0,
        confirmed: 0, pendingIn: 0, pendingOut: 0, thirdIn: 0,
        heights: new Map(), txids: [], stale: false
      };
      branch.set(r.idx, row);
      this.pendingRows.push(row);
    }
    this.reindex();
    return this;
  }

  /* Estado da margem por ramo: o cliente usa `next`/`need` para derivar a
     próxima cauda. A regra continua sendo 50 endereços vazios depois do
     último usado. */
  watchStatus() {
    const branches = {};
    let complete = true;
    for (const type of TYPES) {
      for (const chain of [0, 1]) {
        const rows = this.rows.get(rowKey(type, chain)) || new Map();
        const { lastUsed, maxIdx } = this.lastUsedOf(rows);
        const target = lastUsed + this.gap;
        const need = Math.max(0, target - maxIdx);
        if (need > 0) complete = false;
        branches[rowKey(type, chain)] = {
          last_used: lastUsed,
          max_idx: maxIdx,
          next: maxIdx + 1,
          need
        };
      }
    }
    return { gap: this.gap, complete, branches };
  }

  reindex() {
    this.byScript = new Map();
    this.bySh = new Map();
    for (const rows of this.rows.values()) {
      for (const r of rows.values()) {
        if (!r.script) continue;
        this.byScript.set(r.script, r);
        this.bySh.set(this.sh(r.script), r);
      }
    }
  }

  sh(script) {
    let sh = this.shCache.get(script);
    if (!sh) {
      sh = shOf(script);
      this.shCache.set(script, sh);
    }
    return sh;
  }

  /* Scripthashes que precisam ser observados: os usados (para detectar
     gastos) e a cauda de gap de cada ramo (para detectar novos
     recebimentos). Endereços vazios fora da cauda não são assinados. */
  scriptsForWatch() {
    const out = [];
    for (const rows of this.rows.values()) {
      const { lastUsed, maxIdx } = this.lastUsedOf(rows);
      for (const r of rows.values()) {
        if (r.used || (r.idx > lastUsed && r.idx <= maxIdx)) out.push(this.sh(r.script));
      }
    }
    return out;
  }

  async chainNodeFor(chain) {
    if (!this.chainNodes.has(chain)) this.chainNodes.set(chain, await chainNode(this.account, chain));
    return this.chainNodes.get(chain);
  }

  async makeRow(type, chain, idx) {
    const cn = await this.chainNodeFor(chain);
    const a = await deriveChild(type, cn, chain, idx);
    return {
      account_type: type, chain, idx, address: a.address, path: a.path,
      script: BTC.bytesToHex(a.script), pub: BTC.bytesToHex(a.pub),
      kind: (TYPE_INFO[type] || {}).kind || 'p2wpkh',
      used: 0, balance: 0, received: 0, spent: 0, tx_count: 0,
      confirmed: 0, pendingIn: 0, pendingOut: 0, thirdIn: 0,
      heights: new Map(), txids: [], stale: false
    };
  }

  async queryRows(rows) {
    if (!rows.length) return;
    const hist = await historiesMany(this.client, rows.map(r => BTC.hexToBytes(r.script)),
      { concurrency: HIST_CONCURRENCY });
    rows.forEach((r, i) => {
      const h = hist[i];
      r.heights = h.heights;
      r.txids = h.txids;
      r.tx_count = h.txCount;
      r.used = h.txCount > 0 ? 1 : 0;
    });
  }

  lastUsedOf(rows) {
    let lastUsed = -1;
    let maxIdx = -1;
    for (const r of rows.values()) {
      if (r.idx > maxIdx) maxIdx = r.idx;
      if (r.used && r.idx > lastUsed) lastUsed = r.idx;
    }
    return { lastUsed, maxIdx };
  }

  /* Conta de UTXO a partir das transações cruas (cache em memória). */
  async recompute() {
    const heights = new Map();
    const scripts = new Set();
    for (const r of this.byScript.values()) {
      if (!r.txids.length) continue;
      scripts.add(r.script);
      for (const [txid, h] of r.heights) if (!heights.has(txid)) heights.set(txid, h);
    }

    let totals = new Map();
    const errors = new Map();
    let entries = [];
    if (heights.size) {
      const cached = new Map();
      for (const txid of heights.keys()) {
        const raw = this.txCache.get(txid);
        if (raw) cached.set(txid, raw);
      }
      const missing = [...heights.keys()].filter(t => !cached.has(t));
      const fetched = missing.length
        ? await transactionsMany(this.client, missing, { concurrency: TX_CONCURRENCY })
        : { raw: new Map(), errors: new Map() };
      for (const [txid, raw] of fetched.raw) this.txCache.set(txid, raw);
      for (const [txid, msg] of fetched.errors) errors.set(txid, msg);
      /* transação nova muda o índice de saídas e a conta das vizinhas:
         zera o resumo em cache para o payload recalcular tudo uma vez */
      if (fetched.raw.size) this.infoCache.clear();

      for (const [txid, raw] of [...cached, ...fetched.raw]) {
        try {
          const tx = BTC.readTx(BTC.hexToBytes(raw));
          entries.push({
            txid, height: heights.get(txid) || 0, outputs: tx.outputs, inputs: tx.inputs,
            vsize: BTC.vsizeOf(tx)
          });
        } catch (e) {
          errors.set(txid, 'transação ilegível');
        }
      }
      /* confirmação de uma transação já conhecida muda a altura (e o
         pendente) sem baixar nada novo: o resumo em cache tem de cair */
      for (const tx of entries) {
        const info = this.infoCache.get(tx.txid);
        if (info && Number(info.height) !== (Number(tx.height) || 0)) this.infoCache.delete(tx.txid);
      }
      totals = totalsForScripts(entries, scripts);
    }
    /* UTXOs = saídas nossas que nenhuma transação conhecida gastou. Só são
       usados para montar PSBT; se faltou transação, prepare() recusa. */
    this.utxos = utxosForScripts(entries, scripts);
    /* Índices em memória para o extrato por transação e para o CPFP. O mapa
       de saídas cobre TODAS as saídas conhecidas (inclusive as externas),
       porque o valor de uma entrada nossa vem da transação anterior. */
    this.entries = entries;
    this.entryByTxid = new Map(entries.map(tx => [tx.txid, tx]));
    this.outpointIndex = new Map();
    for (const tx of entries) {
      for (let vout = 0; vout < tx.outputs.length; vout++) {
        const out = tx.outputs[vout];
        this.outpointIndex.set(tx.txid + ':' + vout, {
          txid: tx.txid, vout, value: Number(out.value) || 0,
          script: hex(out.script), height: tx.height || 0
        });
      }
    }
    this.utxoByKey = new Map(this.utxos.map(u => [u.txid + ':' + u.vout, u]));

    /* Disponível = saída confirmada não gasta + troco de transação nossa
       ainda pendente. O troco é uma saída da mesma transação do envio e some
       do saldo até confirmar, então ele entra aqui: pode ser gasto antes
       (gasto encadeado). Pagamento de terceiro no mempool (height 0, own
       false) não entra: fica como pendente de entrada e só conta depois da
       confirmação. É a mesma base que o envio usa. */
    const availableByScript = new Map();
    const thirdInByScript = new Map();
    for (const u of this.utxos) {
      if (u.height > 0 || u.own) {
        availableByScript.set(u.script, (availableByScript.get(u.script) || 0) + u.value);
      } else {
        thirdInByScript.set(u.script, (thirdInByScript.get(u.script) || 0) + u.value);
      }
    }

    for (const r of this.byScript.values()) {
      if (r.txids.some(t => errors.has(t))) {
        // sem a transação não fecha a conta: mantém o último valor calculado
        r.stale = true;
        r.used = r.txids.length ? 1 : 0;
        r.tx_count = r.txids.length;
        continue;
      }
      const t = totals.get(r.script);
      /* `received` e `spent` são o confirmado; `balance` é o disponível
         (confirmado não gasto + troco nosso ainda pendente). O mempool fica
         em pendingIn/pendingOut (brutos, para a tela do extrato) e
         thirdIn (entrada de terceiro que ainda não conta). */
      r.received = t ? t.receivedConfirmed : 0;
      r.spent = t ? t.spentConfirmed : 0;
      r.balance = availableByScript.get(r.script) || 0;
      r.tx_count = t ? t.txCount : 0;
      r.confirmed = t ? t.confirmed : 0;
      r.pendingIn = t ? t.unconfirmedIn : 0;
      r.pendingOut = t ? t.unconfirmedOut : 0;
      r.thirdIn = thirdInByScript.get(r.script) || 0;
      r.used = r.tx_count ? 1 : 0;
      r.stale = false;
    }

    if (errors.size) this.errors = errors;
    else this.errors = null;
    return totals;
  }

  /* Resumo de uma transação para o extrato por txid. `own_inputs` e
     `own_outputs` guardam a linha derivada (com pub/chave) só para o CPFP;
     `publicTransaction` remove o que não precisa ir ao navegador. O
     resultado fica em `infoCache` (por txid) até um aviso do Electrum tocar
     um scripthash dessa transação: sem isso, cada payload refazia
     `addressFromScript` para todas as saídas de todas as transações. */
  infoOf(entry) {
    let info = this.infoCache.get(entry.txid);
    if (!info) {
      info = this.transactionInfo(entry);
      this.infoCache.set(entry.txid, info);
    }
    return info;
  }

  transactionInfo(entry) {
    const addressOf = script => {
      try { return BTC.addressFromScript(script) || ''; } catch (e) { return ''; }
    };
    const ownInputs = [];
    let allPrevKnown = true;
    for (const input of entry.inputs) {
      const prev = this.outpointIndex.get(input.txid + ':' + input.vout);
      if (!prev) { allPrevKnown = false; continue; }
      const row = this.byScript.get(prev.script);
      if (row) ownInputs.push({
        txid: input.txid, vout: input.vout, value: prev.value,
        script: prev.script, row
      });
    }
    const outputs = entry.outputs.map((out, vout) => {
      const script = hex(out.script);
      const row = this.byScript.get(script);
      const key = entry.txid + ':' + vout;
      const value = Number(out.value) || 0;
      return {
        txid: entry.txid, vout, value, script, row,
        address: row ? row.address : addressOf(out.script),
        own: !!row,
        spendable: this.utxoByKey.has(key)
      };
    });
    const ownOutputs = outputs.filter(o => o.own);
    const externalOutputs = outputs.filter(o => !o.own);
    const allInputsOwn = allPrevKnown && ownInputs.length === entry.inputs.length;
    const totalIn = allInputsOwn
      ? ownInputs.reduce((sum, i) => sum + i.value, 0)
      : null;
    const totalOut = outputs.reduce((sum, o) => sum + o.value, 0);
    const fee = totalIn == null ? null : totalIn - totalOut;
    const received = ownOutputs.reduce((sum, o) => sum + o.value, 0);
    const sent = externalOutputs.reduce((sum, o) => sum + o.value, 0);
    const direction = ownInputs.length
      ? (externalOutputs.length ? 'out' : 'self')
      : 'in';

    const addresses = [];
    const seen = new Set();
    const addAddress = (row, role) => {
      if (!row || seen.has(row.address)) return;
      seen.add(row.address);
      addresses.push({
        address: row.address, role, chain: row.chain, idx: row.idx,
        account_type: row.account_type, path: row.path
      });
    };
    ownInputs.forEach(i => addAddress(i.row, 'entrada'));
    ownOutputs.forEach(o => addAddress(o.row, o.row.chain === 1 ? 'troco' : 'recebimento'));

    const candidates = ownOutputs
      .filter(o => o.spendable && o.value >= DUST_SATS)
      .sort((a, b) => b.value - a.value);
    const cpfpOutput = candidates[0] || null;

    return {
      txid: entry.txid,
      height: Number(entry.height) || 0,
      pending: !entry.height,
      vsize: Number(entry.vsize) || 0,
      direction,
      received_sats: received,
      sent_sats: sent,
      fee_sats: fee,
      total_in_sats: totalIn,
      total_out_sats: totalOut,
      input_count: entry.inputs.length,
      output_count: entry.outputs.length,
      addresses,
      own_inputs: ownInputs,
      own_outputs: ownOutputs,
      all_inputs_own: allInputsOwn,
      cpfp: {
        eligible: !entry.height && ownInputs.length > 0 && allInputsOwn &&
          fee != null && fee >= 0 && !!cpfpOutput,
        output: cpfpOutput ? {
          txid: cpfpOutput.txid, vout: cpfpOutput.vout,
          outpoint: cpfpOutput.txid + ':' + cpfpOutput.vout,
          value: cpfpOutput.value, address: cpfpOutput.address,
          path: cpfpOutput.row.path, chain: cpfpOutput.row.chain,
          idx: cpfpOutput.row.idx
        } : null
      }
    };
  }

  /* O que vai no payload: sem as linhas derivadas nem os Map internos. */
  publicTransaction(t) {
    return {
      txid: t.txid,
      height: t.height,
      pending: t.pending,
      vsize: t.vsize,
      direction: t.direction,
      received_sats: t.received_sats,
      sent_sats: t.sent_sats,
      fee_sats: t.fee_sats,
      total_in_sats: t.total_in_sats,
      total_out_sats: t.total_out_sats,
      input_count: t.input_count,
      output_count: t.output_count,
      addresses: t.addresses,
      cpfp: t.cpfp
    };
  }

  /* Soma taxa e vsize do pai e de todos os ancestrais ainda no mempool. Se
     algum deles não for inteiramente desta carteira, a taxa não pode ser
     conferida e o CPFP é recusado (não há como garantir o pacote). */
  cpfpPackage(entry) {
    const seen = new Set();
    const queue = [entry];
    let fee = 0;
    let vsize = 0;
    let count = 0;
    while (queue.length) {
      const tx = queue.pop();
      if (seen.has(tx.txid)) continue;
      seen.add(tx.txid);
      const info = this.infoOf(tx);
      if (!info.all_inputs_own || info.fee_sats == null || info.fee_sats < 0) {
        return { fee_sats: null, vsize: null, count: null };
      }
      fee += info.fee_sats;
      vsize += Number(tx.vsize) || 0;
      count++;
      for (const input of tx.inputs) {
        const prev = this.entryByTxid.get(input.txid);
        if (prev && !prev.height) queue.push(prev);
      }
    }
    return { fee_sats: fee, vsize, count };
  }

  /* CPFP: monta o PSBT da filha que gasta a maior saída própria ainda não
     gasta do pai e devolve o resto para o próximo endereço de troco. A taxa
     do filho é a diferença entre a taxa-alvo do pacote e o que o pai (e os
     ancestrais pendentes) já paga. */
  async prepareCpfp({ txid, feeRate }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const entry = this.entryByTxid && this.entryByTxid.get(String(txid || '').toLowerCase());
    if (!entry) throw new Error('transação não encontrada nesta carteira');
    if (entry.height > 0) throw new Error('a transação já foi confirmada; CPFP só vale para pendente');
    const info = this.infoOf(entry);
    if (!info.own_inputs.length) throw new Error('a transação não é um envio desta carteira');
    if (!info.all_inputs_own) throw new Error('nem todas as entradas da transação são desta carteira; não é possível assinar a filha');
    if (info.fee_sats == null || info.fee_sats < 0) throw new Error('taxa da transação pai indisponível');
    const spend = info.own_outputs
      .filter(o => o.spendable && o.value >= DUST_SATS)
      .sort((a, b) => b.value - a.value)[0];
    if (!spend) throw new Error('não há saída própria ainda não gasta para acelerar');
    const pkg = this.cpfpPackage(entry);
    if (pkg.fee_sats == null || !(pkg.vsize > 0)) {
      throw new Error('há ancestral pendente com taxa que não é desta carteira; não é possível calcular o pacote com segurança');
    }
    const rateKvb = feeRateKvb(feeRate);
    const changeRow = this.nextChangeRow(this.chooseType());
    if (!changeRow) throw new Error('endereço de troco indisponível');
    const childVsize = BTC.estimateVsize([spend.row.kind], [BTC.hexToBytes(changeRow.script)]);
    const targetFee = feeSats(rateKvb, pkg.vsize + childVsize);
    const childFee = targetFee - pkg.fee_sats;
    if (!(childFee > 0)) {
      throw new Error('a transação já paga a taxa alvo; não há o que acelerar');
    }
    const rawTxFor = async id => {
      const cached = this.txCache.get(id);
      if (cached) return BTC.hexToBytes(cached);
      const got = await transactionsMany(this.client, [id], { concurrency: 1 });
      const raw = got.raw.get(id);
      if (raw) this.txCache.set(id, raw);
      return raw ? BTC.hexToBytes(raw) : null;
    };
    const parent = {
      txid: entry.txid,
      vsize: Number(entry.vsize) || 0,
      fee_sats: info.fee_sats,
      fee_rate: entry.vsize ? info.fee_sats / entry.vsize : 0
    };
    return await prepareCpfpPsbt({
      fingerprint: this.fingerprint, spend, changeRow, childFee, feeRate, rawTxFor,
      parent, packageBefore: pkg
    });
  }

  /* Caminha a varredura em um lote de no máximo SCAN_BATCH endereços novos.
     Não existe teto de carteira: cada ramo só termina quando já tem `gap`
     endereços seguidos sem uso. `requery` reconsulta o que já existe (o
     primeiro passo de uma sessão nova). */
  async scanStep(requery) {
    if (this.watchMode) {
      const fresh = this.pendingRows;
      this.pendingRows = [];
      if (requery) await this.queryRows([...this.byScript.values()]);
      else await this.queryRows(fresh);
      if (fresh.length) this.infoCache.clear();
      return { added: fresh, more: false };
    }
    if (requery) await this.queryRows([...this.byScript.values()]);
    const added = [];
    let budget = SCAN_BATCH;
    let extended = true;
    while (budget > 0 && extended) {
      extended = false;
      for (const type of TYPES) {
        for (const chain of [0, 1]) {
          if (budget <= 0) break;
          const rows = this.rows.get(rowKey(type, chain));
          const { lastUsed, maxIdx } = this.lastUsedOf(rows);
          if (maxIdx - lastUsed >= this.gap) continue;
          const from = maxIdx + 1;
          const target = lastUsed + this.gap;
          const to = Math.min(target, from + budget - 1);
          if (from > to) continue;
          const fresh = [];
          for (let i = from; i <= to; i++) {
            const row = await this.makeRow(type, chain, i);
            rows.set(i, row);
            this.byScript.set(row.script, row);
            this.bySh.set(this.sh(row.script), row);
            fresh.push(row);
          }
          budget -= fresh.length;
          await this.queryRows(fresh);
          /* endereço novo pode tornar interna uma saída antes externa */
          if (fresh.length) this.infoCache.clear();
          added.push(...fresh);
          extended = true;
        }
      }
    }
    return { added, more: this.scanPending() };
  }

  /* Ainda falta derivar/consultar algum endereço para fechar a margem? */
  scanPending() {
    if (this.watchMode) return !this.watchStatus().complete;
    for (const type of TYPES) {
      for (const chain of [0, 1]) {
        const rows = this.rows.get(rowKey(type, chain));
        const { lastUsed, maxIdx } = this.lastUsedOf(rows);
        if (maxIdx - lastUsed < this.gap) return true;
      }
    }
    return false;
  }

  progress() {
    let used = 0;
    for (const r of this.byScript.values()) if (r.used) used++;
    return { scanned: this.byScript.size, used, gap: this.gap };
  }

  /* Modo watch: consulta só a cauda pendente e recalcula. Não deriva nada;
     a próxima cauda vem do cliente depois que `watchStatus` aponta o que
     falta. */
  async watchSync() {
    const fresh = this.pendingRows;
    this.pendingRows = [];
    if (fresh.length) await this.queryRows(fresh);
    await this.recompute();
    return this.payload();
  }

  async fullSync() {
    if (this.watchMode) return await this.watchSync();
    let requery = true;
    let step;
    do { step = await this.scanStep(requery); requery = false; } while (step.more);
    await this.recompute();
    return this.payload();
  }

  /* Atualização incremental: só os scripthashes avisados pelo servidor. */
  async refreshServices(scriptsHash) {
    const rows = [];
    for (const sh of scriptsHash) {
      const r = this.bySh.get(sh);
      if (r) rows.push(r);
    }
    if (!rows.length) return { payload: await this.payload(), added: [] };
    /* aviso novo pode mudar o resumo dessas transações */
    for (const r of rows) for (const id of r.txids) this.infoCache.delete(id);
    await this.queryRows(rows);
    for (const r of rows) for (const id of r.txids) this.infoCache.delete(id);
    let step = await this.scanStep(false);
    const added = [...step.added];
    while (step.more) {
      step = await this.scanStep(false);
      added.push(...step.added);
    }
    await this.recompute();
    return { payload: await this.payload(), added };
  }

  branch(type, chain) {
    const rows = this.rows.get(rowKey(type, chain));
    const { lastUsed } = this.lastUsedOf(rows);
    const next = lastUsed + 1;
    const row = rows.get(next);
    return { chain, next, lastUsed, address: row ? row.address : null, path: row ? row.path : null };
  }

  /* Próxima linha do ramo de troco (já derivada pela varredura): é o
     endereço que recebe o troco do PSBT. */
  nextChangeRow(type) {
    const rows = this.rows.get(rowKey(type, 1));
    if (!rows) return null;
    const { lastUsed } = this.lastUsedOf(rows);
    return rows.get(lastUsed + 1) || null;
  }

  /* Monta o PSBT de envio com os UTXOs desta sessão. A transação não é
     assinada nem enviada; o resultado é o arquivo para o Cofre BTC. */
  prepareUtxos() {
    return this.utxos
      .map(u => ({ ...u, row: this.byScript.get(u.script) }))
      .filter(u => u.row);
  }

  /* Maior valor que a carteira consegue enviar para este destino e taxa.
     Com `amountSats`, devolve também a taxa (e o troco) daquele valor; com
     `quoteRates`, o custo de cada nível para esse mesmo valor. */
  limits({ address, feeRate, amountSats, quoteRates }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const changeRow = this.nextChangeRow(this.chooseType());
    return sendLimits({
      utxos: this.prepareUtxos(),
      address,
      feeRate,
      amountSats,
      quoteRates,
      changeScript: changeRow ? BTC.hexToBytes(changeRow.script) : null
    });
  }

  async prepare({ address, amountSats, feeRate }) {
    if (this.errors && this.errors.size) {
      throw new Error('histórico incompleto (faltou transação do servidor); atualize a carteira e tente de novo');
    }
    if (!this.utxos) throw new Error('carteira ainda não sincronizada');
    const type = this.chooseType();
    const changeRow = this.nextChangeRow(type);
    const utxos = this.prepareUtxos();
    const rawTxFor = async txid => {
      const cached = this.txCache.get(txid);
      if (cached) return BTC.hexToBytes(cached);
      const got = await transactionsMany(this.client, [txid], { concurrency: 1 });
      const raw = got.raw.get(txid);
      if (raw) this.txCache.set(txid, raw);
      return raw ? BTC.hexToBytes(raw) : null;
    };
    return await preparePsbt({
      fingerprint: this.fingerprint, utxos, address, amountSats, feeRate, changeRow, rawTxFor,
      ownScripts: this.byScript
    });
  }

  typeUsed(type) {
    for (const r of this.byScript.values()) if (r.used && r.account_type === type) return true;
    return false;
  }

  chooseType() {
    const hint = this.watchMode ? this.versionType : this.account.versionType;
    if (hint === 'bip84' || hint === 'bip49') return hint;
    for (const type of ['bip44', 'bip86', 'bip84', 'bip49']) if (this.typeUsed(type)) return type;
    return 'bip86';
  }

  /* Transações cruas conhecidas nesta sessão: é o que o navegador precisa
     para conferir UTXOs, montar o PSBT e carregar o non_witness_utxo. */
  rawTransactions() {
    const out = {};
    for (const [txid, raw] of this.txCache) out[txid] = raw;
    return out;
  }

  async payload() {
    const type = this.chooseType();
    const usedRows = [...this.byScript.values()].filter(r => r.used);
    const totalOf = t => usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.balance, 0);

    /* Um item por tipo de conta, na ordem de TYPES (do BIP mais alto para o
       mais baixo: a tecnologia mais recente primeiro), cada um com o saldo
       disponível do tipo e o próximo endereço livre do ramo de recebimento.
       O tipo detectado vem marcado, sem mudar de posição. A tela exibe os
       quatro no bloco receber; o saldo total é a soma das linhas. */
    const types = TYPES.map(t => {
      const br = this.branch(t, 0);
      const ch = this.branch(t, 1);
      return {
        type: t,
        label: (TYPE_INFO[t] || { label: t }).label,
        address: br.address,
        path: br.path,
        change_address: ch.address,
        change_path: ch.path,
        balance: totalOf(t),
        tx_count: usedRows.filter(r => r.account_type === t).reduce((s, r) => s + r.tx_count, 0),
        detected: t === type
      };
    });

    const detected = totalOf(type);
    const extraTotal = types.reduce((s, t) => t.type === type ? s : s + t.balance, 0);
    const availableTotal = detected + extraTotal;
    /* O que a linha "pendente" da carteira mostra é só o que ainda não está
       no disponível: entrada de terceiro que não conta (pending_in) e o que
       já saiu de fato numa transação pendente, isto é, a diferença para o
       saldo confirmado descontado o troco que volta (pending_out). O troco
       pendente já está em `total`, então não aparece como entrada. */
    const confirmedTotal = usedRows.reduce((s, r) => s + r.confirmed, 0);
    const thirdIn = usedRows.reduce((s, r) => s + r.thirdIn, 0);
    const netOut = Math.max(0, confirmedTotal - availableTotal);

    /* Extrato na ordem do uso mais recente: a altura do bloco é a data que a
       varredura já tem, sem pedir cabeçalho ao servidor, e o mempool vem
       antes de tudo. O índice (maior primeiro) desempata o mesmo bloco e,
       por último, o tipo, para a ordem não mudar entre consultas iguais. */
    const addresses = usedRows
      .map(r => ({ r, act: activityOf(r) }))
      .sort((a, b) =>
        (b.act.pending - a.act.pending) ||
        (b.act.height - a.act.height) ||
        (b.r.idx - a.r.idx) ||
        a.r.account_type.localeCompare(b.r.account_type) ||
        (a.r.chain - b.r.chain)
      )
      .map(({ r, act }) => ({
        account_type: r.account_type,
        chain: r.chain,
        idx: r.idx,
        address: r.address,
        used: r.used,
        balance: r.balance,
        received: r.received,
        spent: r.spent,
        tx_count: r.tx_count,
        last_height: act.height,
        pending: act.pending === 1,
        pending_in: r.pendingIn,
        pending_out: r.pendingOut
      }));

    /* Extrato agrupado por txid: uma linha por transação, do mempool para o
       bloco mais recente. A ordem é estável (txid desempata) para a lista não
       dançar entre duas consultas iguais. */
    const transactions = (this.entries || [])
      .map(e => this.publicTransaction(this.infoOf(e)))
      .sort((a, b) =>
        (Number(b.pending) - Number(a.pending)) ||
        (b.height - a.height) ||
        (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0)
      );

    const warnings = [];
    if (this.errors) {
      warnings.push('Transações não obtidas do servidor: ' + [...this.errors.keys()].join(', ') +
        '. Os endereços afetados mantêm o último valor calculado nesta sessão.');
    }
    const stale = [...this.byScript.values()].filter(r => r.stale).length;
    if (stale) warnings.push(stale + ' endereço(s) com valor antigo por falta de transação.');
    const out = {
      detected_type: type,
      balance: {
        detected,
        total: availableTotal,
        pending_in: thirdIn,
        pending_out: netOut
      },
      types,
      addresses,
      transactions,
      warnings,
      updated_at: now()
    };
    if (this.watchMode) out.watch_status = this.watchStatus();
    return out;
  }
}

function shOf(script) {
  const bytes = BTC.hexToBytes(script);
  const h = BTC.sha256(bytes);
  let out = '';
  for (let i = h.length - 1; i >= 0; i--) out += h[i].toString(16).padStart(2, '0');
  return out;
}

return { WalletScanner: WalletScanner };
})(BTC, __deriv.chainNode, __deriv.deriveChild, __deriv.TYPE_INFO,
  __electrum.historiesMany, __electrum.transactionsMany,
  __totals.totalsForScripts, __totals.utxosForScripts,
  __psbt.preparePsbt, __psbt.sendLimits, __psbt.prepareCpfpPsbt,
  __psbt.feeRateKvb, __psbt.feeSats, __psbt.DUST_SATS);
function hex(value) { return BTC.bytesToHex(value); }
function fingerprintOf(account) {
  return hex(BTC.hash160(account.pub)).slice(0, 8);
}
function rowOf(type, chain, index, derived) {
  return {
    account_type: type, chain: chain, idx: index,
    address: derived.address, path: derived.path,
    script: hex(derived.script), pub: hex(derived.pub),
    kind: (__deriv.TYPE_INFO[type] || {}).kind || 'p2wpkh'
  };
}
async function deriveRows(account, type, chain, from, count) {
  if (!Number.isInteger(from) || from < 0 || from >= 0x80000000) {
    throw new Error('índice inválido');
  }
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error('quantidade de endereços inválida');
  }
  var node = await __deriv.chainNode(account, chain);
  var out = [];
  for (var i = 0; i < count; i++) {
    var index = from + i;
    out.push(rowOf(type, chain, index,
      await __deriv.deriveChild(type, node, chain, index)));
  }
  return out;
}
global.LocalWallet = {
  parseXpub: __deriv.parseXpub, deriveRows: deriveRows,
  fingerprintOf: fingerprintOf, TYPE_INFO: __deriv.TYPE_INFO,
  scripthash: __electrum.scripthash, WalletScanner: __wallet.WalletScanner,
  inspectSignedPsbt: __broadcast.inspectSignedPsbt,
  previewSignedPsbt: __broadcast.previewSignedPsbt,
  broadcastSignedPsbt: __broadcast.broadcastSignedPsbt,
  totalsForScripts: __totals.totalsForScripts,
  utxosForScripts: __totals.utxosForScripts,
  DUST_SATS: __psbt.DUST_SATS, feeRateKvb: __psbt.feeRateKvb,
  feeSats: __psbt.feeSats, selectCoins: __psbt.selectCoins,
  sendLimits: __psbt.sendLimits, preparePsbt: __psbt.preparePsbt,
  prepareCpfpPsbt: __psbt.prepareCpfpPsbt,
  readTx: BTC.readTx, vsizeOf: BTC.vsizeOf, scriptKind: BTC.scriptKind,
  estimateVsize: BTC.estimateVsize,
  bytesToHex: BTC.bytesToHex, hexToBytes: BTC.hexToBytes
};
})(typeof window !== 'undefined' ? window : globalThis);
