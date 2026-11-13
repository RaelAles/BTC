/* Transmissão do PSBT assinado (fecha o ciclo do projeto 2).

   O chave-btc.html (projeto 1) assina offline e devolve um PSBT v0 com todas
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
import BTC from './btc-core.js';

/* Pó de saída: abaixo disso a saída não é padrão e o relay recusa. O valor
   cobre p2pkh (546) e fica acima do pó de p2wpkh e p2tr. */
const DUST_SATS = 546;

/* Um PSBT de várias entradas fica na casa de dezenas de KB em base64; o teto
   existe para uma colagem gigante não virar trabalho à toa no Worker. */
export const MAX_PSBT_TEXT = 400000;

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
export function inspectSignedPsbt({ psbtText, byScript, utxos }) {
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
      if (!mapFind(psbt.inputs[i], 0x07)) semFinal++;
    }
    if (psbt.inputs.length && semFinal === psbt.inputs.length) throw new Error('psbt não assinado');
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
  const warnings = [];
  if (!fee) warnings.push('taxa zero: a rede pode recusar a transação');
  if (fee > 0 && feeRate < 1) {
    warnings.push('taxa de ' + feeRate.toFixed(2) + ' sat/vB, abaixo do piso de relay: a transação pode ser recusada');
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
export function previewSignedPsbt({ scanner, psbtText }) {
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
export async function broadcastSignedPsbt({ client, scanner, psbtText }) {
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
