/* Montagem do PSBT de envio (v0, sem assinatura).

   O lado watch-only só tem chaves públicas/scripts derivados: escolhe UTXOs, calcula a taxa pela vsize
   estimada, deriva o troco e escreve o PSBT com a origem BIP32 de cada
   entrada. A chave privada nunca chega aqui; quem assina é o Cofre BTC,
   offline.

   A origem leva a impressão digital da CONTA, e não a da raiz: é o máximo
   que a xpub permite conhecer. O caminho continua completo (m/84'/0'/0'/0/i)
   e o assinante confere a chave e o script antes de usar, então a origem é
   uma dica de derivação, não uma prova de identidade. */
import BTC from './btc-core.js';

/* Abaixo disso a saída de troco vira pó e é mais barato somar à taxa. O
   valor é conservador: cobre p2pkh (546) e fica acima do pó de p2wpkh e
   p2tr, que é menor. */
export const DUST_SATS = 546;

/* Faixa aceita para a taxa, em sat/vB. O estimador responde em sat/kvB, então
   a taxa pode ter casas decimais; a conta é feita em sat/kvB inteiro e só o
   valor final da taxa vira satoshi inteiro (ver `feeSats`). Não há piso de
   relay: a taxa estimada é usada como veio, inclusive abaixo de 1 sat/vB. O
   mínimo é o menor valor que o sat/kvB representa (1 sat/kvB). */
export const FEE_RATE_MIN = 0.001;
export const FEE_RATE_MAX = 10000;

/* sat/vB (com casas, se vier do estimador) → sat/kvB inteiro, que é a unidade
   exata do dado. Recusa o que está fora da faixa ou não é número. */
export function feeRateKvb(rate) {
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
export function feeSats(kvb, vsize) {
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
export function selectCoins(utxos, amountSats, feeRate, recipientScript, changeScript) {
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
export function sendLimits({ utxos, address, feeRate, amountSats, changeScript, quoteRates }) {
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
export async function preparePsbt({
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
export async function prepareCpfpPsbt({
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
