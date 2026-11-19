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
     24 palavras, e é dessa frase (passphrase vazia) que sai a seed; a
     entrada na tela é por coordenadas. */
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
     a entrada da tela é por coordenadas. */
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
  async function bip39Seed(mnemonic) {
    var pass = '';
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
  async function deriveHD(bits) {
    if (bits.length !== 256) throw new Error('são necessários exatamente 256 bits');
    var mnemonic = bip39Mnemonic(bits);
    var seed = await bip39Seed(mnemonic);
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
    bip39Mnemonic: bip39Mnemonic,
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

export default BTC;
