#!/usr/bin/env node
/* Gera os PSBTs de exemplo do Cofre em psbt-exemplos/ (casos 07–18 e 30–41).

   Todos usam a mesma mnemônica pública de teste do LEIA-ME, uma entrada de
   100 000 sats (50 000 na segunda entrada) e um destino externo fixo; o que
   não vai para as saídas fica como taxa. O casos 01–04 são os exemplos
   originais e não são reescritos aqui.

   node scripts/build-psbt-exemplos.mjs */
import fs from 'node:fs';
import BTC from '../src/btc-core.js';

const OUT = new URL('../psbt-exemplos/', import.meta.url);
const MNEMONIC = 'length abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon awesome';
const AUX = new Uint8Array(32);

/* ------------------------------------------------ carteira de teste */
const seed = await BTC.bip39Seed(MNEMONIC, '');
const master = await BTC.masterFromSeed(seed);
const fingerprint = BTC.bytesToHex(
  BTC.hash160(BTC.pubCompressed(BTC.pointFromD(master.d)))
).slice(0, 8);
const hd = { mnemonic: MNEMONIC, master, fingerprint, accounts: {}, primary: null };
for (const [id, path, kind] of [
  ['bip86', "m/86'/0'/0'", 'p2tr'],
  ['bip84', "m/84'/0'/0'", 'p2wpkh'],
  ['bip49', "m/49'/0'/0'", 'p2sh-p2wpkh'],
  ['bip44', "m/44'/0'/0'", 'p2pkh']
]) {
  hd.accounts[id] = { id, path, kind, node: await BTC.derivePath(master, path) };
}
hd.primary = hd.accounts.bip86;

async function keyAt(accountId, chain, index) {
  const acc = hd.accounts[accountId];
  let node = await BTC.ckdPriv(acc.node, chain);
  node = await BTC.ckdPriv(node, index);
  const Q = BTC.pointFromD(node.d);
  return {
    kind: acc.kind, Q, d: node.d, pub: BTC.pubCompressed(Q),
    indices: BTC.parsePath(acc.path).concat([chain, index])
  };
}

/* Chave de outra carteira: só serve para montar um destino externo. */
function foreignKey(number) {
  const Q = BTC.pointFromD(BigInt(number));
  return { Q, pub: BTC.pubCompressed(Q) };
}

/* ------------------------------------------------ peças do PSBT */
/* Transação anterior sintética: o Cofre confere o txid do non_witness_utxo. */
function funding(label, value, script) {
  const prevTxid = BTC.bytesToHex(BTC.sha256(BTC.utf8('psbt-exemplo:' + label)));
  const tx = {
    version: 2,
    inputs: [{ txid: prevTxid, vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: BigInt(value), script }],
    witnesses: [], locktime: 0, segwit: false
  };
  const rawTx = BTC.writeTx(tx, false);
  return { txid: BTC.txidOf(tx), value, script, rawTx };
}

function spend(utxo, key) {
  return {
    txid: utxo.txid, vout: 0, value: utxo.value, script: utxo.script,
    kind: key.kind, pub: key.pub, path: BTC.pathText(key.indices),
    fingerprint, rawTx: utxo.rawTx
  };
}

function own(name, value, key) {
  return {
    value, script: BTC.scriptForKind(key.kind, key.Q),
    origin: { pub: key.pub, path: BTC.pathText(key.indices), fingerprint }
  };
}

function external(value, number = 7) {
  return { value, script: BTC.scriptForKind('p2wpkh', foreignKey(number).Q) };
}

function p2pkScript(number = 99) {
  return BTC.concatBytes(new Uint8Array([0x21]), foreignKey(number).pub, new Uint8Array([0xac]));
}

function p2wshScript() {
  return BTC.concatBytes(new Uint8Array([0x00, 0x20]), BTC.sha256(BTC.utf8('redeem de exemplo')));
}

function unknownWitnessScript() {
  return BTC.concatBytes(new Uint8Array([0x52, 0x14]), BTC.hash160(BTC.utf8('programa desconhecido')));
}

function save(name, bytes) {
  fs.writeFileSync(new URL(name, OUT), BTC.b64encode(bytes) + '\n');
  return name;
}

/* ------------------------------------------------ casos de revisão */
const bip84 = await keyAt('bip84', 0, 0);
const bip84b = await keyAt('bip84', 0, 1);
const bip86 = await keyAt('bip86', 0, 0);
const bip86Change = await keyAt('bip86', 1, 0);
const bip86Receive = await keyAt('bip86', 0, 3);

/* 07: externo + saída de recebimento (cadeia 0, com origem BIP32). */
{
  const u = funding('07', 100000, BTC.scriptForKind(bip86Receive.kind, bip86Receive.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip86Receive)],
    outputs: [external(30000), own('recebimento', 60000, bip86Receive)]
  });
  save('07-recebimento-proprio.psbt', b.bytes);
}

/* 08–10: uma entrada de cada tipo suportado. */
for (const [name, accountId, accountPath] of [
  ['08-entrada-p2pkh.psbt', 'bip44', "m/44'/0'/0'"],
  ['09-entrada-p2sh-p2wpkh.psbt', 'bip49', "m/49'/0'/0'"],
  ['10-entrada-p2tr.psbt', 'bip86', "m/86'/0'/0'"]
]) {
  const acc = hd.accounts[accountId];
  const node = await BTC.ckdPriv(await BTC.ckdPriv(acc.node, 1), 0);
  const Q = BTC.pointFromD(node.d);
  const key = { kind: acc.kind, Q, pub: BTC.pubCompressed(Q), indices: BTC.parsePath(accountPath).concat([1, 0]) };
  const u = funding(name, 100000, BTC.scriptForKind(key.kind, key.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, key)],
    outputs: [external(60000), own('troco', 30000, key)]
  });
  save(name, b.bytes);
}

/* 11: duas entradas (p2wpkh + p2tr). */
{
  const u1 = funding('11a', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const u2 = funding('11b', 50000, BTC.scriptForKind(bip86.kind, bip86.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u1, bip84), spend(u2, bip86)],
    outputs: [external(100000), own('troco', 40000, bip86Change)]
  });
  save('11-duas-entradas.psbt', b.bytes);
}

/* 12: taxa acima de 500 sat/vB. */
{
  const u = funding('12', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip84)], outputs: [external(30000)] });
  save('12-taxa-alta.psbt', b.bytes);
}

/* 13: taxa zero. */
{
  const u = funding('13', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip84)],
    outputs: [external(60000), own('troco', 40000, bip86Change)]
  });
  save('13-taxa-zero.psbt', b.bytes);
}

/* 14: saída com script não padronizado (P2PK) + troco. */
{
  const u = funding('14', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip84)],
    outputs: [{ value: 30000, script: p2pkScript() }, own('troco', 60000, bip86Change)]
  });
  save('14-saida-nao-padronizada.psbt', b.bytes);
}

/* 15: troco sem origem BIP32 + externo sem origem — o Cofre não consegue
   separar o troco do pagamento (aviso próprio, sem assinar). */
{
  const u = funding('15', 100000, BTC.scriptForKind(bip86Change.kind, bip86Change.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip86Change)],
    outputs: [
      { value: 30000, script: BTC.scriptForKind('p2wpkh', foreignKey(7).Q) },
      { value: 60000, script: BTC.scriptForKind(bip86Change.kind, bip86Change.Q) }
    ]
  });
  save('15-troco-sem-origem.psbt', b.bytes);
}

/* 16: PSBT já assinado e finalizado (só pode ser exibido). */
{
  const u = funding('16', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip84)],
    outputs: [external(60000), own('troco', 30000, bip86Change)]
  });
  const signed = await BTC.signPsbt(b.bytes, hd, AUX);
  save('16-assinado.psbt', signed.psbt);
}

/* 17: uma entrada com assinatura parcial (o Cofre exibe, não assina). A
   assinatura é a de partial_sig (0x02), feita sobre a transação de duas
   entradas: só a presença do campo importa para a revisão. */
{
  const u1 = funding('17a', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const u2 = funding('17b', 50000, BTC.scriptForKind(bip84b.kind, bip84b.Q));
  const dois = BTC.buildPsbt({
    inputs: [spend(u1, bip84), spend(u2, bip84b)],
    outputs: [external(100000), own('troco', 40000, bip86Change)]
  });
  const code = BTC.concatBytes(new Uint8Array([0x76, 0xa9, 0x14]),
    BTC.hash160(bip84.pub), new Uint8Array([0x88, 0xac]));
  const dg = BTC.sighashV0(dois.psbt.tx, 0, code, BigInt(u1.value), 1);
  const sig = BTC.signDigest(bip84.d, dg);
  dois.psbt.inputs[0].push({
    key: BTC.concatBytes(new Uint8Array([0x02]), bip84.pub),
    value: BTC.concatBytes(sig.der, new Uint8Array([0x01]))
  });
  save('17-assinatura-parcial.psbt', BTC.writePsbt(dois.psbt));
}

/* 18: taxa abaixo de 0,1 sat/vB: marcada na legenda da taxa, sem recusa. */
{
  const u = funding('18', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip84)],
    outputs: [external(79995), own('troco', 20000, bip86Change)]
  });
  save('18-taxa-baixa.psbt', b.bytes);
}

/* ------------------------------------------------ erros de importação */
/* 30: entrada de terceiro (origem declarada não deriva a chave do script). */
{
  const estranho = foreignKey(2);
  const script = BTC.scriptForKind('p2wpkh', estranho.Q);
  const u = funding('30', 100000, script);
  const b = BTC.buildPsbt({
    inputs: [{
      txid: u.txid, vout: 0, value: u.value, script, kind: 'p2wpkh',
      pub: estranho.pub, path: "m/84'/0'/0'/0/0", fingerprint, rawTx: u.rawTx
    }],
    outputs: [external(30000)]
  });
  save('30-entrada-de-terceiro.psbt', b.bytes);
}

/* 31: entrada P2WSH. */
{
  const script = p2wshScript();
  const u = funding('31', 100000, script);
  const b = BTC.buildPsbt({
    inputs: [{
      txid: u.txid, vout: 0, value: u.value, script, kind: 'p2wsh',
      pub: bip84.pub, path: BTC.pathText(bip84.indices), fingerprint, rawTx: u.rawTx
    }],
    outputs: [external(30000)]
  });
  save('31-entrada-p2wsh.psbt', b.bytes);
}

/* 32: entrada com witness de versão desconhecida (BIP141). */
{
  const script = unknownWitnessScript();
  const u = funding('32', 100000, script);
  const b = BTC.buildPsbt({
    inputs: [{
      txid: u.txid, vout: 0, value: u.value, script, kind: 'witness',
      pub: bip84.pub, path: BTC.pathText(bip84.indices), fingerprint, rawTx: u.rawTx
    }],
    outputs: [external(30000)]
  });
  save('32-entrada-witness-desconhecida.psbt', b.bytes);
}

/* 33: entrada com time lock exigido pelo PSBT. */
{
  const u = funding('33', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip84)], outputs: [external(30000)] });
  b.psbt.inputs[0].push({ key: BTC.hexToBytes('12'), value: BTC.hexToBytes('20a10700') });
  save('33-entrada-com-time-lock.psbt', BTC.writePsbt(b.psbt));
}

/* 34: entrada sem non_witness_utxo (taxa normal, para o erro ser só esse). */
{
  const u = funding('34', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip84)], outputs: [external(90000)] });
  b.psbt.inputs[0] = b.psbt.inputs[0].filter((e) => e.key[0] !== 0x00);
  save('34-entrada-sem-non-witness-utxo.psbt', BTC.writePsbt(b.psbt));
}

/* 35: saídas somam mais que a entrada. */
{
  const u = funding('35', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({
    inputs: [spend(u, bip84)],
    outputs: [external(90000), own('troco', 30000, bip86Change)]
  });
  save('35-saidas-maiores-que-entradas.psbt', b.bytes);
}

/* 36: PSBT v2. */
{
  const u = funding('36', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip84)], outputs: [external(30000)] });
  b.psbt.global.push({ key: new Uint8Array([0xfb]), value: BTC.hexToBytes('02000000') });
  save('36-psbt-v2.psbt', BTC.writePsbt(b.psbt));
}

/* 37: marca psbt sem a transação não assinada. */
{
  save('37-psbt-sem-transacao.psbt', new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0x00]));
}

/* 38: arquivo que não é PSBT (texto em base64 válido). */
{
  save('38-arquivo-invalido.psbt', BTC.utf8('isto não é um PSBT\n'));
}

/* 39: entrada com witness_script (P2WSH/multisig). */
{
  const u = funding('39', 100000, BTC.scriptForKind(bip84.kind, bip84.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip84)], outputs: [external(30000)] });
  b.psbt.inputs[0].push({ key: new Uint8Array([0x05]), value: BTC.hexToBytes('51') });
  save('39-entrada-com-witness-script.psbt', BTC.writePsbt(b.psbt));
}

/* 40: entrada p2tr com tap_script_sig (0x14). O campo tem chave com dado,
   então a detecção usa mapFindAll (mapFind só casa chave vazia). */
{
  const u = funding('40', 100000, BTC.scriptForKind(bip86.kind, bip86.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip86)], outputs: [external(90000)] });
  b.psbt.inputs[0].push({
    key: BTC.concatBytes(new Uint8Array([0x14]), new Uint8Array(64)),
    value: new Uint8Array(64)
  });
  save('40-entrada-taproot-script-path.psbt', BTC.writePsbt(b.psbt));
}

/* 41: entrada p2tr com tap_merkle_root (0x18): chave vazia, então o Cofre
   reconhece o script path e recusa. */
{
  const u = funding('41', 100000, BTC.scriptForKind(bip86.kind, bip86.Q));
  const b = BTC.buildPsbt({ inputs: [spend(u, bip86)], outputs: [external(30000)] });
  b.psbt.inputs[0].push({
    key: new Uint8Array([0x18]),
    value: BTC.sha256(BTC.utf8('raiz de script de exemplo'))
  });
  save('41-entrada-taproot-merkle-root.psbt', BTC.writePsbt(b.psbt));
}

console.log('PSBTs de exemplo gerados em psbt-exemplos/');
