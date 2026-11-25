/* Conjunto de endereços já derivados pelo cliente.

   O Worker não recebe mais a xpub: o navegador deriva os endereços, manda
   somente script/chave pública/caminho e o servidor consulta o Electrum por
   scripthash. A validação aqui é de forma e de tamanho, não de derivação:
   provar que um endereço veio da xpub exigiria a própria xpub, que é
   exatamente o que este fluxo evita. Quem monta o PSBT e transmite é o
   mesmo dono da carteira, então uma linha inventada só afeta quem a enviou;
   os limites de quantidade e de formato evitam abuso de CPU/memória. */

export const WATCH_GAP = 50;
export const MAX_WATCH_ROWS = 20000;

const TYPES = ['bip86', 'bip84', 'bip49', 'bip44'];
const TYPE_PURPOSE = { bip86: 86, bip84: 84, bip49: 49, bip44: 44 };
const TYPE_KIND = { bip86: 'p2tr', bip84: 'p2wpkh', bip49: 'p2sh-p2wpkh', bip44: 'p2pkh' };
const HEX = /^[0-9a-f]+$/;

function text(value) { return value == null ? '' : String(value).trim(); }

function fail(message) { throw new Error(message); }

/* Normaliza uma lista de linhas derivadas. Duplicatas são descartadas (o
   cliente pode reenviar a mesma cauda ao continuar a varredura). */
export function normalizeWatchRows(input, label = 'watch') {
  if (!Array.isArray(input)) fail(label + ' inválido');
  if (input.length > MAX_WATCH_ROWS) fail(label + ' grande demais');
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') fail(label + ' inválido');
    const accountType = text(raw.account_type);
    if (!TYPES.includes(accountType)) fail('tipo de conta inválido em ' + label);
    const chain = Number(raw.chain);
    if (chain !== 0 && chain !== 1) fail('cadeia inválida em ' + label);
    const idx = Number(raw.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= 0x80000000) fail('índice inválido em ' + label);
    const script = text(raw.script).toLowerCase();
    if (script.length < 2 || script.length > 200 || script.length % 2 || !HEX.test(script)) {
      fail('script inválido em ' + label);
    }
    const pub = text(raw.pub).toLowerCase();
    if (!/^(02|03)[0-9a-f]{64}$/.test(pub)) fail('chave pública inválida em ' + label);
    const address = text(raw.address);
    if (!address || address.length > 90) fail('endereço inválido em ' + label);
    const path = text(raw.path);
    const expectedPath = "m/" + TYPE_PURPOSE[accountType] + "'/0'/0'/" + chain + "/" + idx;
    if (path !== expectedPath) fail('caminho de derivação inválido em ' + label);
    const key = accountType + ':' + chain + ':' + idx;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      account_type: accountType,
      chain,
      idx,
      address,
      path,
      script,
      pub,
      kind: TYPE_KIND[accountType]
    });
  }
  if (!out.length) fail(label + ' vazio');
  return out;
}

/* `watch` substitui o conjunto da sessão; `watch_add` acrescenta a cauda
   derivada depois que o servidor informou quantos endereços faltam. */
export function normalizeWatchRequest(body) {
  const hasWatch = Object.prototype.hasOwnProperty.call(body, 'watch');
  const hasAdd = Object.prototype.hasOwnProperty.call(body, 'watch_add');
  if (!hasWatch && !hasAdd) return null;
  if (hasWatch && hasAdd) fail('envie watch ou watch_add, não os dois');
  const walletId = text(body.wallet_id).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletId)) fail('wallet_id inválido');
  const fingerprint = text(body.fingerprint).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) fail('impressão digital da conta inválida');
  const versionType = text(body.version_type) || 'xpub';
  if (!['xpub', 'bip84', 'bip49'].includes(versionType)) fail('tipo de chave inválido');
  return {
    walletId,
    fingerprint,
    versionType,
    watch: hasWatch ? normalizeWatchRows(body.watch, 'watch') : null,
    watchAdd: hasAdd ? normalizeWatchRows(body.watch_add, 'watch_add') : null
  };
}

export { TYPES as WATCH_TYPES };
