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

function bytes(name) {
  return BTC.psbtParseInput(fs.readFileSync(new URL(name, dir), 'utf8'));
}
async function analyze(name) {
  return BTC.analyzePsbt(bytes(name), hd);
}

/* ---------------- 1. revisão normal: assina ---------------- */
{
  const a = await analyze('01-normal-1-externo-1-troco.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'troco']);
  assert.equal(a.fee, 10000n);
  assert.deepEqual(a.warnings, [], 'o caso normal não gera aviso');
  console.log('ok   01: externo + troco, sem aviso');
}
{
  const a = await analyze('03-dois-trocos.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'troco', 'troco']);
  assert.deepEqual(a.warnings, [], 'mais de um troco verificado não gera aviso');
  console.log('ok   03: externo + 2 trocos, sem aviso');
}
{
  const a = await analyze('04-sem-troco.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo']);
  assert.deepEqual(a.warnings, [], 'PSBT sem troco não gera aviso');
  console.log('ok   04: externo sem troco, sem aviso');
}
{
  const a = await analyze('07-recebimento-proprio.psbt');
  assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'recebimento']);
  console.log('ok   07: saída própria da cadeia 0 é recebimento');
}

/* 08–11: uma entrada de cada tipo e duas entradas; todas assinam. */
for (const name of [
  '08-entrada-p2pkh.psbt',
  '09-entrada-p2sh-p2wpkh.psbt',
  '10-entrada-p2tr.psbt',
  '11-duas-entradas.psbt'
]) {
  const a = await analyze(name);
  assert.deepEqual(a.warnings, [], name + ': sem aviso');
  const signed = await BTC.signPsbt(bytes(name), hd, new Uint8Array(32));
  assert.ok(signed.txid, name + ': assina');
  console.log('ok   ' + name.split('-')[0] + ': ' + a.inputs.map(i => i.kind).join(' + ') + ', assina');
}

/* ---------------- 2. recusa na importação ---------------- */
{
  await assert.rejects(analyze('02-dois-externos.psbt'), /mais de um destino externo/);
  await assert.rejects(BTC.signPsbt(bytes('02-dois-externos.psbt'), hd, new Uint8Array(32)),
    /mais de um destino externo/, 'a assinatura também é recusada');
  console.log('ok   02: dois externos recusados na importação');
}
{
  await assert.rejects(analyze('15-troco-sem-origem.psbt'), /saída própria sem origem BIP32/);
  console.log('ok   15: troco sem origem BIP32 recusado na importação');
}
{
  const a = await analyze('12-taxa-alta.psbt');
  assert.equal(a.feeNotice, 'acima de 500 sat/vB', 'taxa alta é marcada na legenda');
  const signed = await BTC.signPsbt(bytes('12-taxa-alta.psbt'), hd, new Uint8Array(32));
  assert.ok(signed.txid, 'taxa alta continua assinável');
  console.log('ok   12: taxa alta marcada na legenda e assina');
}
{
  const a = await analyze('18-taxa-baixa.psbt');
  assert.equal(a.feeNotice, 'abaixo de 0,1 sat/vB', 'taxa baixa é marcada na legenda');
  assert.deepEqual(a.warnings, []);
  const signed = await BTC.signPsbt(bytes('18-taxa-baixa.psbt'), hd, new Uint8Array(32));
  assert.ok(signed.txid, 'taxa baixa continua assinável');
  console.log('ok   18: taxa baixa marcada na legenda e assina');
}
{
  await assert.rejects(analyze('13-taxa-zero.psbt'), /taxa zero/);
  console.log('ok   13: taxa zero recusada na importação');
}
{
  await assert.rejects(analyze('14-saida-nao-padronizada.psbt'), /script não padronizado/);
  console.log('ok   14: saída com script não padronizado recusada na importação');
}

/* ---------------- 3. só exibição ---------------- */
{
  const a = await analyze('16-assinado.psbt');
  assert.equal(a.alreadySigned, true);
  await assert.rejects(BTC.signPsbt(bytes('16-assinado.psbt'), hd, new Uint8Array(32)),
    /já está assinado/);
  console.log('ok   16: assinado, só exibe');
}
{
  const a = await analyze('17-assinatura-parcial.psbt');
  assert.equal(a.signedInputs, 1);
  assert.equal(a.alreadySigned, true);
  assert.equal(a.outputs.length, 2);
  await assert.rejects(BTC.signPsbt(bytes('17-assinatura-parcial.psbt'), hd, new Uint8Array(32)),
    /já está assinado/);
  console.log('ok   17: assinatura parcial, carrega para exibição');
}

/* ---------------- 4. erros de importação ---------------- */
const erros = [
  ['30-entrada-de-terceiro.psbt', /não pertence às contas derivadas/],
  ['31-entrada-p2wsh.psbt', /P2WSH, não suportada/],
  ['32-entrada-witness-desconhecida.psbt', /tem script não suportado/],
  ['33-entrada-com-time-lock.psbt', /exige time lock/],
  ['34-entrada-sem-non-witness-utxo.psbt', /veio sem non_witness_utxo/],
  ['35-saidas-maiores-que-entradas.psbt', /as saídas somam mais que as entradas/],
  ['36-psbt-v2.psbt', /PSBT v2 não é suportado/],
  ['37-psbt-sem-transacao.psbt', /PSBT sem transação não assinada/],
  ['38-arquivo-invalido.psbt', /não começa com a marca psbt/],
  ['39-entrada-com-witness-script.psbt', /witness_script, não suportada/],
  ['40-entrada-taproot-script-path.psbt', /dados de script no Taproot/],
  ['41-entrada-taproot-merkle-root.psbt', /dados de script no Taproot/]
];
for (const [name, motivo] of erros) {
  await assert.rejects(analyze(name), motivo, name + ' é recusado');
}
console.log('ok   ' + erros.length + ' erros de importação recusados');

console.log('\ntestes dos PSBTs de exemplo passaram');
