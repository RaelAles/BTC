/* Teste da transmissão: o PSBT assinado no núcleo do Cofre BTC volta para o
   Monitor BTC, é conferido contra a carteira (entradas/saídas/taxa) e só então
   publicado pelo Electrum. Sem rede: servidor Electrum falso, que aceita
   `blockchain.transaction.broadcast` e guarda o hex recebido.

   node test/broadcast.test.mjs */
import assert from 'node:assert/strict';
import worker from './legacy/worker.js';
import { WalletWatcher } from './legacy/watcher.js';
import { deriveAddress, parseXpub } from '../src/derivation.js';
import { scripthash, setConnectOverride } from '../src/electrum.js';
import { inspectSignedPsbt } from '../src/broadcast.js';
import BTC from '../src/btc-core.js';
import { startFakeElectrum, nodeConnect } from './fake-electrum.mjs';
import { makeTx } from './tx-fixture.mjs';

setConnectOverride(nodeConnect);

const bits = '1' + '0'.repeat(255);
const hd = await BTC.deriveHD(bits);
const otherHd = await BTC.deriveHD('10'.repeat(128));
const account = parseXpub(hd.accounts.bip84.xpub);
const otherAccount = parseXpub(otherHd.accounts.bip84.xpub);

function post(path, body, env) {
  return worker.fetch(new Request('https://x' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
}
async function postJson(path, body, env) {
  const r = await post(path, body, env);
  return { status: r.status, j: await r.json() };
}

/* little-endian de 8 bytes, para remontar um witness_utxo adulterado */
function le64(n) {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function mapFind(map, type) {
  return map.find(e => e.key.length === 1 && e.key[0] === type) || null;
}
function signedText(signed) { return signed.psbtBase64; }

/* Monta uma carteira com uma saída, um PSBT de envio e a assinatura no
   próprio btc-core (o mesmo caminho do Cofre BTC). */
async function fixture({ acct = account, hd: signer = hd, xpub = hd.accounts.bip84.xpub,
  value = 100000, destination, feeRate = 3 } = {}) {
  const a = await deriveAddress('bip84', acct, 0, 0);
  const tx = makeTx([{ txid: 'a0'.repeat(32), vout: 0 }], [{ value, script: a.script }]);
  const fake = await startFakeElectrum({
    histories: { [scripthash(a.script)]: [{ height: 800000, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const dest = destination || BTC.derive('10' + '0'.repeat(254)).addresses.p2wpkh;
  const r = await postJson('/api/psbt', {
    xpub, address: dest, amount_sats: value - 20000, fee_rate: feeRate
  }, env);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const signed = await BTC.signPsbt(BTC.psbtParseInput(r.j.psbt), signer, new Uint8Array(32));
  return { fake, env, addr: a, dest, prepared: r.j, signed };
}

/* ---------------- 1. ciclo completo: conferir e transmitir ---------------- */
{
  const f = await fixture();
  const xpub = hd.accounts.bip84.xpub;

  /* a transação final sai do PSBT (campos finais) e volta igual ao hex que o
     assinante escreveu — a extração não depende dos campos de assinatura */
  const final = BTC.psbtFinalTx(BTC.parsePsbt(BTC.psbtParseInput(f.signed.psbtBase64)));
  assert.equal(final.txid, f.signed.txid);
  assert.equal(final.hex, f.signed.txHex);
  assert.equal(final.vsize, f.signed.vsize);

  /* importar = preview: confere e devolve o resumo, sem transmitir */
  const preview = await postJson('/api/broadcast', {
    xpub, psbt: signedText(f.signed), preview: true
  }, f.env);
  assert.equal(preview.status, 200, JSON.stringify(preview.j));
  assert.equal(preview.j.preview, true);
  assert.equal(preview.j.broadcast, undefined);
  assert.equal(preview.j.txid, f.signed.txid);
  assert.equal(preview.j.hex, undefined, 'o hex não vai para o navegador');
  assert.equal(preview.j.fee_sats, Number(f.signed.fee));
  assert.equal(preview.j.vsize, f.signed.vsize);
  assert.equal(preview.j.locktime, 0, 'a transação não tem trava');
  assert.equal(preview.j.rbf, true, 'a transação sinaliza RBF');
  assert.equal(preview.j.inputs.length, 1);
  assert.equal(preview.j.inputs[0].address, f.addr.address);
  assert.equal(preview.j.inputs[0].path, "m/84'/0'/0'/0/0");
  assert.equal(preview.j.outputs.length, 2);
  assert.equal(preview.j.outputs[0].address, f.dest, 'a saída externa é o destino');
  assert.equal(preview.j.outputs[0].own, 'externo');
  assert.equal(preview.j.outputs[1].own, 'troco', 'a carteira reconhece o troco');
  assert.equal(preview.j.outputs[1].address, f.prepared.change.address);
  assert.equal(f.fake.broadcasts.length, 0, 'preview não transmite');

  /* transmitir = a mesma conferência + broadcast, e só uma vez */
  const sent = await postJson('/api/broadcast', {
    xpub, psbt: signedText(f.signed)
  }, f.env);
  assert.equal(sent.status, 200, JSON.stringify(sent.j));
  assert.equal(sent.j.broadcast, true);
  assert.equal(sent.j.txid, f.signed.txid);
  assert.equal(sent.j.server_txid, f.signed.txid);
  assert.equal(sent.j.locktime, 0);
  assert.equal(sent.j.rbf, true);
  assert.equal(sent.j.hex, undefined);
  assert.equal(f.fake.broadcasts.length, 1);
  assert.equal(f.fake.broadcasts[0].hex, f.signed.txHex);
  assert.equal(f.fake.broadcasts[0].txid, f.signed.txid);
  assert.equal(f.fake.count('blockchain.transaction.broadcast'), 1);

  /* sessão do Durable Object despejada (409): o Worker refaz a varredura
     avulsa e confere do mesmo jeito, sem pedir nada novo à tela */
  const expired = Object.assign({}, f.env, {
    WATCH: {
      newUniqueId: () => 'd'.repeat(64),
      idFromString: s => s,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ error: 'sessão expirada' }), {
          status: 409, headers: { 'Content-Type': 'application/json' }
        })
      })
    }
  });
  const fallback = await postJson('/api/broadcast', {
    xpub, session: 'd'.repeat(64), psbt: signedText(f.signed), preview: true
  }, expired);
  assert.equal(fallback.status, 200, JSON.stringify(fallback.j));
  assert.equal(fallback.j.txid, f.signed.txid);
  assert.equal(f.fake.count('blockchain.transaction.broadcast'), 1,
    'o preview não transmite nem no caminho avulso');
  console.log('ok   psbt assinado conferido e transmitido (hex igual ao do assinante)');
  await f.fake.close();
}

/* ---------------- 1b. PSBT finalizado só com final_scriptWitness ---------------- */
{
  /* Assinador de terceiro finaliza segwit só com o witness (0x08), sem o
     final_scriptSig (0x07): é PSBT válido pelo BIP174 e o Worker tem de
     aceitar, como o próprio Cofre BTC faz. */
  const f = await fixture();
  const xpub = hd.accounts.bip84.xpub;
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(f.signed.psbtBase64));
  psbt.inputs[0] = psbt.inputs[0].filter(e => !(e.key.length === 1 && e.key[0] === 0x07));
  assert.equal(mapFind(psbt.inputs[0], 0x07), null, 'sem final_scriptSig');
  assert.ok(mapFind(psbt.inputs[0], 0x08), 'com final_scriptWitness');
  const witnessOnly = BTC.b64encode(BTC.writePsbt(psbt));

  const final = BTC.psbtFinalTx(BTC.parsePsbt(BTC.psbtParseInput(witnessOnly)));
  assert.equal(final.txid, f.signed.txid);
  assert.equal(final.hex, f.signed.txHex);

  const preview = await postJson('/api/broadcast', {
    xpub, psbt: witnessOnly, preview: true
  }, f.env);
  assert.equal(preview.status, 200, JSON.stringify(preview.j));
  assert.equal(preview.j.txid, f.signed.txid);
  console.log('ok   PSBT finalizado só com final_scriptWitness é aceito');
  await f.fake.close();
}

/* ---------------- 1c. aviso de taxa segue o piso de relay padrão ---------------- */
{
  const xpub = hd.accounts.bip84.xpub;

  /* 0,12 sat/vB está acima do piso padrão (0,1 sat/vB): sem aviso de relay */
  const low = await fixture({ feeRate: 0.12 });
  const aboveMin = await postJson('/api/broadcast', {
    xpub, psbt: signedText(low.signed), preview: true
  }, low.env);
  assert.equal(aboveMin.status, 200, JSON.stringify(aboveMin.j));
  assert.ok(!aboveMin.j.warnings.some(w => /piso de relay/.test(w)),
    '0,12 sat/vB não é avisado: o piso padrão é 0,1');
  await low.fake.close();

  /* 0,05 sat/vB fica abaixo do piso padrão: avisa */
  const tiny = await fixture({ feeRate: 0.05 });
  const belowMin = await postJson('/api/broadcast', {
    xpub, psbt: signedText(tiny.signed), preview: true
  }, tiny.env);
  assert.equal(belowMin.status, 200, JSON.stringify(belowMin.j));
  assert.ok(belowMin.j.warnings.some(w => /piso de relay padrão \(0,1 sat\/vB\)/.test(w)),
    JSON.stringify(belowMin.j.warnings));
  await tiny.fake.close();
  console.log('ok   aviso de taxa segue o piso de relay padrão (0,1 sat/vB)');
}

/* ---------------- 2. recusas antes de qualquer transmissão ---------------- */
{
  const f = await fixture();
  const xpub = hd.accounts.bip84.xpub;

  /* PSBT sem assinatura: a recusa é direta, sem o nome do campo do BIP174 */
  const unsigned = await postJson('/api/broadcast', {
    xpub, psbt: f.prepared.psbt
  }, f.env);
  assert.equal(unsigned.status, 400);
  assert.match(unsigned.j.error, /o psbt não está assinado/);

  /* arquivo que não é PSBT */
  const garbage = await postJson('/api/broadcast', {
    xpub, psbt: 'isto-nao-e-um-psbt'
  }, f.env);
  assert.equal(garbage.status, 400);
  assert.match(garbage.j.error, /psbt ilegível|base64/);

  /* sem xpub não há contra o que conferir */
  const noXpub = await postJson('/api/broadcast', {
    psbt: signedText(f.signed)
  }, f.env);
  assert.equal(noXpub.status, 400);
  assert.match(noXpub.j.error, /informe a xpub/);

  /* PSBT de OUTRA carteira: a entrada não é um endereço desta */
  const other = await fixture({
    acct: otherAccount, hd: otherHd, xpub: otherHd.accounts.bip84.xpub
  });
  const foreign = await postJson('/api/broadcast', {
    xpub, psbt: signedText(other.signed)
  }, f.env);
  assert.equal(foreign.status, 400);
  assert.match(foreign.j.error, /não pertence a esta carteira/);
  assert.equal(f.fake.broadcasts.length, 0, 'nada foi transmitido nas recusas');

  /* witness_utxo adulterado: o valor declarado não bate com a carteira.
     O non_witness_utxo sai para a conferência interna do PSBT não pegar
     antes — aqui o que se testa é a comparação com o UTXO da carteira. */
  const psbt = BTC.parsePsbt(BTC.psbtParseInput(f.signed.psbtBase64));
  psbt.inputs[0] = psbt.inputs[0].filter(e => e.key[0] !== 0x00);
  const wu = mapFind(psbt.inputs[0], 0x01);
  const prev = BTC.readTxOut(wu.value, 0);
  wu.value = BTC.concatBytes(le64(prev.value + 1n), BTC.writeVarInt(prev.script.length), prev.script);
  const tampered = await postJson('/api/broadcast', {
    xpub, psbt: BTC.b64encode(BTC.writePsbt(psbt))
  }, f.env);
  assert.equal(tampered.status, 400);
  assert.match(tampered.j.error, /declara .* sats, mas a carteira tem/);

  /* o servidor pode recusar a transação: a mensagem dele chega à tela */
  f.fake.setBroadcastError('txn-mempool-conflict');
  const refused = await postJson('/api/broadcast', {
    xpub, psbt: signedText(f.signed)
  }, f.env);
  assert.equal(refused.status, 400);
  assert.match(refused.j.error, /o servidor recusou a transação: .*txn-mempool-conflict/);
  f.fake.setBroadcastError('');
  console.log('ok   recusa psbt sem assinatura, de outra carteira, com valor adulterado e recusa do servidor');
  await f.fake.close();
  await other.fake.close();
}

/* ---------------- 3. aviso de UTXO não conhecido não impede ---------------- */
{
  /* Entrada de um endereço da carteira que o servidor não vê como não gasta
     (depósito novo, sessão atrasada): é aviso, não recusa — quem decide é a
     rede, e a assinatura já foi feita. */
  const a = await deriveAddress('bip84', account, 0, 0);
  const tx = makeTx([{ txid: 'b0'.repeat(32), vout: 0 }], [{ value: 40000, script: a.script }]);
  const fake = await startFakeElectrum({});
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const built = BTC.buildPsbt({
    inputs: [{
      txid: tx.txid, vout: 0, value: 40000, script: a.script,
      kind: 'p2wpkh', pub: a.pub, path: "m/84'/0'/0'/0/0",
      fingerprint: BTC.bytesToHex(BTC.hash160(account.pub)).slice(0, 8),
      rawTx: BTC.hexToBytes(tx.raw)
    }],
    outputs: [{ value: 39000, script: BTC.scriptFromAddress(BTC.derive('0'.repeat(255) + '1').addresses.p2wpkh) }]
  });
  const signed = await BTC.signPsbt(built.bytes, hd, new Uint8Array(32));
  /* o scanner conhece o script (a linha é derivada), mas não a saída */
  const fakeScanner = {
    byScript: new Map([[BTC.bytesToHex(a.script), {
      address: a.address, path: "m/84'/0'/0'/0/0", account_type: 'bip84', chain: 0, idx: 0
    }]]),
    utxos: []
  };
  const summary = inspectSignedPsbt({
    psbtText: signed.psbtBase64,
    byScript: fakeScanner.byScript,
    utxos: fakeScanner.utxos
  });
  assert.ok(summary.warnings.some(w => /não está entre as saídas não gastas/.test(w)),
    JSON.stringify(summary.warnings));
  const sent = await postJson('/api/broadcast', {
    xpub: hd.accounts.bip84.xpub, psbt: signed.psbtBase64
  }, env);
  assert.equal(sent.status, 200, JSON.stringify(sent.j));
  assert.ok(sent.j.warnings.some(w => /não está entre as saídas não gastas/.test(w)));
  assert.equal(fake.broadcasts.length, 1);
  console.log('ok   depósito fora do retrato da sessão vira aviso, não recusa');
  await fake.close();
}

/* ---------------- 4. sessão do Durable Object transmite pela conexão viva ---------------- */
{
  const a = await deriveAddress('bip84', account, 0, 0);
  const tx = makeTx([{ txid: 'c0'.repeat(32), vout: 0 }], [{ value: 60000, script: a.script }]);
  const fake = await startFakeElectrum({
    histories: { [scripthash(a.script)]: [{ height: 800100, tx_hash: tx.txid }] },
    txs: { [tx.txid]: tx.raw }
  });
  const env = { ELECTRUM_SERVERS: '127.0.0.1:' + fake.port + ':tcp', ELECTRUM_TIMEOUT_MS: '5000' };
  const watcher = new WalletWatcher({
    id: { name: 'sessao-broadcast' },
    storage: new Proxy({}, { get(_, key) { throw new Error('storage: ' + String(key)); } })
  }, env);
  env.WATCH = {
    newUniqueId: () => 'e'.repeat(64),
    idFromString: s => s,
    get: () => ({
      fetch: (input, init) => watcher.fetch(typeof input === 'string' ? new Request(input, init) : input)
    })
  };

  const wallet = await postJson('/api/wallet', { xpub: hd.accounts.bip84.xpub }, env);
  assert.equal(wallet.status, 200, JSON.stringify(wallet.j));
  const session = wallet.j.session;

  const dest = BTC.derive('1' + '0'.repeat(254) + '1').addresses.p2wpkh;
  const prepared = await postJson('/api/psbt', {
    xpub: hd.accounts.bip84.xpub, session, address: dest, amount_sats: 30000, fee_rate: 2
  }, env);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.j));
  const signed = await BTC.signPsbt(BTC.psbtParseInput(prepared.j.psbt), hd, new Uint8Array(32));

  /* preview pela sessão: reaproveita a conexão e os UTXOs do DO */
  const preview = await postJson('/api/broadcast', {
    xpub: hd.accounts.bip84.xpub, session, psbt: signed.psbtBase64, preview: true
  }, env);
  assert.equal(preview.status, 200, JSON.stringify(preview.j));
  assert.equal(preview.j.preview, true);
  assert.equal(preview.j.txid, signed.txid);
  assert.equal(preview.j.locktime, 0);
  assert.equal(preview.j.rbf, true);
  assert.equal(preview.j.outputs[0].address, dest);
  assert.equal(fake.broadcasts.length, 0);

  const sent = await postJson('/api/broadcast', {
    xpub: hd.accounts.bip84.xpub, session, psbt: signed.psbtBase64
  }, env);
  assert.equal(sent.status, 200, JSON.stringify(sent.j));
  assert.equal(sent.j.broadcast, true);
  assert.equal(sent.j.txid, signed.txid);
  assert.equal(fake.broadcasts.length, 1);
  assert.equal(fake.broadcasts[0].hex, signed.txHex);
  console.log('ok   sessão do DO confere e transmite pela conexão já aberta');
  await watcher.closeClient();
  await fake.close();
}

console.log('\ntestes de transmissão passaram');
