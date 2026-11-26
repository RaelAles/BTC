/* Teste dos PSBTs de exemplo publicados em psbt-exemplos/: o que o LEIA-ME
   promete é o que o núcleo faz. A mnemônica é a mesma publicada e serve só
   para derivar as contas de teste.

   node test/psbt-exemplos.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import BTC from '../src/btc-core.js';

const dir = new URL('../psbt-exemplos/', import.meta.url);
const readme = fs.readFileSync(new URL('LEIA-ME.md', dir), 'utf8');
const mnemonic = 'length abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon awesome';
assert.ok(readme.includes(mnemonic), 'a mnemônica do teste é a publicada no LEIA-ME');

const seed = await BTC.bip39Seed(mnemonic, '');
const master = await BTC.masterFromSeed(seed);
const fingerprint = BTC.bytesToHex(
  BTC.hash160(BTC.pubCompressed(BTC.pointFromD(master.d)))
).slice(0, 8);
const defs = [
  ['bip86', "m/86'/0'/0'", 'p2tr'],
  ['bip84', "m/84'/0'/0'", 'p2wpkh'],
  ['bip49', "m/49'/0'/0'", 'p2sh-p2wpkh'],
  ['bip44', "m/44'/0'/0'", 'p2pkh']
];
const accounts = {};
for (const [id, path, kind] of defs) {
  accounts[id] = { id, path, kind, node: await BTC.derivePath(master, path) };
}
const hd = {
  mnemonic, master, fingerprint, accounts, primary: accounts.bip86
};

async function analyze(name) {
  const text = fs.readFileSync(new URL(name, dir), 'utf8');
  return BTC.analyzePsbt(BTC.psbtParseInput(text), hd);
}

/* ---------------- 1. externo + troco ---------------- */
{
  const a = await analyze('01-normal-1-externo-1-troco.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'troco']);
  assert.equal(a.fee, 10000n);
  assert.ok(!a.warnings.some(w => /destino externo|sem origem BIP32/.test(w)),
    'o caso normal não gera aviso estrutural');
  console.log('ok   01: externo + troco, sem aviso estrutural');
}

/* ---------------- 2. dois externos ---------------- */
{
  const bytes = fs.readFileSync(new URL('02-dois-externos.psbt', dir), 'utf8');
  const a = await BTC.analyzePsbt(BTC.psbtParseInput(bytes), hd);
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'externo']);
  assert.ok(a.warnings.some(w => /mais de um destino externo/.test(w)),
    'a revisão mostra o aviso, em vez de esconder o arquivo');
  await assert.rejects(BTC.signPsbt(BTC.psbtParseInput(bytes), hd, new Uint8Array(32)),
    /mais de um destino externo/, 'a assinatura é recusada');
  console.log('ok   02: dois externos avisam na revisão e recusam a assinatura');
}

/* ---------------- 3. dois trocos ---------------- */
{
  const a = await analyze('03-dois-trocos.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'troco', 'troco']);
  assert.ok(!a.warnings.some(w => /destino externo|sem origem BIP32|mais de uma saída de troco/.test(w)),
    'mais de um troco verificado não gera aviso estrutural');
  console.log('ok   03: externo + 2 trocos, sem aviso estrutural');
}

/* ---------------- 4. sem troco ---------------- */
{
  const a = await analyze('04-sem-troco.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo']);
  assert.ok(!a.warnings.some(w => /destino externo|sem origem BIP32|sem saída de troco/.test(w)),
    'PSBT sem troco não gera aviso estrutural');
  console.log('ok   04: externo sem troco, sem aviso estrutural');
}

console.log('\ntestes dos PSBTs de exemplo passaram');
