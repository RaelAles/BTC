/* Teste de paridade entre o núcleo do projeto (src/btc-core.js) e a cópia
   embutida em public/cofre-btc.html.

   As duas cópias ainda são mantidas à mão (o Cofre é standalone), mas não
   podem divergir nas validações que decidem se um PSBT é aceito: o Worker
   confere o arquivo antes de transmitir e o Cofre assina o mesmo arquivo.
   Aqui as duas cópias recebem os mesmos vetores — inclusive os malformados —
   e têm de concordar.

   A sincronização pelo scripts/sync-cofre-core.mjs NÃO é feita hoje: os dois
   núcleos divergem de propósito no que é próprio de cada consumidor (o Cofre
   escreve avisos com marcação HTML, tem derive/buildPsbt a menos e mostra
   PSBT já assinado em vez de recusá-lo). O que precisa ser igual é a
   validação do arquivo, e é isso que este teste garante.

   node test/cofre-core-parity.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import BTC from '../src/btc-core.js';
import { embeddedCore } from '../scripts/sync-cofre-core.mjs';

const html = readFileSync(new URL('../public/cofre-btc.html', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'cofre-parity-'));
const coreFile = join(dir, 'core.cjs');
writeFileSync(coreFile, embeddedCore(html));
const require = createRequire(import.meta.url);
const C = require(coreFile);

const hex = (b) => Buffer.from(b).toString('hex');
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));

/* ---------------- superfície exportada ---------------- */
for (const key of Object.keys(C)) {
  assert.equal(typeof BTC[key], typeof C[key], 'api ' + key + ' existe nas duas cópias');
}

/* ---------------- mesmos vetores, mesmo resultado ---------------- */
for (const [label, fn] of [
  ['sha256', (core) => hex(core.sha256(new TextEncoder().encode('abc')))],
  ['ripemd160', (core) => hex(core.ripemd160(new TextEncoder().encode('abc')))],
  ['bip39Mnemonic', (core) => core.bip39Mnemonic('0'.repeat(256))],
  ['base58', (core) => core.base58check(bytes('00010966776006953d5567439e5e39f86a0d273beed61967f6'))],
  ['scriptKind/outro', (core) => core.scriptKind(new Uint8Array([0x00, 0x15, ...new Uint8Array(21)]))],
  ['b64 roundtrip', (core) => hex(core.b64decode(core.b64encode(bytes('00ff10'))))]
]) {
  assert.equal(fn(BTC), fn(C), label);
}

/* ---------------- validações malformadas: as duas recusam ---------------- */
{
  /* varint truncado: 0xfd sem os dois bytes do valor (chave do mapa global) */
  const truncated = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff, 0xfd]);
  for (const core of [BTC, C]) assert.throws(() => core.parsePsbt(truncated), /varint|PSBT/);
  console.log('ok   parsePsbt recusa varint truncado nas duas cópias');
}

{
  /* base64 com comprimento ≡ 1 (mod 4) não completa um byte */
  for (const core of [BTC, C]) assert.throws(() => core.b64decode('AAAAA'), /base64|conteúdo/);
  console.log('ok   b64decode recusa comprimento ≡ 1 mod 4 nas duas cópias');
}

{
  /* witness v0 só existe em 20 ou 32 bytes (BIP141/BIP173) */
  const bad = new Uint8Array([0x00, 0x15, ...new Uint8Array(21)]);
  for (const core of [BTC, C]) assert.equal(core.scriptKind(bad), 'outro');
  console.log('ok   scriptKind não trata witness v0 de tamanho inválido como segwit');
}

function psbtWithGlobal(global, inputs, outputs) {
  return BTC.writePsbt({ global, inputs, outputs });
}

{
  /* PSBT v2 não é aceito */
  const built = BTC.buildPsbt({
    inputs: [{
      txid: '00'.repeat(32), vout: 0, value: 1000n,
      script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(7n)),
      kind: 'p2wpkh', pub: BTC.pubCompressed(BTC.pointFromD(7n)),
      path: "m/84'/0'/0'/0/0", fingerprint: '00000000'
    }],
    outputs: [{ value: 900n, script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(8n)) }]
  });
  const psbt = BTC.parsePsbt(built.bytes);
  psbt.global.push({ key: new Uint8Array([0xfb]), value: new Uint8Array([2, 0, 0, 0]) });
  const v2 = BTC.writePsbt(psbt);
  for (const core of [BTC, C]) assert.throws(() => core.parsePsbt(v2), /v2|v0/);
  console.log('ok   parsePsbt recusa PSBT v2 nas duas cópias');
}

{
  /* transação não assinada no formato witness ou com scriptSig fere o BIP174 */
  const tx = {
    version: 2,
    inputs: [{ txid: '00'.repeat(32), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: 1000n, script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(7n)) }],
    witnesses: [[new Uint8Array([0x01])]], locktime: 0, segwit: true
  };
  const witnessTx = psbtWithGlobal(
    [{ key: new Uint8Array([0x00]), value: BTC.writeTx(tx, true) }], [[]], [[]]);
  for (const core of [BTC, C]) assert.throws(() => core.parsePsbt(witnessTx), /witness|PSBT/);

  tx.segwit = false;
  tx.witnesses = [];
  tx.inputs[0].scriptSig = new Uint8Array([0x51]);
  const scriptSigTx = psbtWithGlobal(
    [{ key: new Uint8Array([0x00]), value: BTC.writeTx(tx, false) }], [[]], [[]]);
  for (const core of [BTC, C]) assert.throws(() => core.parsePsbt(scriptSigTx), /scriptSig|PSBT/);
  console.log('ok   parsePsbt recusa unsigned tx witness/scriptSig nas duas cópias');
}

{
  /* PSBT finalizado só com final_scriptWitness é aceito pelas duas cópias e
     gera a mesma transação (é o caminho de assinadores de terceiros). */
  const Q = BTC.pointFromD(99n);
  const script = BTC.scriptForKind('p2wpkh', Q);
  const prev = {
    version: 2,
    inputs: [{ txid: '00'.repeat(32), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: 10000n, script }], witnesses: [], locktime: 0, segwit: false
  };
  const built = BTC.buildPsbt({
    inputs: [{
      txid: BTC.txidOf(prev), vout: 0, value: 10000n, script, kind: 'p2wpkh',
      pub: BTC.pubCompressed(Q), path: "m/84'/0'/0'/0/0", fingerprint: '00000000',
      rawTx: BTC.writeTx(prev, false)
    }],
    outputs: [{ value: 9000n, script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(7n)) }]
  });
  const psbt = BTC.parsePsbt(built.bytes);
  psbt.inputs[0].push({
    key: new Uint8Array([0x08]),
    value: BTC.concatBytes(BTC.writeVarInt(2),
      BTC.writeVarInt(72), new Uint8Array(72), BTC.writeVarInt(33), new Uint8Array(33))
  });
  const finalOnlyWitness = BTC.parsePsbt(BTC.writePsbt(psbt));
  const a = BTC.psbtFinalTx(finalOnlyWitness);
  const b = C.psbtFinalTx(C.parsePsbt(psbtWithGlobal(psbt.global, psbt.inputs, psbt.outputs)));
  assert.equal(a.hex, b.hex);
  console.log('ok   psbtFinalTx aceita só final_scriptWitness nas duas cópias');
}

/* ---------------- mapa de PSBT malformado: as duas recusam ----------------
   Cada vetor parte de um PSBT v0 válido e mexe em um campo de mapa. O que
   importa não é a mensagem (as duas cópias usam textos próprios), mas o
   veredito: nenhuma aceita o arquivo. */
{
  const Q = BTC.pointFromD(21n);
  const script = BTC.scriptForKind('p2wpkh', Q);
  const build = () => BTC.buildPsbt({
    inputs: [{
      txid: '11'.repeat(32), vout: 0, value: 50000n, script, kind: 'p2wpkh',
      pub: BTC.pubCompressed(Q), path: "m/84'/0'/0'/0/0", fingerprint: '00000000'
    }],
    outputs: [{ value: 49000n, script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(7n)) }]
  });
  const base = () => BTC.parsePsbt(build().bytes);
  /* troca o valor do campo de um tipo (sem criar chave repetida) */
  const troca = (map, tipo, valor) => {
    const alvo = map.find((e) => e.key.length === 1 && e.key[0] === tipo);
    if (!alvo) throw new Error('vetor inválido: mapa sem o campo 0x' + tipo.toString(16));
    alvo.value = valor;
  };
  const vetores = [
    ['chave repetida', (p) => p.global.push({ key: p.global[0].key.slice(), value: p.global[0].value })],
    ['version com tamanho errado', (p) => p.global.push({ key: new Uint8Array([0xfb]), value: new Uint8Array([2, 0]) })],
    ['campo de PSBT v2 no global de v0', (p) => p.global.push({ key: new Uint8Array([0x02]), value: new Uint8Array(32) })],
    ['witness_utxo com bytes extras', (p) => troca(p.inputs[0], 0x01,
      BTC.concatBytes(p.inputs[0].find((e) => e.key[0] === 0x01).value, new Uint8Array([0x00])))],
    ['non_witness_utxo truncado', (p) => p.inputs[0].push({ key: new Uint8Array([0x00]), value: new Uint8Array([0x02, 0x00]) })],
    ['final_scriptWitness vazio', (p) => p.inputs[0].push({ key: new Uint8Array([0x08]), value: new Uint8Array(0) })],
    ['tap_key_sig com 63 bytes', (p) => p.inputs[0].push({ key: new Uint8Array([0x13]), value: new Uint8Array(63) })],
    ['bip32_derivation com pubkey de 32 bytes', (p) => p.inputs[0].push({
      key: BTC.concatBytes(new Uint8Array([0x06]), new Uint8Array(32)), value: new Uint8Array(4) })],
    ['tap_internal_key com 31 bytes', (p) => p.inputs[0].push({ key: new Uint8Array([0x17]), value: new Uint8Array(31) })],
    ['saída com bytes extras na chave', (p) => p.outputs[0].push({ key: new Uint8Array([0x00, 0x00]), value: new Uint8Array(0) })],
    ['saída com tap_tree vazia', (p) => p.outputs[0].push({ key: new Uint8Array([0x06]), value: new Uint8Array(0) })]
  ];
  /* o PSBT de partida é aceito pelas duas cópias */
  for (const core of [BTC, C]) assert.doesNotThrow(() => core.parsePsbt(build().bytes), 'PSBT de partida válido');
  for (const [label, mexe] of vetores) {
    const psbt = base();
    mexe(psbt);
    const bytes = BTC.writePsbt(psbt);
    for (const core of [BTC, C]) {
      assert.throws(() => core.parsePsbt(bytes), /./, label + ': as duas cópias recusam');
    }
  }
  console.log('ok   ' + vetores.length + ' mapas malformados recusados pelas duas cópias');
}

/* ---------------- estrutura das saídas: mesmas regras ---------------- */
{
  const bits = '1' + '0'.repeat(255);
  const hd = await BTC.deriveHD(bits);
  const ehd = await C.deriveHD(bits);
  const leaf = await BTC.derivePath(hd.master, "m/84'/0'/0'/0/0");
  const Q = BTC.pointFromD(leaf.d);
  const script = BTC.scriptForKind('p2wpkh', Q);
  const pub = BTC.pubCompressed(Q);
  const account = await BTC.derivePath(hd.master, "m/84'/0'/0'");
  const fingerprint = hex(BTC.hash160(BTC.pubCompressed(BTC.pointFromD(account.d)))).slice(0, 8);
  const prev = {
    version: 2,
    inputs: [{ txid: '00'.repeat(32), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }],
    outputs: [{ value: 100000n, script }], witnesses: [], locktime: 0, segwit: false
  };
  const input = {
    txid: BTC.txidOf(prev), vout: 0, value: 100000n, script, kind: 'p2wpkh',
    pub, path: "m/84'/0'/0'/0/0", fingerprint, rawTx: BTC.writeTx(prev, false)
  };
  const external = (n) => BTC.scriptForKind('p2wpkh', BTC.pointFromD(n));
  const change = async (idx) => {
    const node = await BTC.derivePath(hd.master, "m/84'/0'/0'/1/" + idx);
    return {
      value: 20000n,
      script: BTC.scriptForKind('p2wpkh', BTC.pointFromD(node.d)),
      origin: {
        fingerprint,
        path: "m/84'/0'/0'/1/" + idx,
        pub: BTC.pubCompressed(BTC.pointFromD(node.d))
      }
    };
  };

  const twoExternal = BTC.buildPsbt({
    inputs: [input],
    outputs: [
      { value: 40000n, script: external(7n) },
      { value: 50000n, script: external(8n) }
    ]
  });
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    /* A recusa é na análise: o arquivo nem é carregado. */
    await assert.rejects(core.analyzePsbt(twoExternal.bytes, h),
      /sem origem BIP32|mais de um destino externo/);
    await assert.rejects(core.signPsbt(twoExternal.bytes, h, new Uint8Array(32)),
      /sem origem BIP32|mais de um destino externo/);
  }

  /* PSBT já assinado é só exibição: os problemas viram aviso, não recusa. */
  const signedTwo = BTC.buildPsbt({
    inputs: [input],
    outputs: [
      { value: 40000n, script: external(7n) },
      { value: 50000n, script: external(8n) }
    ]
  });
  signedTwo.psbt.inputs[0].push({
    key: BTC.concatBytes(new Uint8Array([0x02]), pub),
    value: new Uint8Array([1])
  });
  const signedTwoBytes = BTC.writePsbt(signedTwo.psbt);
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    const a = await core.analyzePsbt(signedTwoBytes, h);
    assert.equal(a.alreadySigned, true, 'a assinatura parcial já o torna só exibição');
    assert.ok(a.warnings.some(w => /sem origem BIP32|mais de um destino externo/.test(w)),
      'o problema estrutural aparece como aviso no PSBT assinado');
    await assert.rejects(core.signPsbt(signedTwoBytes, h, new Uint8Array(32)), /já (tem|está)/);
  }

  /* Taproot com script path: 0x14 e 0x15 têm chave com dado e são recusados. */
  const tapScript = BTC.buildPsbt({
    inputs: [input],
    outputs: [{ value: 90000n, script: external(7n) }]
  });
  tapScript.psbt.inputs[0].push({
    key: BTC.concatBytes(new Uint8Array([0x14]), new Uint8Array(64)),
    value: new Uint8Array(64)
  });
  const tapScriptBytes = BTC.writePsbt(tapScript.psbt);
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    await assert.rejects(core.analyzePsbt(tapScriptBytes, h), /script path|dados de script/);
  }

  /* OP_RETURN é script não padronizado: também recusado na análise. */
  const withData = BTC.buildPsbt({
    inputs: [input],
    outputs: [
      { value: 40000n, script: external(7n) },
      { value: 0n, script: new Uint8Array([0x6a, 0x01, 0x00]) }
    ]
  });
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    await assert.rejects(core.analyzePsbt(withData.bytes, h), /script não padronizado/);
  }

  /* Taxa zero e acima de 500 sat/vB: recusa na análise nas duas cópias. */
  const zeroFee = BTC.buildPsbt({
    inputs: [input],
    outputs: [
      { value: 80000n, script: external(7n) },
      await change(0)
    ]
  });
  const highFee = BTC.buildPsbt({
    inputs: [input],
    outputs: [{ value: 40000n, script: external(7n) }]
  });
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    await assert.rejects(core.analyzePsbt(zeroFee.bytes, h), /taxa zero/);
    await assert.rejects(core.analyzePsbt(highFee.bytes, h), /acima de 500/);
  }

  const twoChange = BTC.buildPsbt({
    inputs: [input],
    outputs: [
      { value: 30000n, script: external(7n) },
      await change(0),
      await change(1)
    ]
  });
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    const a = await core.analyzePsbt(twoChange.bytes, h);
    assert.deepEqual(a.outputs.map(o => o.own), ['externo', 'troco', 'troco']);
    assert.ok(!a.warnings.some(w => /mais de uma saída de troco/.test(w)),
      'mais de um troco verificado não gera aviso estrutural');
  }

  const noChange = BTC.buildPsbt({
    inputs: [input],
    outputs: [{ value: 90000n, script: external(7n) }]
  });
  for (const [core, h] of [[BTC, hd], [C, ehd]]) {
    const a = await core.analyzePsbt(noChange.bytes, h);
    assert.equal(a.outputs[0].own, 'externo');
    assert.ok(!a.warnings.some(w => /sem saída de troco|não tem saída de troco/.test(w)),
      'PSBT sem troco não gera aviso estrutural');
  }
  console.log('ok   estrutura das saídas igual nas duas cópias');
}

rmSync(dir, { recursive: true, force: true });
console.log('\ntestes de paridade do núcleo passaram');
