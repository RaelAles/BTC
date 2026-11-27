/* A tabela I18N_ROWS do Monitor é mantida à mão; o Cofre já tinha esta
   trava. Aqui cada linha precisa ter uma coluna por idioma e chave pt única,
   e as chaves usadas pelos recados de CPFP/RBF precisam existir.

   node test/app-i18n.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const localesMatch = app.match(/var LOCALES = \[([^\]]*)\]/);
assert.ok(localesMatch, 'LOCALES está presente em public/app.js');
const locales = [...localesMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

const rowsMatch = app.match(/var I18N_ROWS = \[([\s\S]*?)\n  \];/);
assert.ok(rowsMatch, 'I18N_ROWS está presente em public/app.js');
const rows = JSON.parse('[' + rowsMatch[1].trim().replace(/,\s*$/, '') + ']');
assert.ok(rows.length > 0, 'I18N_ROWS não está vazio');

for (const [i, row] of rows.entries()) {
  assert.equal(row.length, locales.length,
    'I18N_ROWS linha ' + (i + 1) + ' tem ' + locales.length + ' colunas');
  assert.equal(typeof row[0], 'string', 'I18N_ROWS linha ' + (i + 1) + ' tem chave pt');
}
const keys = rows.map(row => row[0]);
assert.equal(new Set(keys).size, keys.length, 'I18N_ROWS não repete chave em português');

/* As mensagens novas do RBF: se uma linha faltar ou mudar de texto, o recado
   cai no português em qualquer idioma e o teste avisa. */
for (const key of [
  'a transação já paga a taxa alvo; não há o que substituir',
  'a transação tem mais de um destino externo; não é possível montar a substituição',
  'o troco não cobre a taxa extra da substituição: faltam {remaining} sats para {target} sats a {rate} sat/vB',
  'substituir (sem sinal BIP125; depende de full RBF)',
  'substituição baixada: taxa {old} → {new} sat/vB; {extra} sats saíram do troco'
]) {
  assert.ok(keys.includes(key), 'recado de RBF sem linha em I18N_ROWS: ' + key);
}

/* A data do "sobre" aparece em dois lugares: o <time> estático de
   public/index.html e a primeira coluna da linha "Última atualização" de
   I18N_ROWS. As duas precisam dizer o mesmo dia. */
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dataDoIndice = index.match(/<time datetime="([^"]+)">/);
assert.ok(dataDoIndice, 'public/index.html tem <time datetime> no sobre');
const linhaDaData = rows.find(row => row[0].includes('Última atualização:'));
assert.ok(linhaDaData, 'I18N_ROWS tem a linha da última atualização');
const dataDaTabela = linhaDaData[0].match(/<time datetime="([^"]+)">/);
assert.ok(dataDaTabela, 'a linha pt da última atualização tem <time datetime>');
assert.equal(dataDaTabela[1], dataDoIndice[1],
  'a data do sobre de index.html confere com a primeira coluna de I18N_ROWS');

console.log('ok   I18N_ROWS do Monitor: ' + rows.length + ' linhas com ' +
  locales.length + ' colunas e chave única');
