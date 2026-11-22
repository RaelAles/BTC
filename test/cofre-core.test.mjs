/* Teste do núcleo criptográfico embutido no Cofre BTC.

   Extrai o IIFE `var BTC = ...` do HTML e roda os mesmos vetores oficiais e
   os PSBTs do projeto. Também confere o import do cofre: PSBT já assinado
   (do cofre ou de outra fonte, inclusive parcial ou finalizado) é exibido,
   mas não assinado; PSBT sem assinatura com SIGHASH_ALL no Taproot é
   recusado.

   Sem rede: os vetores são fixos e o PSBT é montado pelo btc-core do projeto.

   node test/cofre-core.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import BTC from '../src/btc-core.js';

/* ---------------- extração do núcleo embutido ---------------- */
const html = readFileSync(new URL('../public/cofre-btc.html', import.meta.url), 'utf8');
const start = html.indexOf('var BTC = (function () {');
const marker = "if (typeof module !== 'undefined' && module.exports) module.exports = BTC;";
const end = html.indexOf(marker, start);
assert.ok(start >= 0 && end > start, 'núcleo BTC não encontrado no HTML do Cofre BTC');
const dir = mkdtempSync(join(tmpdir(), 'cofre-core-'));
const coreFile = join(dir, 'core.cjs');
writeFileSync(coreFile, html.slice(start, end + marker.length));
const require = createRequire(import.meta.url);
const C = require(coreFile);

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const zeros = new Uint8Array(32);

/* ---------------- vetores oficiais ---------------- */
assert.equal(hex(C.sha256(new TextEncoder().encode('abc'))),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(hex(C.ripemd160(new TextEncoder().encode('abc'))),
  '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
assert.equal(C.bip39Mnemonic('0'.repeat(256)), 'abandon '.repeat(23) + 'art');
assert.equal(C.bip39Mnemonic('1'.repeat(256)), 'zoo '.repeat(23) + 'vote');

{
  /* BIP32, vetor 1 */
  const m = await C.masterFromSeed(bytes('000102030405060708090a0b0c0d0e0f'));
  assert.equal(C.extendedKey(0x0488ADE4, m, true),
    'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi');
  assert.equal(C.extendedKey(0x0488B21E, m, false),
    'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8');
  const child = await C.derivePath(m, "m/0'/1");
  assert.equal(C.extendedKey(0x0488ADE4, child, true),
    'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs');
  console.log('ok   vetores BIP39 e BIP32');
}

{
  /* BIP84 / BIP86 com a mnemônica de teste oficial */
  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const master = await C.masterFromSeed(await C.bip39Seed(words));
  const leaf84 = await C.derivePath(master, "m/84'/0'/0'/0/0");
  assert.equal(C.addressFor('p2wpkh', C.pointFromD(leaf84.d)), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  const leaf86 = await C.derivePath(master, "m/86'/0'/0'/0/0");
  assert.equal(C.addressFor('p2tr', C.pointFromD(leaf86.d)), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  console.log('ok   endereços BIP84 e BIP86');
}

{
  /* BIP340, vetor 0 */
  const sig = C.bip340Sign(3n, new Uint8Array(32), new Uint8Array(32));
  assert.equal(hex(sig).toUpperCase(),
    'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0');
  assert.equal(C.bip340Verify(
    bytes('F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9'),
    new Uint8Array(32), sig), true);
  console.log('ok   assinatura e verificação BIP340');
}

{
  /* BIP143, exemplo P2WPKH */
  const tx = C.readTx(bytes('0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000'));
  const scriptCode = bytes('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
  const h1 = C.sighashV0(tx, 1, scriptCode, 600000000n, 1);
  assert.equal(hex(h1), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
  const d = BigInt('0x619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9');
  const sig = C.signDigest(d, h1);
  assert.equal(hex(sig.der) + '01',
    '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01');
  console.log('ok   sighash e assinatura BIP143 (P2WPKH)');
}

/* ---------------- o núcleo embutido == btc-core no fluxo do cofre ---------------- */
const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);
const ehd = await C.deriveHD(bits);
assert.equal(ehd.mnemonic, hd.mnemonic);
assert.equal(ehd.fingerprint, hd.fingerprint);
for (const id of ['bip44', 'bip49', 'bip84', 'bip86']) {
  assert.equal(ehd.accounts[id].xprv, hd.accounts[id].xprv, 'xprv ' + id);
  assert.equal(ehd.accounts[id].xpub, hd.accounts[id].xpub, 'xpub ' + id);
}
console.log('ok   derivação HD idêntica à do btc-core');

/* ---------------- frase secreta opcional (BIP39) ---------------- */
{
  /* Vetor oficial do BIP39: a mesma frase com a frase secreta "TREZOR"
     muda a seed e, com ela, toda a árvore BIP32. */
  const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = await BTC.bip39Seed(words, 'TREZOR');
  assert.equal(hex(seed),
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
  assert.equal(hex(await C.bip39Seed(words, 'TREZOR')), hex(seed));
  /* Sem a frase secreta, ou com ela vazia, a seed é a de antes. */
  assert.equal(hex(await BTC.bip39Seed(words)), hex(await BTC.bip39Seed(words, '')));
  const comFrase = await BTC.deriveHD(bits, 'TREZOR');
  assert.notEqual(comFrase.fingerprint, hd.fingerprint);
  assert.equal(comFrase.fingerprint, (await C.deriveHD(bits, 'TREZOR')).fingerprint);
  /* Vetor japonês do BIP39: a frase secreta só bate depois da normalização
     NFKD do sal (ex.: ㍍ vira メートル). Sem ela, o teste com "TREZOR"
     passaria mesmo que o nfkd do sal tivesse regredido. */
  const jpWords = 'あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あいこくしん あおぞら';
  const jpPass = '㍍ガバヴァぱばぐゞちぢ十人十色';
  const jpSeed = 'a262d6fb6122ecf45be09c50492b31f92e9beb7d9a845987a02cefda57a15f9c467a17872029a9e92299b5cbdf306e3a0ee620245cbd508959b6cb7ca637bd55';
  assert.equal(hex(await BTC.bip39Seed(jpWords, jpPass)), jpSeed);
  assert.equal(hex(await C.bip39Seed(jpWords, jpPass)), jpSeed);
  console.log('ok   frase secreta entra no PBKDF2 e muda a derivação');
}

const cases = [
  { kind: 'p2pkh', path: "m/44'/0'/0'", leaf: "m/44'/0'/0'/0/0" },
  { kind: 'p2sh-p2wpkh', path: "m/49'/0'/0'", leaf: "m/49'/0'/0'/0/0" },
  { kind: 'p2wpkh', path: "m/84'/0'/0'", leaf: "m/84'/0'/0'/0/0" },
  { kind: 'p2tr', path: "m/86'/0'/0'", leaf: "m/86'/0'/0'/0/0" }
];
const externalScript = BTC.scriptForKind('p2wpkh', BTC.pointFromD(99n));
let p2wBytes = null, p2wPub = null, p2wSigned = null;
let p2trBytes = null;

for (const c of cases) {
  const leaf = await BTC.derivePath(hd.master, c.leaf);
  const Q = BTC.pointFromD(leaf.d);
  const pub = BTC.pubCompressed(Q);
  const script = BTC.scriptForKind(c.kind, Q);
  const account = await BTC.derivePath(hd.master, c.path);
  const fingerprint = hex(BTC.hash160(BTC.pubCompressed(BTC.pointFromD(account.d)))).slice(0, 8);

  /* transação anterior inteira (non_witness_utxo), como o projeto principal manda */
  const prev = {
    version: 2,
    inputs: [{ txid: '00'.repeat(32), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: 100000n, script }],
    witnesses: [], locktime: 0, segwit: false
  };
  const rawTx = BTC.writeTx(prev, false);
  const prevTxid = BTC.txidOf(prev);

  const built = BTC.buildPsbt({
    inputs: [{
      txid: prevTxid, vout: 0, value: 100000n, script, kind: c.kind,
      pub, path: c.leaf, fingerprint, rawTx
    }],
    outputs: [{ value: 90000n, script: externalScript }]
  });

  const review = await C.analyzePsbt(built.bytes, ehd);
  assert.equal(review.inputs[0].kind, c.kind, 'kind ' + c.kind);
  assert.equal(review.inputs[0].path, c.leaf, 'path ' + c.kind);
  assert.equal(review.outputs[0].own, 'externo', 'saída externa ' + c.kind);
  assert.equal(review.fee, 10000n, 'taxa ' + c.kind);

  const signed = await C.signPsbt(built.bytes, ehd, zeros);
  const expected = await BTC.signPsbt(built.bytes, hd, zeros);
  assert.equal(signed.txHex, expected.txHex, 'tx hex ' + c.kind);
  assert.equal(signed.txid, expected.txid, 'txid ' + c.kind);

  if (c.kind === 'p2wpkh') { p2wBytes = built.bytes; p2wPub = pub; p2wSigned = signed; }
  if (c.kind === 'p2tr') p2trBytes = built.bytes;
}
console.log('ok   PSBTs p2pkh, p2sh-p2wpkh, p2wpkh e p2tr assinados igual ao btc-core');

/* ---------------- PSBT assinado: exibe, não assina ---------------- */
{
  /* o próprio PSBT finalizado (campos finais) é exibido com txid real */
  const own = await C.analyzePsbt(C.psbtParseInput(p2wSigned.psbtBase64), ehd);
  assert.equal(own.alreadySigned, true);
  assert.equal(C.psbtFinalTx(own.psbt).txid, p2wSigned.txid);
  assert.equal(own.tx.locktime, 0);
  assert.equal(own.tx.inputs[0].sequence, 0xffffffff);
  await assert.rejects(C.signPsbt(C.psbtParseInput(p2wSigned.psbtBase64), ehd, zeros),
    /já tem assinatura/);
  console.log('ok   PSBT finalizado é exibido (txid real) e não é assinado');
}

{
  /* assinatura parcial de outra ferramenta: exibe com vsize/txid estimados */
  const psbt = C.parsePsbt(p2wBytes);
  psbt.inputs[0].push({
    key: C.concatBytes(new Uint8Array([0x02]), p2wPub),
    value: new Uint8Array([0x01])
  });
  const partialBytes = C.writePsbt(psbt);
  const a = await C.analyzePsbt(partialBytes, ehd);
  assert.equal(a.alreadySigned, true);
  assert.throws(() => C.psbtFinalTx(a.psbt), /não está finalizada/);
  await assert.rejects(C.signPsbt(partialBytes, ehd, zeros), /já tem assinatura/);
  console.log('ok   PSBT parcial é exibido (estimado) e não é assinado');
}

{
  /* finalizado por outra ferramenta: só final_scriptWitness, sem o 0x07 */
  const psbt = C.parsePsbt(C.psbtParseInput(p2wSigned.psbtBase64));
  psbt.inputs[0] = psbt.inputs[0].filter(e => !(e.key.length === 1 && e.key[0] === 0x07));
  const foreignBytes = C.writePsbt(psbt);
  const a = await C.analyzePsbt(foreignBytes, ehd);
  assert.equal(a.alreadySigned, true);
  assert.equal(C.psbtFinalTx(a.psbt).txid, p2wSigned.txid);
  await assert.rejects(C.signPsbt(foreignBytes, ehd, zeros), /já tem assinatura/);
  console.log('ok   PSBT finalizado sem final_scriptSig é exibido com txid real');
}

{
  /* o PSBT sem assinatura continua assinável */
  const unsigned = await C.analyzePsbt(p2wBytes, ehd);
  assert.equal(unsigned.alreadySigned, false);
  console.log('ok   PSBT sem assinatura continua assinável');
}

{
  /* Taproot com SIGHASH_ALL sem assinatura: recusa em vez de gerar tx inválida */
  const psbt = C.parsePsbt(p2trBytes);
  psbt.inputs[0].push({ key: new Uint8Array([0x03]), value: new Uint8Array([1, 0, 0, 0]) });
  await assert.rejects(C.analyzePsbt(C.writePsbt(psbt), ehd),
    /SIGHASH_DEFAULT/);
  console.log('ok   Taproot com SIGHASH_ALL sem assinatura recusado');
}

rmSync(dir, { recursive: true, force: true });
console.log('\ntestes do núcleo embutido no Cofre BTC passaram');
