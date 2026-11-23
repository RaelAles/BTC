/* Telas, i18n e sincronização do CSS embutido do Cofre: o arquivo é
   standalone, então as travas são lidas do próprio HTML, sem browser.

   node test/cofre-ui.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_SOURCE,
  cssHash,
  extractCssBlock,
  normalizeCss,
  replaceCssBlock
} from '../scripts/sync-cofre-css.mjs';

const html = fs.readFileSync(new URL('../public/cofre-btc.html', import.meta.url), 'utf8');

/* ---------------- 1. I18N_ROWS tem as 9 colunas e chave pt única ---------------- */
const listaDeStrings = (nome) => {
  const match = html.match(new RegExp('var ' + nome + ' = \\[([^\\]]*)\\]'));
  assert.ok(match, 'var ' + nome + ' está presente no Cofre');
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
};
const locales = listaDeStrings('LOCALES');
const rowsSource = html.match(/var I18N_ROWS = \[([\s\S]*?)\n  \];/);
assert.ok(rowsSource, 'I18N_ROWS está presente no Cofre');
const rows = JSON.parse('[' + rowsSource[1].trim().replace(/,\s*$/, '') + ']');
assert.ok(rows.length > 0, 'I18N_ROWS não está vazio');
for (const [i, row] of rows.entries()) {
  assert.equal(row.length, locales.length,
    'I18N_ROWS linha ' + (i + 1) + ' tem ' + locales.length + ' colunas');
  assert.equal(typeof row[0], 'string', 'I18N_ROWS linha ' + (i + 1) + ' tem chave pt');
}
const keys = rows.map(row => row[0]);
assert.equal(new Set(keys).size, keys.length, 'I18N_ROWS não repete chave em português');
console.log('ok   I18N_ROWS: ' + rows.length + ' linhas com ' + locales.length + ' colunas e chave única');

/* ---------------- 2. toda chave literal de t('…') está em I18N_ROWS ---------------- */
const usadas = new Set();
for (const match of html.matchAll(/(?:^|[^\w$])t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
  usadas.add(match[1]);
}
const faltando = [...usadas].filter(key => !keys.includes(key));
assert.deepEqual(faltando, [], 'chaves de t() sem linha em I18N_ROWS');
console.log('ok   ' + usadas.size + ' chaves literais de t() existem em I18N_ROWS');

/* ---------------- 2b. recado da rodada tem linha em I18N_ROWS e a nota da frase fica ligada aos campos ---------------- */
const chavesDeRecado = [
  'último bit desfeito; restam {n} de 256.'
];
for (const key of chavesDeRecado) {
  assert.ok(keys.includes(key), 'recado sem linha em I18N_ROWS: ' + key);
}
assert.match(html, /id="mnemonic-note" role="status"/, '#mnemonic-note é região viva reservada no bloco da frase');
assert.match(html, /aria-describedby="mnemonic-note"/, '#passphrase aponta para #mnemonic-note');
assert.match(html, /input\.setAttribute\('aria-describedby', 'mnemonic-note'\)/,
  'cada palavra da frase aponta para #mnemonic-note');
console.log('ok   recado da rodada tem linha e a nota reservada da frase está ligada aos campos');

/* ---------------- 3. menu e seções de tela batem com SCREENS ---------------- */
const screens = listaDeStrings('SCREENS');
const menuScreens = [...html.matchAll(/data-screen="([^"]+)"/g)].map(match => match[1]);
assert.ok(menuScreens.length > 0, 'o menu declara data-screen');
for (const name of menuScreens) {
  assert.ok(screens.includes(name), 'data-screen="' + name + '" existe em SCREENS');
}
for (const name of screens) {
  assert.match(html, new RegExp('<section\\b[^>]*id="screen-' + name + '"[^>]*aria-labelledby="head-' + name + '"'),
    'seção #screen-' + name + ' aponta para #head-' + name);
  assert.match(html, new RegExp('<h2 id="head-' + name + '"'),
    'a seção #screen-' + name + ' tem <h2 id="head-' + name + '">');
}
console.log('ok   menu e seções: ' + screens.join(', '));

/* ---------------- 4. nenhum id duplicado nem referência órfã ---------------- */
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const duplicados = ids.filter((id, i) => ids.indexOf(id) !== i);
assert.deepEqual([...new Set(duplicados)], [], 'ids duplicados no Cofre');
const referencias = new Set();
for (const match of html.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) referencias.add(match[1]);
for (const match of html.matchAll(/getElementById\('([^']+)'\)/g)) referencias.add(match[1]);
const orfas = [...referencias].filter(id => !ids.includes(id));
assert.deepEqual(orfas, [], 'referências a ids que não existem no Cofre');
console.log('ok   ' + ids.length + ' ids únicos e ' + referencias.size + ' referências sem órfã');

/* ---------------- 5. bloco copiado do estilo.css está sincronizado ---------------- */
const bloco = extractCssBlock(html);
assert.equal(bloco.hash, cssHash(bloco.css),
  'sha256 do marcador @copia-estilo.css confere com o bloco embutido');
assert.equal(replaceCssBlock(html, bloco.css), html,
  'o script de sincronização é idempotente sobre o bloco embutido');
if (fs.existsSync(DEFAULT_SOURCE)) {
  const fonte = normalizeCss(fs.readFileSync(DEFAULT_SOURCE, 'utf8'));
  assert.equal(bloco.css, fonte,
    'o bloco @copia-estilo.css difere de ' + DEFAULT_SOURCE + '; rode npm run sync:cofre-css');
  assert.equal(bloco.hash, cssHash(fonte), 'o sha256 do marcador confere com o estilo.css');
  assert.equal(replaceCssBlock(html, fonte), html, 'o script reproduz o bloco atual');
  console.log('ok   bloco @copia-estilo.css igual ao estilo.css da skill');
} else {
  console.log('ok   bloco @copia-estilo.css com sha256 em dia (estilo.css da skill não encontrado)');
}

console.log('\ntestes de interface do Cofre passaram');
