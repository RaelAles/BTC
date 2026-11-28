/* Telas, i18n e sincronização do CSS embutido do Cofre: o arquivo é
   standalone, então as travas são lidas do próprio HTML, sem browser.

   node test/cofre-ui.test.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { embeddedCore } from '../scripts/sync-cofre-core.mjs';
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

/* ---------------- 2b. recado da rodada tem linha em I18N_ROWS e a nota da frase não volta ---------------- */
const chavesDeRecado = [
  'último bit desfeito; restam {n} de 256.',
  '256 bits registrados; escolha o idioma da frase.'
];
for (const key of chavesDeRecado) {
  assert.ok(keys.includes(key), 'recado sem linha em I18N_ROWS: ' + key);
}
/* A região viva da frase foi removida junto com a legenda que ela mostrava:
   nenhuma legenda é escrita nela, nem para palavra recusada nem para frase
   que não fecha a checagem, e nenhum campo aponta para ela. */
assert.doesNotMatch(html, /mnemonic-note/, '#mnemonic-note não volta ao bloco da frase');
assert.doesNotMatch(html, /function setMnemonicNote\b/, 'a região viva da frase não recebe legenda');
assert.doesNotMatch(html, /'[^'\n]*não fecha a checagem do BIP39[^'\n]*'/, 'a legenda da checagem foi removida');
console.log('ok   recado da rodada tem linha e a nota reservada da frase não existe mais');

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

/* ---------------- 5b. as três faces do Cofre são as mesmas de fontes.css ---------------- */
/* O Cofre é standalone e mantém cópia própria das fontes embutidas: sem
   esta trava, um recorte novo em fontes.css não chega ao arquivo publicado. */
const facesDe = (texto) => [...texto.matchAll(/^  src: url\(data:font\/woff2;base64,([^\n]+)\) format\("woff2"\);$/gm)]
  .map(match => match[1]);
const facesCofre = facesDe(html);
const facesFontes = facesDe(fs.readFileSync(new URL('../public/fontes.css', import.meta.url), 'utf8'));
assert.equal(facesCofre.length, 3, 'o Cofre embute as três faces');
assert.deepEqual(facesCofre, facesFontes,
  'as três faces do Cofre são as mesmas de public/fontes.css');
console.log('ok   as três faces do Cofre batem com public/fontes.css');

/* ---------------- 6. o idioma da frase: controles, listas e detecção batem ---------------- */
const langCodes = listaDeStrings('MNEMONIC_LANG_CODES');
assert.equal(langCodes[0], 'english', 'o inglês continua sendo o idioma padrão');
const controles = [...new Set([...html.matchAll(/data-mnemonic-lang="([^"]+)"/g)].map(m => m[1]))];
assert.deepEqual([...controles].sort(), [...langCodes].sort(),
  'os controles de idioma do painel da rodada cobrem os dez idiomas');
/* As listas do núcleo: `english` aponta para BIP39_WORDS, as outras nove
   trazem a lista no próprio mapa. Toda chave de idioma precisa da sua. */
const listas = html.match(/var BIP39_LISTS = \{([\s\S]*?)\n  \};/);
assert.ok(listas, 'BIP39_LISTS está presente no Cofre');
const listKeys = [...listas[1].matchAll(/^ {4}(\w+):/gm)].map(m => m[1]);
assert.deepEqual([...listKeys].sort(), [...langCodes].sort(),
  'cada idioma tem a sua lista em BIP39_LISTS');
/* A tela "chave" não tem mais seletor: a lista é deduzida das palavras
   digitadas. O teste guarda a remoção e as funções que fazem a dedução. */
const secaoChave = html.slice(html.indexOf('id="screen-chave"'), html.indexOf('id="screen-gerar"'));
assert.doesNotMatch(secaoChave, /id="mnemonic-lang"/,
  'a tela "chave" não tem o seletor de idioma da frase');
assert.doesNotMatch(secaoChave, /class="field-row mnemonic-lang"/,
  'a tela "chave" não tem a linha "idioma da frase"');
assert.doesNotMatch(secaoChave, /data-mnemonic-lang=/, 'a tela "chave" não tem controle de idioma');
assert.match(html, /function mnemonicLanguagesForWord\(/, 'a lista é deduzida das palavras preenchidas');
assert.match(html, /function mnemonicLangCandidates\(/, 'as palavras preenchidas filtram as listas compatíveis');
assert.doesNotMatch(html, /MNEMONIC_OPTION_LIMIT/, 'a sugestão não tem teto de opções');
/* Sair da posição apaga o que não virou palavra inteira, sem prender o foco:
   clique em outro campo, Tab e Enter encerram a posição do mesmo jeito. */
assert.doesNotMatch(html, /paintMnemonicReject/, 'a posição não fica marcada esperando ser terminada');
assert.doesNotMatch(html, /mnemonicPointerOut/, 'a saída não depende da origem do clique');
const inicioDoFocusout = html.indexOf("addEventListener('focusout'");
const saidaDaPosicao = html.slice(inicioDoFocusout,
  html.indexOf("addEventListener('keydown'", inicioDoFocusout));
assert.match(saidaDaPosicao, /commitMnemonicWord\(input\)/,
  'o focusout encerra a posição e apaga o que não é palavra');
assert.doesNotMatch(saidaDaPosicao, /acceptMnemonicText\(input\)/,
  'o focusout não reverte o campo antes de encerrar a posição');
assert.doesNotMatch(saidaDaPosicao, /input\.focus\(\)/, 'a saída não devolve o foco ao campo');
const inicioDoTeclado = html.indexOf("addEventListener('keydown'", inicioDoFocusout);
const ramoDoTeclado = html.slice(inicioDoTeclado, html.indexOf('if (mnemonicOptions)', inicioDoTeclado));
assert.doesNotMatch(ramoDoTeclado, /ev\.key === 'Tab'/,
  'o Tab não tem ramo próprio: o focusout encerra a posição');
console.log('ok   idioma da frase: ' + langCodes.length + ' listas, detecção pela frase e sem seletor na tela "chave"');

/* ---------------- 7. comportamento da dedução do idioma, sem DOM ---------------- */
/* As funções da tela "chave" rodam sobre `mnemonicInputs`; aqui elas são
   extraídas do HTML e executadas com as listas reais do núcleo embutido, sem
   browser. Cobre ambiguidade, checagem decidindo a lista, frase mista e a
   grafia canônica da palavra ambígua. */
{
  const coreDir = fs.mkdtempSync(join(tmpdir(), 'cofre-infer-'));
  const coreFile = join(coreDir, 'core.cjs');
  fs.writeFileSync(coreFile, embeddedCore(html));
  const C = createRequire(import.meta.url)(coreFile);

  const fonteDaFuncao = (nome) => {
    const inicio = html.indexOf('function ' + nome + '(');
    assert.ok(inicio >= 0, 'função ' + nome + ' está no Cofre');
    let profundidade = 0;
    let abriu = false;
    for (let i = inicio; i < html.length; i += 1) {
      if (html[i] === '{') { profundidade += 1; abriu = true; }
      else if (html[i] === '}') {
        profundidade -= 1;
        if (abriu && profundidade === 0) return html.slice(inicio, i + 1);
      }
    }
    throw new Error('função ' + nome + ' sem fechamento');
  };

  const fonte = `
    var MNEMONIC_LANG_CODES = ${JSON.stringify(langCodes)};
    var BIT_COUNT = 256;
    var mnemonicLang = 'english';
    var mnemonicInputs = [];
    var mnemonicLangLists = {};
    function setWords(words) {
      mnemonicInputs = words.map(function (value) { return { value: value || '' }; });
    }
    function setLang(lang) { mnemonicLang = lang; }
    function fakeInput(value) { return { value: value, removeAttribute: function () {} }; }
    function setMnemonicValue(input, value) { input.value = value; }
    function runCommit(value, words, lang) {
      setWords(words || ['']);
      setLang(lang || 'english');
      var entrada = fakeInput(value);
      mnemonicInputs[0] = entrada;
      commitMnemonicWord(entrada);
      return entrada.value;
    }
    ${fonteDaFuncao('mnemonicNorm')}
    ${fonteDaFuncao('mnemonicFold')}
    ${fonteDaFuncao('mnemonicLangData')}
    ${fonteDaFuncao('setMnemonicLang')}
    ${fonteDaFuncao('mnemonicLanguagesForWord')}
    ${fonteDaFuncao('mnemonicLangCandidates')}
    ${fonteDaFuncao('mnemonicIsPrefix')}
    ${fonteDaFuncao('mnemonicMatchList')}
    ${fonteDaFuncao('mnemonicEntropyForLang')}
    ${fonteDaFuncao('mnemonicEntropy')}
    ${fonteDaFuncao('mnemonicWordReady')}
    ${fonteDaFuncao('commitMnemonicWord')}
    ${fonteDaFuncao('padDigits')}
  `;
  const contexto = vm.createContext({
    BTC: {
      bip39Words: (lang) => C.bip39Words(lang),
      bip39Mnemonic: (bits, lang) => C.bip39Mnemonic(bits, lang)
    }
  });
  vm.runInContext(fonte, contexto);
  const executar = (codigo) => vm.runInContext(codigo, contexto);
  const comoJson = (codigo) => JSON.parse(executar('JSON.stringify(' + codigo + ')'));

  executar("setWords(['abandon'])");
  assert.deepEqual(comoJson("mnemonicLanguagesForWord('abandon')"), ['english', 'french'],
    'abandon é ambígua entre inglês e francês');
  executar("setWords(['abaco'])");
  assert.deepEqual(comoJson("mnemonicLanguagesForWord('abaco')"), ['spanish', 'italian'],
    'abaco é ambígua entre espanhol e italiano');

  /* Frase válida em inglês cujas 24 palavras também existem na lista
     francesa: as duas listas ficam em jogo e a checagem escolhe a inglesa. */
  const fraseAmbigua = 'abandon amateur angle animal aspect badge bicycle bonus brave camera canal capable caution civil client concert correct coyote crucial cruel cycle danger depart digital'.split(' ');
  executar('setWords(' + JSON.stringify(fraseAmbigua) + ')');
  assert.deepEqual(comoJson('mnemonicLangCandidates()'), ['english', 'french'],
    'a frase inteira mantém as duas listas compatíveis');
  assert.equal(executar("mnemonicEntropyForLang('english').length"), 256,
    'a checagem fecha na lista inglesa');
  assert.equal(executar("mnemonicEntropyForLang('french')"), '',
    'a mesma sequência não fecha na lista francesa');
  assert.equal(executar('mnemonicEntropy().length'), 256,
    'a entropia sai da lista que fecha a checagem');

  /* A lista em vigor vem primeiro, sem reordenação local no commit: numa
     frase ambígua a checagem ainda decide, mas a preferência é a da frase. */
  executar("setLang('french')");
  assert.deepEqual(comoJson('mnemonicLangCandidates()'), ['french', 'english'],
    'a lista em vigor fica na frente das demais compatíveis');
  assert.equal(executar('mnemonicEntropy().length'), 256,
    'a checagem segue decidindo quando a frase fecha');
  assert.equal(executar('mnemonicLang'), 'english',
    'a lista que fecha a checagem assume a frase');

  const fraseMista = fraseAmbigua.slice();
  fraseMista[23] = 'abaco';
  executar('setWords(' + JSON.stringify(fraseMista) + ')');
  assert.equal(executar('mnemonicLangCandidates()'), null,
    'palavras de listas diferentes não têm lista em comum');
  assert.equal(executar('mnemonicEntropy()'), '', 'frase mista não gera entrada');

  /* A palavra ambígua volta para a grafia da lista em vigor: `area` em
     espanhol é `área`, e não a forma inglesa. */
  executar("setWords(['']); setLang('spanish'); var entrada = fakeInput('area'); mnemonicInputs[0] = entrada; commitMnemonicWord(entrada)");
  assert.equal(executar('mnemonicInputs[0].value'), 'área'.normalize('NFKD'),
    'a grafia canônica segue a lista em vigor');
  executar("setWords(['']); setLang('english'); entrada = fakeInput('area'); mnemonicInputs[0] = entrada; commitMnemonicWord(entrada)");
  assert.equal(executar('mnemonicInputs[0].value'), 'area',
    'a grafia canônica inglesa é preservada');

  /* O caminho destrutivo do focusout: depois de sair da posição o campo só
     guarda a palavra canônica ou fica vazio. */
  assert.equal(executar("runCommit('aban', [''])"), '',
    'o prefixo pela metade é apagado na saída');
  assert.equal(executar("runCommit('abandon', [''])"), 'abandon',
    'a palavra válida fica na forma canônica');
  assert.equal(executar("runCommit('', [''])"), '', 'o campo vazio continua vazio');
  assert.equal(executar("runCommit('   ', [''])"), '', 'o campo só com espaços fica vazio');
  assert.equal(executar("runCommit('zzz', [''])"), '',
    'o termo fora das listas é apagado');

  /* A prontidão do Enter usa as mesmas listas da recusa: prefixo e palavra
     sem lista comum com a frase não ficam prontos. */
  executar("setWords(['']); setLang('english'); entrada = fakeInput('aban'); mnemonicInputs[0] = entrada");
  assert.equal(executar('mnemonicWordReady(entrada)'), false,
    'o prefixo pela metade não fica pronto');
  executar("setWords(['']); setLang('english'); entrada = fakeInput('abandon'); mnemonicInputs[0] = entrada");
  assert.equal(executar('mnemonicWordReady(entrada)'), true,
    'a palavra inteira de lista compatível fica pronta');
  executar("setWords(['']); setLang('english'); entrada = fakeInput(''); mnemonicInputs[0] = entrada");
  assert.equal(executar('mnemonicWordReady(entrada)'), true, 'o campo vazio fica pronto');
  executar("setWords(['abandon', 'abaco']); setLang('english'); entrada = fakeInput('abaco'); mnemonicInputs[1] = entrada");
  assert.equal(executar('mnemonicWordReady(entrada)'), false,
    'a palavra sem lista comum com a frase não fica pronta');

  /* Palavra válida em outra lista, mas sem lista comum com a frase: a regra
     de apagar também derruba essa posição. É o dano colateral do critério de
     recusa, não um termo fora das listas. */
  executar("setWords(['abandon', 'abaco']); setLang('english'); entrada = fakeInput('abaco'); mnemonicInputs[1] = entrada; var recusada = commitMnemonicWord(entrada)");
  assert.equal(executar('recusada'), 'abaco', 'a recusa devolve o texto');
  assert.equal(executar('mnemonicInputs[1].value'), '', 'a palavra recusada é apagada');

  executar("setWords(['']); setLang('english'); entrada = fakeInput('zzz'); mnemonicInputs[0] = entrada; commitMnemonicWord(entrada)");
  assert.equal(executar('mnemonicInputs[0].value'), '', 'termo fora das listas também é apagado');

  /* O campo em digitação é prefixo, não palavra: `nut` é palavra inglesa,
     mas o `t` de `nutrir` não pode ser recusado numa frase portuguesa, nem a
     sugestão pode cair para a lista inglesa no meio da tecla. */
  executar("setWords(['abacate', 'nu']); setLang('portuguese'); entrada = mnemonicInputs[1]");
  assert.deepEqual(comoJson("mnemonicMatchList('nu', entrada)").slice(0, 6),
    ['nublado', 'nudez', 'numeral', 'nupcial', 'nutrir', 'nuvem'],
    'a lista do campo em edição segue a frase portuguesa');
  assert.equal(executar("mnemonicIsPrefix('nut', entrada)"), true,
    'o `t` de `nutrir` é aceito com o campo em edição fora da escolha da lista');
  executar("setWords(['abacate', 'nut']); setLang('portuguese'); entrada = fakeInput('nut'); mnemonicInputs[1] = entrada");
  assert.equal(executar("mnemonicIsPrefix('nut', entrada)"), true,
    'a palavra inglesa `nut`, sozinha no campo, não derruba a lista da frase');
  assert.equal(executar('mnemonicIsPrefix(\'nut\')'), false,
    'sem o campo em edição, a palavra já conta e a frase mista recusa a tecla');

  /* O caminho de commit é o outro lado da regra: no `focusout` a palavra já
     conta, então a frase portuguesa + `nut` fica sem lista comum e o campo
     é apagado. */
  assert.equal(executar('mnemonicWordReady(entrada)'), false,
    'enquanto está em edição, `nut` não fica pronto na frase portuguesa');
  executar('commitMnemonicWord(entrada)');
  assert.equal(executar('mnemonicInputs[1].value'), '',
    'no commit a palavra conta e a frase mista apaga `nut`');

  fs.rmSync(coreDir, { recursive: true, force: true });
  console.log('ok   inferência do idioma: ambiguidade, checagem, frase mista, grafia canônica e recusa que apaga');
}

console.log('\ntestes de interface do Cofre passaram');
