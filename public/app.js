/* Monitor BTC — Worker + Durable Object, fonte única Electrum.
   O navegador não deriva nem consulta saldo: só manda a chave estendida
   pública (xpub, zpub ou ypub) e mostra o
   estado que o Worker devolve. A xpub é a credencial; não há senha. Nada
   é gravado: nem no navegador (sem localStorage), nem no servidor. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Lista do histórico: a quantidade de itens por página é medida na área
     visível a cada desenho, em vez de um número fixo (VG-LST-03). Só o ramo
     de troco ganha palavra, para o caminho não ficar só com número. */
  var PER_PAGE_FALLBACK = 5;
  var historyPerPage = 0; // itens que cabem na área visível (medido)

  /* Movimento (VG-FND-09): as durações e curvas saem dos mesmos tokens que o
     CSS usa, então o ritmo muda num lugar só. */
  function motionMs(name, fallback) {
    var value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value) return fallback;
    if (/ms$/.test(value)) return parseFloat(value);
    if (/s$/.test(value)) return parseFloat(value) * 1000;
    return parseFloat(value) || fallback;
  }
  var reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  function prefersReducedMotion() { return reducedMotionQuery.matches; }

  var state = {
    xpub: '',
    data: null,
    timer: 0,
    busy: false,
    watch: null,        // WebSocket do tempo real (Durable Object)
    session: '',        // id efêmero da sessão no Durable Object
    watchRetry: 0,
    watchTimer: 0,      // timeout do handshake do WebSocket
    autoTimer: 0,       // debounce da consulta automática
    scanning: false,    // varredura em passos em andamento
    page: 1,            // página da lista do histórico
    fees: null,         // estimativa ao vivo do Electrum
    feeQuotes: null,    // custo de cada nível para o valor atual
    feeTimer: 0,        // reconsulta periódica da taxa
    amountDigits: '',   // satoshis digitados (o ponto é só desenho)
    limits: null,       // máximo enviável para o destino e a taxa
    limitsError: '',    // máximo indisponível (nota neutra, não erro de campo)
    addressError: null, // destino recusado pelo servidor: { address, text }
    limitsTimer: 0,
    limitsSeq: 0,
    sendBusy: false,
    psbt: null,         // PSBT montado (texto e resumo)
    psbtStale: false,   // o PSBT na tela é de um pedido anterior ao formulário
    psbtKey: '',        // destino|valor|taxa do PSBT na tela
    psbtTimer: 0,       // debounce da montagem automática
    psbtSeq: 0,         // descarta resposta de um PSBT que já saiu da tela
    psbtPending: false, // há uma montagem em voo (frase "montando")
    psbtFailKey: '',    // pedido que falhou: não repete sozinho em laço
    psbtPendingKey: '', // pedido da montagem em voo (evita pedido dobrado)
    broadcast: null,    // PSBT assinado conferido pelo servidor (nada transmitido)
    broadcastText: '',  // texto do arquivo importado, só na memória da tela
    broadcastName: '',  // nome do arquivo importado
    broadcastBusy: false,
    broadcastSent: false, // a transação já foi publicada
    broadcastSeq: 0,    // descarta resposta de um arquivo que já saiu da tela
    cpfp: null,         // PSBT da filha CPFP: { txid, status, data, error }
    cpfpSeq: 0,         // descarta resposta de uma aceleração que já saiu da tela
    sendValidationError: '', // erro de campo no #send-status, separado do PSBT
    screen: 'carteira', // tela em vigor (carteira | historico)
    langOpen: false,    // a tela de idiomas está aberta
    lang: 'pt',         // idioma em vigor (só há conteúdo em português)
    langAuto: true,     // idioma automático em vigor (só há conteúdo em português)
    historyState: 'idle', // idle | loading | error | ready
    langScroll: 0       // ponto de leitura devolvido pelo voltar da tela de idiomas
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* Percentual da taxa sobre o valor enviado, com casas suficientes para
     taxas pequenas não virarem 0. */
  function fmtPercent(part, whole) {
    var pct = Number(part) / Number(whole) * 100;
    if (!isFinite(pct) || pct <= 0) return '0';
    var digits = pct >= 10 ? 0 : pct >= 1 ? 1 : pct >= 0.1 ? 2 : 3;
    return pct.toFixed(digits);
  }
  /* Só chave estendida pública de conta: xpub, zpub ou ypub. O campo nem
     aceita outra coisa: o filtro abaixo bloqueia a digitação/colagem que não
     case com um dos três prefixos e só deixa passar caracteres do alfabeto
     base58. Endereço, chave privada, seed ou lixo não chegam a formar valor. */
  var EXT_PUBLIC = ['xpub', 'zpub', 'ypub'];
  var EXT_PREFIX_LEN = EXT_PUBLIC[0].length;
  var EXT_PUBLIC_RE = /^(xpub|zpub|ypub)[1-9A-HJ-NP-Za-km-z]+$/;
  var B58_CHARS = /[1-9A-HJ-NP-Za-km-z]/;
  var XPUB_TOTAL = 111;
  var EXT_PRIVATE = /^(xprv|yprv|zprv)/;

  /* Maior trecho do começo do texto que já casa com algum dos prefixos;
     é o que permite digitar "x", "zp", "ypu" pela metade. */
  function matchExtPrefix(s) {
    var best = 0;
    for (var i = 0; i < EXT_PUBLIC.length; i++) {
      var p = EXT_PUBLIC[i];
      var keep = 0;
      while (keep < s.length && keep < p.length && s[keep] === p[keep]) keep++;
      if (keep > best) best = keep;
    }
    return best;
  }

  function filterXpub(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '');
    var keep = matchExtPrefix(s);
    if (keep < EXT_PREFIX_LEN) {
      // enquanto o texto é prefixo de xpub/zpub/ypub (x, zp, ypu…) deixa
      // digitar; se já passou disso e não casou (xprv, bc1, 1Efg…), limpa
      var partial = s.length <= EXT_PREFIX_LEN;
      return { value: partial ? s.slice(0, keep) : '', blocked: !partial };
    }
    var rest = '';
    var dropped = false;
    for (var i = EXT_PREFIX_LEN; i < s.length; i++) {
      if (B58_CHARS.test(s[i])) rest += s[i];
      else dropped = true;
    }
    var value = s.slice(0, EXT_PREFIX_LEN) + rest.slice(0, XPUB_TOTAL - EXT_PREFIX_LEN);
    return { value: value, blocked: dropped || rest.length > XPUB_TOTAL - EXT_PREFIX_LEN };
  }

  /* Mesmo formato do recado do destino ("destino inválido: use …"):
     "chave inválida: use …", com o motivo na frente do que é aceito. */
  function xpubProblem(value) {
    var s = String(value || '').trim();
    if (!s) {
      return 'chave inválida: use a xpub, zpub ou ypub da conta.';
    }
    if (EXT_PRIVATE.test(s)) {
      return 'chave inválida: isso é uma chave privada (xprv/yprv/zprv), nunca cole a privada aqui; use a xpub, zpub ou ypub da conta.';
    }
    if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(s)) {
      return 'chave inválida: isso é um endereço Bitcoin; use a xpub, zpub ou ypub da conta.';
    }
    if (s.length !== XPUB_TOTAL || !EXT_PUBLIC_RE.test(s)) {
      return 'chave inválida: use a xpub, zpub ou ypub da conta.';
    }
    return '';
  }

  function fmtBtc(sats) {
    var n = Number(sats) || 0;
    var neg = n < 0;
    var s = String(Math.abs(n));
    while (s.length < 9) s = '0' + s;
    return (neg ? '-' : '') + s.slice(0, -8) + '.' + s.slice(-8);
  }
  /* Locktime → data estimada; 0 = não. Igual ao cofre: locktime em bloco
     vira data aproximada (10 min por bloco desde o genesis) e o bloco não
     aparece, só a data. */
  function scheduledText(locktime) {
    var value = Number(locktime) >>> 0;
    if (!value) return 'não';
    var date = value >= 500000000
      ? new Date(value * 1000)
      : new Date((1231006505 + value * 600) * 1000);
    if (isNaN(date.getTime())) return 'data estimada indisponível';
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' +
      (value < 500000000 ? ' (aprox.)' : '');
  }
  function rbfText(rbf) { return rbf ? 'sim' : 'não'; }
  /* Valor digitado em BTC → sats inteiros. Aceita vírgula ou ponto e até 8
     casas; qualquer outra coisa (ou zero) devolve null. */
  function parseBtcSats(text) {
    var s = String(text == null ? '' : text).trim().replace(/\s+/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,8})?$/.test(s)) return null;
    var parts = s.split('.');
    var whole = BigInt(parts[0] || '0');
    var frac = (parts[1] || '').padEnd(8, '0');
    var sats = whole * 100000000n + BigInt(frac || '0');
    if (sats <= 0n || sats > 2100000000000000n) return null;
    return Number(sats);
  }
  /* Marcador do recado (VG-FRM-06): o estado vem antes do texto, em caixa
     baixa e entre colchetes, como no gerador. O neutro é o mesmo sinal do
     carregamento e some quando a consulta termina. */
  var PREFIX = { ok: '[ ok ]', error: '[ erro ]', '': '[ ... ]' };
  /* Aviso temporário (VG-ABS-07): o recado final do formulário e da ação
     secundária some sozinho em 8 s, pausa com o ponteiro sobre ele ou o foco
     no formulário e recomeça de onde parou. O neutro de carregamento fica
     fora: ele é substituído pelo recado final. */
  var notices = new WeakMap();
  function noticeClear(el) {
    el.textContent = '';
    el.classList.remove('ok', 'error');
  }
  function noticeStop(el) {
    var n = notices.get(el);
    if (n && n.timer) { clearTimeout(n.timer); n.timer = 0; }
  }
  function noticeResume(el) {
    var n = notices.get(el);
    if (!n || n.timer || n.remaining <= 0) return;
    n.startedAt = Date.now();
    n.timer = setTimeout(function () {
      n.timer = 0;
      noticeClear(el);
    }, n.remaining);
  }
  function noticePause(el) {
    var n = notices.get(el);
    if (!n || !n.timer) return;
    clearTimeout(n.timer);
    n.timer = 0;
    n.remaining = Math.max(0, n.remaining - (Date.now() - n.startedAt));
  }
  function noticeSchedule(el) {
    var n = notices.get(el);
    if (!n) { n = { timer: 0, remaining: 0, startedAt: 0 }; notices.set(el, n); }
    noticeStop(el);
    n.remaining = motionMs('--motion-notice', 8000);
    n.startedAt = Date.now();
    n.timer = setTimeout(function () {
      n.timer = 0;
      noticeClear(el);
    }, n.remaining);
  }
  function noticeWire(el) {
    if (!el) return;
    var form = el.closest ? el.closest('form') : null;
    el.addEventListener('pointerenter', function () { noticePause(el); });
    el.addEventListener('pointerleave', function () { noticeResume(el); });
    if (!form) return;
    form.addEventListener('focusin', function () { noticePause(el); });
    form.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!form.contains(document.activeElement)) noticeResume(el);
      }, 0);
    });
  }
  function setStatusTo(el, kind, text) {
    if (!el) return;
    el.textContent = text ? (PREFIX[kind] || PREFIX['']) + ' ' + text : '';
    el.classList.remove('ok', 'error');
    if (kind === 'ok' || kind === 'error') {
      el.classList.add(kind);
      noticeSchedule(el);
    } else {
      noticeStop(el);
    }
  }
  function setStatus(kind, text) {
    setStatusTo($('#status'), kind, text);
  }
  function setSendStatus(kind, text) {
    setStatusTo($('#send-status'), kind, text);
  }
  /* O erro de campo usa o recado geral (VG-FRM-07): o texto fica no
     #send-status, e o campo só leva o fio/rótulo em --error e aria-invalid.
     O sinal separado evita que a atualização automática do formulário apague
     um erro do PSBT que não é de validação. */
  function setSendValidation(text) {
    if (text) {
      state.sendValidationError = text;
      setSendStatus('error', text);
    } else if (state.sendValidationError) {
      state.sendValidationError = '';
      setSendStatus('', '');
    }
  }
  function setFieldInvalid(input, invalid) {
    if (!input) return;
    var box = input.closest ? input.closest('.field-box') : null;
    var label = input.id ? document.querySelector('label[for="' + input.id + '"]') : null;
    if (box) box.classList.toggle('is-invalid', !!invalid);
    if (label) label.classList.toggle('is-invalid', !!invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  function focusFirstInvalid(root) {
    var field = root ? root.querySelector('[aria-invalid="true"]') : null;
    if (field) { field.focus(); return true; }
    return false;
  }
  var SCREEN_TITLES = {
    carteira: 'Monitor BTC - carteira',
    historico: 'Monitor BTC - histórico',
    sobre: 'Monitor BTC - sobre',
    language: 'Monitor BTC - idioma',
    notfound: 'Monitor BTC - 404'
  };
  var SCREEN_IDS = ['carteira', 'historico', 'sobre', 'notfound', 'language'];

  /* URL e histórico (VG-MET-10): a tela e a página da lista vão para o
     endereço; a tela inicial e a primeira página ficam sem parâmetro, para o
     endereço continuar curto. A tela de idiomas fica fora do endereço. */
  function readUrl() {
    var params = new URLSearchParams(location.search);
    var raw = params.get('screen');
    var screen = raw == null || raw === 'carteira' ? 'carteira'
      : raw === 'historico' ? 'historico'
      : raw === 'sobre' ? 'sobre'
      : 'notfound';
    // O link de salto usa #content; qualquer outro hash desconhecido é 404.
    if (location.hash && location.hash !== '#content') screen = 'notfound';
    var page = parseInt(params.get('page'), 10);
    if (!isFinite(page) || page < 1) page = 1;
    return { screen: screen, page: page };
  }
  function urlFor() {
    // A 404 preserva o endereço que falhou (VG-ABS-09); as demais telas
    // escrevem o endereço curto normal.
    if (state.screen === 'notfound') return location.pathname + location.search + location.hash;
    var params = new URLSearchParams();
    if (state.screen !== 'carteira') params.set('screen', state.screen);
    if (state.screen === 'historico' && state.page > 1) params.set('page', String(state.page));
    var query = params.toString();
    return location.pathname + (query ? '?' + query : '');
  }
  function pushScreenUrl() {
    var url = urlFor();
    if (url === location.pathname + location.search) return;
    history.pushState({ screen: state.screen, page: state.page }, '', url);
  }

  /* Entrada em foco (VG-EFE-02): o título assenta, a régua se desenha da
     esquerda para a direita e cada bloco sobe 12 px enquanto o desfoque se
     resolve, escalonado. Não repete na troca de tema; com menos movimento, o
     conteúdo aparece direto. */
  // Os blocos entram deslocados 12 px para baixo, e a transformação entra na
  // conta do scrollHeight: enquanto a entrada roda, updateScroll() desconta
  // esse deslocamento para não acender a seta de baixo numa tela que cabe
  // inteira. No fim da entrada a medida volta ao normal e é reavaliada.
  var REVEAL_RISE = 12;
  var revealLift = 0;
  var revealRun = 0;
  function runReveal(screen) {
    if (!screen || prefersReducedMotion() || !Element.prototype.animate) {
      revealLift = 0;
      return;
    }
    var title = screen.querySelector('h2');
    var rule = screen.querySelector('.rule:not(.rule-dots)');
    if (!title || !rule) {
      revealLift = 0;
      return;
    }
    var blocks = Array.prototype.filter.call(screen.children, function (el) {
      return el !== title && el !== rule && !el.hidden && el.getClientRects().length;
    });
    var ease = 'cubic-bezier(.16,1,.3,1)';
    var easeDraw = 'cubic-bezier(.65,0,.35,1)';
    [title, rule].concat(blocks).forEach(function (el) {
      if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel(); });
    });
    title.animate([
      { opacity: 0, transform: 'translateY(-6px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: motionMs('--motion-reveal-head', 250), easing: ease, fill: 'both' });
    rule.animate([
      { opacity: 0, clipPath: 'inset(0 100% 0 0)' },
      { opacity: 1, clipPath: 'inset(0 0 0 0)' }
    ], {
      duration: motionMs('--motion-reveal', 250),
      delay: motionMs('--motion-rule-delay', 75),
      easing: easeDraw,
      fill: 'both'
    });
    blocks.forEach(function (el, i) {
      el.animate([
        { opacity: 0, transform: 'translateY(' + REVEAL_RISE + 'px)', filter: 'blur(3px)' },
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0px)' }
      ], {
        duration: motionMs('--motion-reveal', 250),
        delay: motionMs('--motion-reveal-delay', 50) + i * motionMs('--motion-reveal-step', 25),
        easing: ease,
        fill: 'both'
      });
    });
    var runId = ++revealRun;
    revealLift = REVEAL_RISE;
    screen.setAttribute('aria-busy', 'true');
    if (screen._revealTimer) clearTimeout(screen._revealTimer);
    screen._revealTimer = setTimeout(function () {
      screen._revealTimer = 0;
      screen.removeAttribute('aria-busy');
      if (revealRun !== runId) return;
      revealLift = 0;
      updateScroll();
    }, motionMs('--motion-reveal-total', 1000));
  }

  function markCurrent(name) {
    $$('.menu button[data-screen]').forEach(function (b) {
      if (b.getAttribute('data-screen') === name) {
        b.setAttribute('aria-current', 'page');
        b.setAttribute('tabindex', '-1');
      } else {
        b.removeAttribute('aria-current');
        b.removeAttribute('tabindex');
      }
    });
    var lang = $('#lang-btn');
    if (lang) {
      if (name === 'language') {
        lang.setAttribute('aria-current', 'page');
        lang.setAttribute('tabindex', '-1');
      } else {
        lang.removeAttribute('aria-current');
        lang.removeAttribute('tabindex');
      }
    }
  }

  function setScreenVisible(name) {
    SCREEN_IDS.forEach(function (n) {
      var sec = $('#screen-' + n);
      if (sec) sec.hidden = n !== name;
    });
  }

  function showScreen(name, opts) {
    opts = opts || {};
    if (!SCREEN_TITLES[name] || name === 'language') name = 'carteira';
    state.screen = name;
    state.langOpen = false;
    setScreenVisible(name);
    markCurrent(name);
    if (name === 'historico') {
      // abrir a lista pelo menu recomeça na primeira página (VG-LST-03); a
      // abertura pelo endereço e o popstate devolvem a página pedida.
      state.page = opts.page == null ? 1 : opts.page;
      syncHistoryState();
      renderHistory();
    }
    document.title = SCREEN_TITLES[name];
    if (!opts.keepScroll) {
      var sc = $('#content-scroll');
      if (sc) sc.scrollTop = 0;
    }
    updateScroll();
    if (!opts.noReveal) runReveal($('#screen-' + name));
    if (!opts.noUrl) pushScreenUrl();
  }

  /* Ponto de leitura (VG-LAY-12): na rolagem única quem rola é a página, e a
     posição é a da janela; na janela normal, é a do .content-scroll. Guardar e
     devolver pelo mesmo lugar mantém o voltar da tela de idiomas coerente nos
     dois modos. */
  function readingTop() {
    var page = $('.page');
    if (page && page.classList.contains('is-page-scroll')) {
      return window.pageYOffset || document.documentElement.scrollTop || 0;
    }
    var sc = $('#content-scroll');
    return sc ? sc.scrollTop : 0;
  }
  function setReadingTop(top) {
    var page = $('.page');
    if (page && page.classList.contains('is-page-scroll')) {
      window.scrollTo(window.pageXOffset || 0, top);
      return;
    }
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = top;
  }

  /* A tela de idiomas é uma tela, não um modal (VG-ABS-06): o menu perde a
     marca, o botão PT fica em vigor e o voltar/Esc devolve a tela de origem
     no mesmo ponto de leitura. Ela não entra no endereço (VG-MET-10). */
  function showLanguage() {
    // O botão em vigor não age (VG-IDI-01): a tela já está aberta e se fecha
    // pelo voltar, pelo Esc ou pela escolha de um item. O guarda também evita
    // que a rolagem da própria tela sobrescreva o ponto de leitura guardado.
    if (state.langOpen) return;
    state.langScroll = readingTop();
    state.langOpen = true;
    setScreenVisible('language');
    markCurrent('language');
    document.title = SCREEN_TITLES.language;
    // A tela de idiomas começa no alto, qualquer que seja a rolagem da tela
    // de origem (VG-IDI-01); o voltar devolve a origem ao ponto guardado.
    setReadingTop(0);
    updateScroll();
    runReveal($('#screen-language'));
  }
  function closeLanguage() {
    state.langOpen = false;
    showScreen(state.screen, {
      page: state.page,
      keepScroll: true,
      noUrl: true
    });
    setReadingTop(state.langScroll);
    updateScroll();
    // preventScroll mantém o ponto de leitura: o foco não arrasta a página
    // até o rodapé na rolagem única (VG-LAY-12).
    var b = $('#lang-btn');
    if (b) b.focus({ preventScroll: true });
  }
  /* Idioma em vigor (VG-IDI-02/03): o automático fica marcado quando está em
     vigor e, como ele resolve para o idioma atual, esse idioma também aparece
     marcado — a tela mostra a escolha e o resultado ao mesmo tempo. Escolher
     um idioma manual desmarca o automático. Os marcados saem do clique e da
     ordem do Tab; os demais voltam a responder. */
  function markLanguage() {
    $$('.lang-list .lang-item[data-lang]').forEach(function (item) {
      if (item.disabled) return;
      var code = item.getAttribute('data-lang');
      var current = code === 'auto' ? state.langAuto : code === state.lang;
      item.setAttribute('aria-pressed', current ? 'true' : 'false');
      if (current) item.setAttribute('tabindex', '-1');
      else item.removeAttribute('tabindex');
    });
  }
  /* A escolha aplica a marca (VG-IDI-02/03) e fecha a tela, devolvendo à
     origem (VG-IDI-05). */
  function selectLanguage(button) {
    if (!button || button.disabled) return;
    state.langAuto = button.getAttribute('data-lang') === 'auto';
    markLanguage();
    closeLanguage();
  }
  function fillFrames() {
    $$('.edge').forEach(function (el) {
      el.innerHTML = '<span>+</span><span class="fill">' + '-'.repeat(240) + '</span><span>+</span>';
    });
    $$('.rule:not(.rule-dots)').forEach(function (el) {
      el.textContent = '='.repeat(240);
    });
  }
  // O ícone da aba é a letra B sozinha, sem fundo, no --accent do tema em
  // vigor: o desenho sai do mesmo #favicon-marca do href estático, em
  // currentColor, e o tom sai do token — o favicon não é uma segunda cópia do
  // desenho nem um hex repetido. O arquivo estático do <link> só conhece o
  // tema do sistema; aqui ele é reescrito no arranque e a cada troca de tema.
  function syncFavicon() {
    var link = document.getElementById('favicon');
    var symbol = document.getElementById('favicon-marca');
    if (!link || !symbol) return;
    var accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    if (!accent) return;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
      symbol.getAttribute('viewBox') + '" color="' + accent + '">' +
      symbol.innerHTML + '</svg>';
    link.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(svg));
  }
  function themeFromUrl() {
    var t = new URLSearchParams(location.search).get('theme');
    return t === 'light' || t === 'dark' ? t : '';
  }
  var themeSwapTimer = 0;
  function setTheme(theme, opts) {
    var t = theme === 'light' ? 'light' : 'dark';
    var root = document.documentElement;
    var changed = root.dataset.theme !== t;
    /* Crossfade de tema (VG-EFE-07): a classe theme-fx existe só durante
       --motion-theme e faz fundo, card, moldura, texto e controles passarem
       juntos; o grão acompanha pelo filtro de brilho, no compositor. Com
       menos movimento, a troca é direta. */
    var animate = changed && !(opts && opts.immediate) && !prefersReducedMotion();
    /* O `color-scheme` nativo precisa ser trocado num recálculo separado,
       antes do crossfade: trocado no mesmo quadro que as cores, ele reinicia
       a transição de `color` de cada elemento e o texto termina de mudar
       depois do fundo — a piscada do conteúdo no meio da troca. A leitura de
       layout força o recálculo antes de a classe theme-fx entrar. */
    if (root.style.colorScheme !== t) {
      root.style.colorScheme = t;
      if (animate) void root.offsetWidth;
    }
    if (animate) {
      root.classList.add('theme-fx');
      if (themeSwapTimer) clearTimeout(themeSwapTimer);
      themeSwapTimer = setTimeout(function () {
        themeSwapTimer = 0;
        root.classList.remove('theme-fx');
      }, motionMs('--motion-theme', 150) + 50);
    }
    root.dataset.theme = t;
    if (!(opts && opts.save === false)) {
      try { localStorage.setItem('monitor-btc-theme', t); } catch (e) {}
    }
    var b = $('#theme-toggle');
    if (b) {
      b.innerHTML = '<span class="glyph">' +
        (t === 'light' ? '●' : '<span class="glyph-ring">○</span>') + '</span>';
      b.setAttribute('aria-label', t === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro');
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
    syncFavicon();
    syncGrainTheme();
  }
  /* Foca agora se o controle já aceita foco; se a visibilidade ainda está
     no fim da transição, tenta de novo depois dela. Só insiste se o foco
     continuar no controle antigo ou no body, para não roubar um Tab do
     leitor nesse intervalo. */
  function focusWhenReady(el, previous) {
    if (!el) return false;
    el.focus();
    if (document.activeElement === el) return true;
    setTimeout(function () {
      if (document.activeElement === previous || document.activeElement === document.body ||
          document.activeElement === document.documentElement) {
        el.focus();
      }
    }, motionMs('--motion-fast', 150) + 30);
    return true;
  }
  /* Passagem de foco do rodapé (VG-ACR-09): o ▼ e o paginador ocupam o mesmo
     lugar. Quando o controle que tem o foco sai de cena, o foco vai para o
     que assumiu o lugar; sem nenhum dos dois, volta ao título da tela. */
  function handOffBottomFocus() {
    var down = $('.scroll-arrow-down');
    var pager = $('#history-pager');
    var content = $('#content');
    var active = document.activeElement;
    var inDown = !!down && down.contains(active);
    var inPager = !!pager && pager.contains(active);
    if (!inDown && !inPager) return;
    var downTarget = !!content && content.classList.contains('can-scroll-down') &&
      !content.classList.contains('show-pager');
    var pagerTarget = !!pager && !pager.hidden && !!content &&
      content.classList.contains('show-pager');
    var heading = document.querySelector('.screen:not([hidden]) h2');
    if (inDown && !downTarget) {
      if (pagerTarget) {
        var next = $('#history-next');
        var prev = $('#history-prev');
        var target = next && next.getAttribute('aria-disabled') !== 'true' ? next : prev;
        focusWhenReady(target, active);
      } else if (heading) heading.focus();
    } else if (inPager && !pagerTarget) {
      if (downTarget) focusWhenReady(down, active);
      else if (heading) heading.focus();
    }
  }
  function updateScroll() {
    var el = $('#content-scroll');
    var c = $('#content');
    if (!el || !c) return;
    var max = el.scrollHeight - el.clientHeight;
    // Durante a entrada em foco os blocos ficam REVEAL_RISE abaixo e isso entra
    // no scrollHeight; descontar o deslocamento evita acender a seta de baixo
    // numa tela que cabe inteira. O paginador usa a mesma medida: com o
    // deslocamento da animação ele entenderia que ainda há conteúdo para rolar
    // e sumiria até o fim da entrada em foco, um segundo depois da troca de
    // página.
    var scrollable = max - revealLift;
    c.classList.toggle('can-scroll-up', max > 2 && el.scrollTop > 2);
    c.classList.toggle('can-scroll-down', scrollable > 2 && el.scrollTop < scrollable - 2);
    updatePager(scrollable);
    handOffBottomFocus();
  }

  /* Altura do conteúdo fora do gesto de rolagem: a taxa, o PSBT e os demais
     blocos entram e saem conforme o formulário, e isso não dispara 'scroll'.
     Sem reavaliar, o degradê e a seta de baixo continuam anunciando uma
     rolagem que já não existe. O observador cobre o que está dentro do
     .content-scroll (blocos que aparecem ou somem, texto que muda de tamanho)
     e reavalia uma vez por quadro. */
  function watchContentHeight() {
    var el = $('#content-scroll');
    if (!el || typeof MutationObserver !== 'function') return;
    var frame = 0;
    var schedule = function () {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        updateScroll();
      });
    };
    new MutationObserver(schedule).observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'style']
    });
  }

  /* Altura real da janela (VG-LAY-12): o Chrome do Android pode publicar
     100dvh maior que a área visível logo depois de recarregar, contando a
     barra do navegador; o card passa da tela e o rodapé só aparece quando a
     página rola. window.innerHeight já desconta essa barra, então a medida
     vai para --app-h e o CSS a usa no lugar da unidade de viewport. Reavaliar
     em resize/orientação cobre a barra que aparece e some; o visualViewport
     cobre o WebKit do iOS, que muda a área visível sem disparar resize. */
  function syncViewportHeight() {
    var h = window.innerHeight;
    if (h > 0) document.documentElement.style.setProperty('--app-h', h + 'px');
  }

  /* Reavalia a altura medida em toda mudança de viewport que não passa pelo
     resize da janela: a barra do iOS, a volta do bfcache, a retomada do PWA.
     O quadro único evita medir e reflowar mais de uma vez por mudança. */
  var viewportFrame = 0;
  function syncViewportSoon() {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(function () {
      viewportFrame = 0;
      syncViewportHeight();
      syncPageMode();
      relayoutHistory();
    });
  }

  /* Rolagem única (VG-LAY-12): quando a janela fica abaixo do piso do card
     mais os respiros, a página é a única a rolar e o card cresce. O piso e os
     respiros são lidos já em px, e a altura vem do .vh-probe, que mede o
     mesmo --app-h do card. */
  function syncPageMode() {
    var probe = $('.vh-probe');
    var win = $('.window');
    var page = $('.page');
    if (!probe || !win || !page) return;
    var vh = probe.getBoundingClientRect().height;
    var pageStyle = getComputedStyle(page);
    var pad = parseFloat(pageStyle.paddingTop) + parseFloat(pageStyle.paddingBottom);
    var floor = parseFloat(getComputedStyle(win).minHeight) || 0;
    page.classList.toggle('is-page-scroll', vh > 0 && (vh - pad) < floor);
    updateScroll();
  }

  /* Barras de altura igual (VG-LAY-05): menu e rodapé recebem a mesma altura
     mínima, então o menu que quebra em duas linhas no celular não deixa o
     rodapé menor. */
  function syncBars() {
    var menu = $('.menu');
    var status = $('.status');
    if (!menu || !status) return;
    menu.style.minHeight = '';
    status.style.minHeight = '';
    var h = Math.max(
      menu.getBoundingClientRect().height,
      status.getBoundingClientRect().height
    );
    if (!h) return;
    menu.style.minHeight = h + 'px';
    status.style.minHeight = h + 'px';
  }

  /* Estados da lista (VG-LST-04/05, VG-ABS-10): vazio, carregando e erro de
     dados ocupam a mesma área, sem deixar o histórico em branco nem reusar a
     lista vazia, que é um estado válido. */
  function historySkeleton() {
    var box = $('#history-skeleton');
    if (!box || box.childElementCount) return;
    var html = '';
    var count = historyPerPage > 0 ? historyPerPage : PER_PAGE_FALLBACK;
    for (var i = 0; i < count; i++) {
      if (i) html += '<div class="rule rule-dots" aria-hidden="true"></div>';
      html += '<div class="item-skeleton">' +
        '<span class="item-skeleton-line is-title"></span>' +
        '<span class="item-skeleton-line is-long"></span>' +
        '<span class="item-skeleton-line is-mid"></span>' +
        '<span class="item-skeleton-line is-tags"></span>' +
        '</div>';
    }
    box.innerHTML = html;
  }
  function syncHistoryState() {
    var region = $('#history-region');
    var loading = $('#history-loading');
    var skel = $('#history-skeleton');
    var err = $('#history-error');
    var list = $('#history-list');
    var empty = $('#addresses-empty');
    var ready = state.historyState === 'ready';
    var rows = historyRows();
    if (region) {
      if (state.historyState === 'loading') region.setAttribute('aria-busy', 'true');
      else region.removeAttribute('aria-busy');
    }
    if (loading) loading.hidden = state.historyState !== 'loading';
    if (skel) {
      skel.hidden = state.historyState !== 'loading';
      if (state.historyState === 'loading') historySkeleton();
    }
    if (err) err.hidden = state.historyState !== 'error';
    var summary = $('#history-summary');
    if (summary) {
      /* sem endereço usado a lista mostra o estado vazio; o resumo de
         endereços, recebido e enviado não tem o que dizer e sai de cena. */
      summary.hidden = ready && rows.length === 0;
      if (state.historyState === 'loading') {
        summary.textContent = '';
      } else if (state.historyState === 'error') {
        summary.textContent = '';
      } else if (state.historyState === 'idle') {
        summary.textContent = 'cole a xpub, zpub ou ypub na carteira para ver o histórico.';
      }
    }
    if (list) list.hidden = !(ready && rows.length > 0);
    if (empty) empty.hidden = !(ready && rows.length === 0);
    updateScroll();
  }

  /* --------------------------------------------------------------- grão */
  /* Grão de fundo (VG-FND-05 / VG-EFE-01): células de 14 px, glifos de
     13 px, seis caracteres e exatamente 50% das células ocupadas. A tinta
     não é --line: a cobertura média dos glifos e o alpha do --panel sobre o
     --bg geram um tom cujo glifo renderizado cai no tom do card. A textura é
     desenhada com a tinta do tema claro; o escuro é o mesmo desenho escurecido
     por um filtro de brilho, animado pelo compositor junto com as cores. */
  var GRAIN_GLYPHS = ['.', ':', '-', '=', '+', '*'];
  var grain = {
    canvas: null, ctx: null, font: '', ink: '',
    ratio: 1, cols: 0, rows: 0, cell: 14, occ: null, map: null,
    timer: 0
  };

  function colorParts(value) {
    var s = String(value || '').trim();
    var hex = s.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var a = 1;
      if (h.length === 8) { a = parseInt(h.slice(6, 8), 16) / 255; h = h.slice(0, 6); }
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: a
      };
    }
    var parts = s.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return null;
    var unit = /^color\(/i.test(s) ? 255 : 1;
    return {
      r: parseFloat(parts[0]) * unit,
      g: parseFloat(parts[1]) * unit,
      b: parseFloat(parts[2]) * unit,
      a: parts.length > 3 ? parseFloat(parts[3]) : 1
    };
  }
  /* Cobertura média dos glifos, medida no canvas com a mesma fonte e DPR. */
  function grainCoverage(font, dpr) {
    var probe = document.createElement('canvas');
    probe.width = Math.ceil(GRAIN_GLYPHS.length * 16 * dpr);
    probe.height = Math.ceil(20 * dpr);
    var ctx = probe.getContext('2d');
    if (!ctx) return 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fff';
    for (var i = 0; i < GRAIN_GLYPHS.length; i++) ctx.fillText(GRAIN_GLYPHS[i], i * 16, 0);
    var data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    var sum = 0, count = 0;
    for (var p = 3; p < data.length; p += 4) {
      var a = data[p] / 255;
      if (a <= 0) continue;
      sum += a;
      count++;
    }
    return count ? Math.min(1, sum / count) : 1;
  }
  function grainInkFor(panel, bg, coverage) {
    var alpha = panel.a;
    function ink(card, base) {
      return Math.max(0, Math.min(255, Math.round(base + (card - base) / coverage)));
    }
    return {
      r: ink(panel.r * alpha + bg.r * (1 - alpha), bg.r),
      g: ink(panel.g * alpha + bg.g * (1 - alpha), bg.g),
      b: ink(panel.b * alpha + bg.b * (1 - alpha), bg.b)
    };
  }
  /* Lê os tokens de um tema num elemento isolado, sem pintar nada na tela. */
  function themeColorTokens(theme) {
    var probe = document.createElement('div');
    probe.setAttribute('data-theme', theme);
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    var cs = getComputedStyle(probe);
    var tokens = {
      panel: colorParts(cs.getPropertyValue('--panel')),
      bg: colorParts(cs.getPropertyValue('--bg'))
    };
    probe.remove();
    return tokens;
  }
  function grainLuma(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

  function resizeGrain() {
    var canvas = grain.canvas;
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    grain.ctx = ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = grain.font;
    ctx.textBaseline = 'top';
    ctx.fillStyle = grain.ink;
    var cell = grain.cell;
    var cols = Math.ceil(w / cell);
    var rows = Math.ceil(h / cell);
    var total = cols * rows;
    var occ = new Uint8Array(total);
    var order = new Int32Array(total);
    for (var i = 0; i < total; i++) order[i] = i;
    for (var j = total - 1; j > 0; j--) {
      var k = (Math.random() * (j + 1)) | 0;
      var t = order[j];
      order[j] = order[k];
      order[k] = t;
    }
    for (var n = 0; n < Math.floor(total / 2); n++) occ[order[n]] = 1;
    var map = new Array(total);
    for (var q = 0; q < total; q++) map[q] = (Math.random() * GRAIN_GLYPHS.length) | 0;
    grain.cols = cols;
    grain.rows = rows;
    grain.occ = occ;
    grain.map = map;
    ctx.clearRect(0, 0, w, h);
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var idx = r * cols + c;
        if (occ[idx]) ctx.fillText(GRAIN_GLYPHS[map[idx]], c * cell, r * cell);
      }
    }
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
  }
  /* A cada --motion-grain, 0,35% dos glifos (mínimo 4) sai de uma célula
     ocupada e ocupa uma vazia: o total de células ocupadas não muda. */
  function tickGrain() {
    if (!grain.ctx || document.hidden) return;
    var occ = grain.occ;
    var cell = grain.cell;
    var ctx = grain.ctx;
    var cols = grain.cols;
    var total = cols * grain.rows;
    var n = Math.max(4, Math.round(total * 0.0035));
    n = Math.min(n, Math.floor(total / 2));
    var occupied = [];
    var empty = [];
    for (var i = 0; i < total; i++) (occ[i] ? occupied : empty).push(i);
    if (occupied.length < n || empty.length < n) return;
    shuffle(occupied);
    shuffle(empty);
    for (var k = 0; k < n; k++) {
      var from = occupied[k];
      var to = empty[k];
      occ[from] = 0;
      occ[to] = 1;
      ctx.clearRect((from % cols) * cell, ((from / cols) | 0) * cell, cell, cell);
      grain.map[to] = (Math.random() * GRAIN_GLYPHS.length) | 0;
      ctx.fillText(GRAIN_GLYPHS[grain.map[to]], (to % cols) * cell, ((to / cols) | 0) * cell);
    }
  }
  function startGrain() {
    if (!grain.ctx || grain.timer) return;
    grain.timer = setInterval(tickGrain, motionMs('--motion-grain', 75));
  }
  function stopGrain() {
    if (!grain.timer) return;
    clearInterval(grain.timer);
    grain.timer = 0;
  }
  /* O filtro do tema é o único ajuste do grão que anima (VG-EFE-07). No
     arranque, porém, ele precisa entrar sem transição e antes do primeiro
     desenho: senão a tinta clara aparece por um quadro e escurece animando,
     que é a piscada branca/preto na abertura. */
  function syncGrainTheme(immediate) {
    if (!grain.canvas) return;
    var light = document.documentElement.dataset.theme === 'light';
    var value = light ? 'brightness(1)' : 'brightness(' + grain.ratio.toFixed(4) + ')';
    var canvas = grain.canvas;
    if (!immediate) {
      canvas.style.filter = value;
      return;
    }
    canvas.style.transition = 'none';
    canvas.style.filter = value;
    // aplica o valor antes de religar a transição, para o primeiro quadro já
    // sair na tinta do tema
    void canvas.offsetWidth;
    canvas.style.transition = '';
  }
  function initGrain() {
    var canvas = $('#grain');
    if (!canvas || grain.canvas) return;
    if (window.matchMedia('(forced-colors: active)').matches) return;
    var mono = getComputedStyle(document.documentElement)
      .getPropertyValue('--mono').replace(/\s+/g, ' ').trim() || 'monospace';
    var font = '13px ' + mono;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var coverage = grainCoverage(font, dpr);
    var light = themeColorTokens('light');
    var dark = themeColorTokens('dark');
    if (!light.panel || !light.bg || !dark.panel || !dark.bg) return;
    var lightInk = grainInkFor(light.panel, light.bg, coverage);
    var darkInk = grainInkFor(dark.panel, dark.bg, coverage);
    var lightLuma = grainLuma(lightInk);
    var darkLuma = grainLuma(darkInk);
    grain.ratio = lightLuma > 0 ? Math.max(0.05, Math.min(5, darkLuma / lightLuma)) : 1;
    grain.font = font;
    grain.ink = 'rgb(' + [lightInk.r, lightInk.g, lightInk.b].join(', ') + ')';
    grain.canvas = canvas;
    syncGrainTheme(true);
    resizeGrain();
    if (!prefersReducedMotion()) startGrain();
  }

  /* Um endereço de recebimento por tipo — sempre o primeiro índice sem uso
     daquele ramo (`último usado + 1`) —, inclusive os tipos sem saldo, para
     o usuário escolher o que o pagador aceita. O rótulo é o tipo da conta e
     o botão de copiar fica ao lado do endereço. */
  function renderReceive(d) {
    var body = $('#receive-table tbody');
    if (!body) return;
    body.innerHTML = '';
    var types = d.types || [];
    types.forEach(function (t) {
      var tr = document.createElement('tr');
      var addr = t.address || '';
      var label = t.type || t.label || '';
      tr.innerHTML = '<th scope="row">' + esc(label) + '</th>' +
        '<td><span class="receive-line"><code>' + esc(addr || '—') + '</code>' +
        (addr ? '<button type="button" class="key-action" data-copy="' + esc(addr) +
          '" aria-label="copiar endereço ' + esc(label) + '">copiar</button>' : '') +
        '</span></td>';
      body.appendChild(tr);
    });
    $('#receive-table').hidden = types.length === 0;
    $('#receive-heading').hidden = types.length === 0;
  }

  /* ---------------------------------------------------------- enviar */
  /* Não há escolha de taxa: um número só, o `estimatefee(2)` do Bitcoin
     Core (ver ESTIMATE_TARGETS em src/electrum.js). O valor vem do
     /api/fees e o percentual sobre o valor enviado, do preview do valor e do
     destino digitados. */
  var FEE_MAX = 10000;

  /* A taxa vem do servidor em sat/vB e PODE ter casas (0,12; 1,075; 1,926):
     o valor exato é sat/kvB. */
  function feeRateNow() {
    var levels = (state.fees && state.fees.levels) || {};
    return Number(levels.next) || 0;
  }

  /* O que não pode é faltar, ser zero ou passar do teto — a faixa fina
     (mínimo representável, teto de 10 000) é conferida no servidor, em
     psbt.js. Comparar com inteiro aqui deixaria a tela sem preview e o botão
     bloqueado sempre que a estimativa não fosse redonda. */
  function feeRateOk(rate) {
    var n = Number(rate);
    return isFinite(n) && n >= 0.001 && n <= FEE_MAX;
  }

  /* Valor em BTC com máscara de 8 casas: o usuário digita só dígitos e o
     ponto entra sozinho, da direita para a esquerda (1 → 0.00000001). O
     valor guardado é o inteiro de satoshis, sem zeros à esquerda, então o
     backspace remove o último dígito de verdade. */
  var AMOUNT_DIGITS_MAX = 15;
  var DUST_SATS = 546;

  function amountSats() {
    return state.amountDigits ? Number(BigInt(state.amountDigits)) : 0;
  }

  function amountDisplay(digits) {
    if (!digits) return '';
    var padded = String(digits).padStart(9, '0');
    return padded.slice(0, -8) + '.' + padded.slice(-8);
  }

  function renderAmountInput() {
    var input = $('#send-amount');
    if (input) input.value = amountDisplay(state.amountDigits);
    updateSendAvailability();
  }

  function setAmountDigits(digits) {
    var clean = String(digits == null ? '' : digits).replace(/\D/g, '');
    clean = clean.replace(/^0+(?=\d)/, '');
    if (clean.length > AMOUNT_DIGITS_MAX) clean = clean.slice(0, AMOUNT_DIGITS_MAX);
    state.amountDigits = clean;
    renderAmountInput();
    scheduleLimits(true);
  }

  function syncAmountFromValue() {
    var input = $('#send-amount');
    if (!input) return;
    var v = input.value.trim();
    if (!v) { setAmountDigits(''); return; }
    var sats = null;
    if (/[.,]/.test(v)) sats = parseBtcSats(v);
    else {
      var d = v.replace(/\D/g, '');
      sats = d ? Number(BigInt(d)) : 0;
    }
    if (sats == null) { renderAmountInput(); return; }
    setAmountDigits(String(sats));
  }

  function addressLooksValid(address) {
    var s = String(address || '').trim();
    if (/^bc1[02-9ac-hj-np-z]{11,87}$/i.test(s)) return true;
    return /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s);
  }

  function updateSendAvailability() {
    var amount = amountSats();
    var addressInput = $('#send-address');
    var amountInput = $('#send-amount');
    var address = addressInput ? addressInput.value.trim() : '';
    var rate = feeRateNow();
    var hint = $('#send-amount-hint');
    var max = state.limits ? Number(state.limits.max_send_sats) || 0 : 0;
    var amountProblem = '';
    var addressProblem = '';
    var hintText = '';

    if (address && !addressLooksValid(address)) {
      addressProblem = 'destino inválido: use um endereço bc1…, 1… ou 3….';
    } else if (address && state.addressError && state.addressError.address === address) {
      /* o regex deixa passar endereço com checksum errado: quem recusa é o
         servidor, e a recusa é erro do campo, não nota do máximo */
      addressProblem = state.addressError.text;
    }
    if (amount > 0 && amount < DUST_SATS) {
      amountProblem = 'valor abaixo do mínimo: ' + fmtBtc(DUST_SATS);
    } else if (state.limits) {
      hintText = 'máximo ' + fmtBtc(max);
      if (amount > 0 && max < DUST_SATS) {
        amountProblem = 'saldo insuficiente para enviar com essa taxa.';
      } else if (amount > max) {
        amountProblem = 'valor acima do máximo enviável: ' + fmtBtc(max);
      }
    } else if (state.limitsError) {
      hintText = 'máximo indisponível: ' + state.limitsError;
    } else if (amount > 0 && !addressProblem && addressLooksValid(address)) {
      hintText = 'calculando a taxa…';
    }

    /* O erro fica no recado geral (VG-FRM-07), não sob o campo: o hint
       continua só com o dado neutro, e o campo recebe o fio e o aria-invalid.
       Destino inválido também tira o PSBT da tela: o retrato é do pedido que
       o gerou, e não há o que baixar com um destino que o servidor recusa. */
    if (addressProblem && state.psbt) dropPsbt();
    setFieldInvalid(addressInput, !!addressProblem);
    setFieldInvalid(amountInput, !!amountProblem);
    if (addressInput) addressInput.setAttribute('aria-describedby', 'send-status');
    if (amountInput) {
      amountInput.setAttribute('aria-describedby', amountProblem ? 'send-status' : 'send-amount-hint');
    }
    if (hint) hint.textContent = hintText;
    setSendValidation(addressProblem || amountProblem);

    var ready = !addressProblem && !amountProblem && !!amount && amount >= DUST_SATS &&
      addressLooksValid(address) && feeRateOk(rate) &&
      !!state.limits && max >= DUST_SATS && amount <= max;
    state.sendBlocked = !ready;
    syncDownloadButton();
    updateFeeVisibility(addressProblem);
    /* o custo de cada nível depende do valor, do destino e do preview que
       acabou de mudar; é o único lugar em que todos os três se encontram */
    renderFeeLine();
    /* formulário completo: o PSBT se monta sozinho, com o respiro da
       digitação (é aqui que destino, valor, taxa e máximo se encontram) */
    schedulePsbt();
  }

  /* O seletor de taxa só aparece quando há valor e destino válidos: é quando
     o preview consegue cotar cada nível em BTC. Sem os dois, a escolha não
     teria custo para mostrar; destino recusado também esconde o grupo. */
  function updateFeeVisibility(addressProblem) {
    var section = $('#fee-section');
    if (!section) return;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    section.hidden = !!addressProblem || !(amount > 0 && addressLooksValid(address));
  }

  /* O máximo depende do destino (tamanho do script) e da taxa. A consulta é
     curta, no mesmo Worker/sessão do envio, e o resultado vira o limite que
     bloqueia o botão antes de qualquer tentativa. */
  /* `keep` mantém o limite já carregado enquanto só o valor mudou: o máximo
     continua bloqueando o botão e a legenda troca para "calculando a taxa…". */
  function scheduleLimits(keep) {
    if (state.limitsTimer) clearTimeout(state.limitsTimer);
    state.limitsTimer = 0;
    state.limitsSeq++;
    if (!keep) {
      state.limits = null;
      state.limitsError = '';
    }
    updateSendAvailability();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    var rate = feeRateNow();
    var amount = amountSats();
    if (!state.xpub || !addressLooksValid(address) || !feeRateOk(rate)) return;
    if (keep && !amount) return;
    state.limitsTimer = setTimeout(function () {
      state.limitsTimer = 0;
      loadLimits(address, rate, amount);
    }, 350);
  }

  async function loadLimits(address, rate, amount) {
    var seq = ++state.limitsSeq;
    var xpub = state.xpub;
    var body = { xpub: xpub, address: address, fee_rate: rate, preview: true };
    if (amount > 0) body.amount_sats = amount;
    /* A taxa vai também em `quote_rates` para o servidor devolver o custo
       dela em sats para o valor digitado, na mesma seleção de entradas. */
    if (rate > 0) body.quote_rates = [rate];
    if (state.session) body.session = state.session;
    try {
      var r = await fetch('/api/psbt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      if (seq !== state.limitsSeq || state.xpub !== xpub) return;
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (!Number.isInteger(j.max_send_sats)) throw new Error('resposta sem limite de envio');
      state.limits = j;
      state.limitsError = '';
      state.addressError = null; // destino aceito
      /* as cotas dos níveis dependem só do valor e do destino: guardadas à
         parte, as opções não piscam para `—` quando só a taxa muda */
      if (Array.isArray(j.quotes)) {
        var byRate = {};
        j.quotes.forEach(function (q) { byRate[q.fee_rate] = q.fee_sats; });
        state.feeQuotes = { amount: j.amount_sats, address: j.recipient, byRate: byRate };
      }
    } catch (e) {
      if (seq !== state.limitsSeq) return;
      state.limits = null;
      state.feeQuotes = null; // sem confirmação do servidor, as opções ficam em —
      var message = e && e.message ? e.message : String(e);
      /* Destino recusado na validação do servidor (checksum, rede, tipo) é
         erro de campo: vai para o recado, com o fio no campo, e não para a
         nota do máximo, que continua só com o dado neutro. */
      var rejected = /^endereço de destino:\s*(.+)$/.exec(message);
      if (rejected) {
        state.addressError = {
          address: address,
          text: 'destino inválido: ' + rejected[1].replace(/\.$/, '') + '.'
        };
        state.limitsError = '';
      } else {
        state.addressError = null;
        state.limitsError = message;
      }
    }
    updateSendAvailability();
  }

  /* Não há opção para desenhar: a seção só precisa refletir a taxa única do
     momento — a linha de custo e o aviso de piso de relay. */
  function renderFees() {
    renderFeeLine();
    renderFeeNote();
  }

  /* Aviso do piso de relay: `/api/fees` marca em `floored.next` a taxa que
     está abaixo do piso padrão do Bitcoin Core (`relay_min_kvb`, 0,1 sat/vB
     desde a v30). A taxa continua sendo a estimada — quem decide é o
     servidor —, mas o recado é o que faltava: abaixo do piso a transação
     pode não ser aceita pelos nós, e o pior caso é propagar para alguns e
     ficar parada indefinidamente. */
  function renderFeeNote() {
    var note = $('#fee-note');
    if (!note) return;
    var fees = state.fees || {};
    var rate = feeRateNow();
    if (!(fees.floored || {}).next || !(rate > 0)) {
      note.textContent = '';
      return;
    }
    var relay = Number(fees.relay_min_kvb);
    var relayText = relay > 0 ? String(relay / 1000).replace('.', ',') + ' sat/vB' : 'o piso padrão';
    note.textContent = '[ atenção ] taxa de ' + rate.toFixed(2).replace('.', ',') +
      ' sat/vB, abaixo do piso de relay padrão (' + relayText +
      '): a transação pode ser recusada pelos nós.';
  }

  /* Custo da taxa única para o valor que está no formulário. Só vale quando
     o preview respondeu para o mesmo valor e o mesmo destino; fora disso a
     linha fica só com a taxa, sem o percentual. */
  function feeQuotes() {
    var cached = state.feeQuotes;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    if (!cached || !(amount > 0) || cached.amount !== amount ||
      cached.address !== address) return {};
    return cached.byRate;
  }

  function renderFeeLine() {
    var line = $('#fee-line');
    if (!line) return;
    var rate = feeRateNow();
    if (!(rate > 0)) { line.textContent = ''; return; }
    var fee = feeQuotes()[rate];
    var amount = amountSats();
    line.textContent = 'taxa ' + String(rate).replace('.', ',') + ' sat/vB' +
      (fee > 0 && amount > 0 ? ' · ' + fmtPercent(fee, amount) + '%' : '');
  }

  /* Taxa ao vivo: a rota usa a conexão da sessão quando ela existe e o
     Worker abre uma consulta avulsa quando não existe (dev/testes). */
  async function loadFees() {
    if (!state.xpub) return;
    var xpub = state.xpub;
    var url = '/api/fees' + (state.session ? '?session=' + encodeURIComponent(state.session) : '');
    try {
      var r = await fetch(url);
      var j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (!j.levels) throw new Error('resposta sem níveis de taxa');
      if (state.xpub !== xpub) return;
      var before = feeRateNow();
      state.fees = j;
      renderFees(); // normaliza a escolha e esconde os níveis de taxa repetida
      /* taxa escolhida mudou: o máximo é recalculado sem manter o antigo.
         Só os níveis mudaram: mantém o máximo e refaz as cotas das opções. */
      if (!state.limits || feeRateNow() !== before) scheduleLimits();
      else scheduleLimits(true);
    } catch (e) {
      renderFees();
    }
  }

  function stopFeeTimer() {
    if (state.feeTimer) clearInterval(state.feeTimer);
    state.feeTimer = 0;
  }

  function startFeeTimer() {
    stopFeeTimer();
    state.feeTimer = setInterval(function () {
      if (!document.hidden) loadFees();
    }, 60000);
  }

  /* Qualquer mudança no formulário vence o pedido em voo: a resposta que
     chegar de um retrato antigo é descartada pela sequência. O retrato já
     desenhado NÃO sai da tela quando só valor ou taxa mudam: o bloco do
     PSBT é alto, e removê-lo a cada tecla encolhia a página e mexia no topo
     e no rodapé. Ele fica visível, marcado como antigo (`psbtStale`, download
     bloqueado), até a resposta do formulário novo o substituir. O destino é a
     exceção: `dropPsbt` tira o retrato, porque o endereço mostrado não pode
     ficar na tela depois de o campo mudar. A montagem agendada não é
     cancelada aqui: quando ela disparar, a chave e o `psbtReady` já são os do
     formulário novo (e fora do intervalo válido ela não monta nada). */
  function invalidatePsbt() {
    state.psbtSeq++;
    state.sendBusy = false;
    if (state.psbtPending) {
      state.psbtPending = false;
      state.psbtPendingKey = '';
      setSendStatus('', ''); // a frase de "montando" não sobrevive à edição
    }
    state.psbtKey = '';
    state.psbtFailKey = ''; // edição é o gatilho para tentar de novo
    if (!state.psbt) return;
    state.psbtStale = true;
    var out = $('#send-out');
    if (out) {
      out.removeAttribute('aria-busy');
      out.setAttribute('data-stale', 'true');
    }
    /* A edição pode ter chegado antes de o formulário ficar inválido (o
       `updateSendAvailability` roda antes daqui e ainda via o retrato como
       atual): o download precisa cair já, sem esperar a próxima rodada — que
       pode não vir, porque um valor apagado não monta PSBT nenhum. */
    syncDownloadButton();
  }

  /* O retrato antigo continua na tela, mas não pode ser baixado enquanto o
     formulário já não é o que o gerou (`aria-disabled` é o que o CSS desenha
     como inativo). */
  function syncDownloadButton() {
    var btn = $('#send-download');
    if (!btn) return;
    if (state.psbt && !state.psbtStale) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  }

  /* O retrato sai da tela quando o destino muda: o PSBT é do pedido que o
     gerou, e o valor/taxa antigos continuam visíveis de propósito. */
  function dropPsbt() {
    invalidatePsbt();
    state.psbt = null;
    state.psbtStale = false;
    var out = $('#send-out');
    if (out) {
      out.hidden = true;
      out.removeAttribute('aria-busy');
      out.removeAttribute('data-stale');
    }
  }

  function resetSend() {
    dropPsbt();
    state.sendBusy = false;
    state.fees = null;
    state.feeQuotes = null;
    state.amountDigits = '';
    state.limits = null;
    state.limitsError = '';
    state.addressError = null;
    state.limitsSeq++;
    if (state.limitsTimer) clearTimeout(state.limitsTimer);
    state.limitsTimer = 0;
    stopFeeTimer();
    ['#send-address'].forEach(function (sel) {
      var el = $(sel);
      if (el) el.value = '';
    });
    var amount = $('#send-amount');
    if (amount) amount.value = '';
    state.sendValidationError = '';
    setFieldInvalid($('#send-address'), false);
    setFieldInvalid($('#send-amount'), false);
    setSendStatus('', '');
    renderFees();
    renderAmountInput();
  }

  /* Os detalhes do PSBT usam o mesmo desenho de leitura do "receber":
     uma tabela de rótulo e valor. O resumo é o que o SERVIDOR diz ter
     montado: o navegador não lê o base64, então esta tabela é conveniência,
     não prova. O pagamento e o troco aparecem em par — valor e endereço —,
     para comparar com o formulário agora e com a revisão do Cofre BTC
     antes de assinar; uma divergência entre o que foi montado e o que está
     digitado vira aviso (o caso clássico é o coordenador trocar o endereço
     de destino). */
  function renderSendMeta(j) {
    var values = {
      '#send-meta-txid': j.txid,
      '#send-meta-vsize': '~' + fmtInt(j.vsize) + ' vB',
      '#send-meta-rbf': rbfText(j.rbf),
      '#send-meta-scheduled': scheduledText(j.locktime)
    };
    Object.keys(values).forEach(function (sel) {
      var el = $(sel);
      if (el) el.textContent = values[sel];
    });
    /* A marcação de valor do sistema (VG-COR-16) fica só nas linhas de valor,
       com o sinal no texto e a cor reforçando: o que sai leva `-`, o que volta
       leva `+`. Cada valor leva também, depois do separador `|`, a fatia que
       representa do saldo da conta (`sharePct`), em --dim: a mesma base para
       as três linhas, para a tabela ler como um recorte do saldo. A taxa
       sobre o valor enviado é outra pergunta e fica só no seletor de taxa.
       A taxa aparece sem o pó, que vem logo abaixo com `-`: a soma das duas é
       o que o PSBT paga (`fee_sats`). */
    var outValue = $('#send-meta-out-value');
    if (outValue) outValue.innerHTML = j.recipient ? signedBtcShare(j.recipient.value, 'out') : '';
    /* O destino externo leva o marcador no próprio endereço, no mesmo tom do
       "[ atenção ]" do Cofre BTC; o destino da própria carteira
       (`recebimento`) e o troco seguem como texto puro. */
    var outAddress = $('#send-meta-out-address');
    if (outAddress) {
      var external = !!j.recipient && (j.outputs || []).some(function (out) {
        return out.address === j.recipient.address && out.own === 'externo';
      });
      outAddress.textContent = j.recipient ? j.recipient.address : '';
      if (external) {
        outAddress.appendChild(document.createTextNode(' '));
        var externalMark = document.createElement('span');
        externalMark.className = 'review-external';
        externalMark.textContent = '[ externo ]';
        outAddress.appendChild(externalMark);
      }
    }
    var changeValue = $('#send-meta-change-value');
    if (changeValue) changeValue.innerHTML = j.change ? signedBtcShare(j.change.value, 'in') : '';
    var changeAddress = $('#send-meta-change-address');
    if (changeAddress) changeAddress.textContent = j.change ? j.change.address : '';
    [$('#send-meta-change-value-row'), $('#send-meta-change-address-row')]
      .forEach(function (row) { if (row) row.hidden = !j.change; });
    /* O pó é a parte do resto que não virou troco e a transação soma à taxa:
       a linha `taxa` mostra a tarifa sem ele e a linha seguinte o desconta. */
    var dust = Number(j.dust_sats) || 0;
    var fee = $('#send-meta-fee');
    if (fee) fee.innerHTML = signedBtcShare((Number(j.fee_sats) || 0) - dust, 'out');
    var dustRow = $('#send-meta-dust-row');
    if (dustRow) dustRow.hidden = !(dust > 0);
    var dustCell = $('#send-meta-dust');
    if (dustCell) dustCell.innerHTML = dust > 0 ? signedBtcShare(dust, 'out') : '';

    /* Divergência entre o PSBT e o formulário. Não é prova de nada (o
       servidor pode mentir igual nos dois), mas pega troca acidental, bug e
       coordenador que não devolve o que recebeu. */
    var warn = [];
    var typedAddress = $('#send-address') ? $('#send-address').value.trim() : '';
    if (j.recipient && j.recipient.address !== typedAddress) {
      warn.push('o destino no psbt difere do campo de destino');
    }
    if (j.recipient && Number(j.recipient.value) !== amountSats()) {
      warn.push('o valor no psbt difere do campo de quantidade');
    }
    var externos = (j.outputs || []).filter(function (out) { return out.own === 'externo'; });
    if (externos.length > 1) warn.push('o psbt tem ' + externos.length + ' saídas externas');
    /* Gasto encadeado: a entrada é o troco de uma transação nossa que ainda
       não confirmou. É permitido e é o que evita o saldo zerado, mas a nova
       transação só confirma depois (e junto) da anterior. */
    var pendentes = (j.inputs || []).filter(function (inp) { return inp.pending; });
    if (pendentes.length) {
      warn.push(pendentes.length === 1
        ? 'o psbt gasta troco pendente de uma transação sua; ela confirma depois da anterior'
        : 'o psbt gasta ' + pendentes.length + ' saídas pendentes de transações suas; elas confirmam depois das anteriores');
    }
    var warnEl = $('#send-meta-warn');
    if (warnEl) {
      warnEl.textContent = warn.length
        ? '[ atenção ] ' + warn.join('; ') + '.'
        : '';
    }
  }

  /* O PSBT é um retrato do formulário: assim que destino, valor e taxa
     formam um pedido válido, ele é montado sozinho e remontado a cada
     mudança. A chave identifica o pedido (destino, valor e taxa) para não
     refazer o mesmo PSBT quando só o máximo ou as cotas foram recalculados;
     a sequência descarta a resposta de um retrato que já não está na tela.
     Fora do intervalo válido nada é montado: o aviso fica na nota do valor. */
  function psbtKey() {
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    return address + '|' + amountSats() + '|' + feeRateNow();
  }

  function psbtReady() {
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    return amount >= DUST_SATS && addressLooksValid(address) &&
      feeRateOk(feeRateNow()) &&
      !!state.limits && Number(state.limits.max_send_sats) >= DUST_SATS &&
      amount <= Number(state.limits.max_send_sats);
  }

  function schedulePsbt() {
    if (state.psbtTimer) clearTimeout(state.psbtTimer);
    state.psbtTimer = 0;
    if (!psbtReady()) return;
    var key = psbtKey();
    if (state.psbt && state.psbtKey === key) return;
    /* um pedido que já falhou não se repete sozinho: sem esta marca, o
       `updateSendAvailability` do fim da tentativa agendaria outra, e o
       erro do servidor viraria uma consulta a cada 300 ms. A próxima
       edição (ou taxa nova) muda a chave e libera a tentativa. */
    if (state.psbtFailKey && state.psbtFailKey === key) return;
    state.psbtTimer = setTimeout(function () {
      state.psbtTimer = 0;
      buildPsbt();
    }, 300);
  }

  async function buildPsbt() {
    if (!psbtReady()) return;
    var key = psbtKey();
    if (state.psbt && state.psbtKey === key) return;
    if (state.psbtPending && state.psbtPendingKey === key) return;
    var seq = ++state.psbtSeq;
    var amount = amountSats();
    var address = $('#send-address').value.trim();
    var rate = feeRateNow();
    // No primeiro retrato a frase de "montando" ocupa a linha reservada; numa
    // remontagem o retrato anterior fica na tela, então a linha não muda de
    // altura (era ela que empurrava o rodapé a cada mudança).
    var hasOld = !!state.psbt && !!$('#send-out') && !$('#send-out').hidden;
    // o retrato na tela já não é o deste pedido (a taxa pode ter mudado
    // sozinha): ele fica visível, mas sem download até a resposta nova
    if (hasOld && state.psbtKey !== key) {
      state.psbtStale = true;
      $('#send-out').setAttribute('data-stale', 'true');
      syncDownloadButton();
    }
    state.sendBusy = true;
    state.psbtPending = true;
    state.psbtPendingKey = key;
    if (hasOld) $('#send-out').setAttribute('aria-busy', 'true');
    if (!hasOld) setSendStatus('', 'montando o psbt...');
    try {
      var xpub = state.xpub;
      var body = { xpub: xpub, address: address, amount_sats: amount, fee_rate: rate };
      if (state.session) body.session = state.session;
      var r = await fetch('/api/psbt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      // sessão do Durable Object caiu: reenvia a xpub (a tela já tem o dado)
      // e tenta uma vez com a sessão nova
      if (r.status === 409) {
        await load(true);
        if (state.xpub !== xpub) throw new Error('a carteira mudou; tente de novo.');
        if (!state.session) throw new Error('sessão expirada; recarregue a carteira.');
        body.session = state.session;
        r = await fetch('/api/psbt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        j = await r.json();
      }
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      // o formulário mudou enquanto o servidor montava: este retrato venceu
      if (seq !== state.psbtSeq || key !== psbtKey()) return;
      state.psbt = j;
      state.psbtKey = key;
      state.psbtStale = false;
      state.psbtFailKey = '';
      renderSendMeta(j);
      var out = $('#send-out');
      out.hidden = false;
      out.removeAttribute('aria-busy');
      out.removeAttribute('data-stale');
      // sem recado de sucesso: o download e os detalhes na tela confirmam
      // (a frase de "montando" não pode ficar parada embaixo do resultado)
      setSendStatus('', '');
      updateScroll();
    } catch (e) {
      if (seq !== state.psbtSeq) return;
      state.psbtFailKey = key;
      setSendStatus('error', e && e.message ? e.message : String(e));
    } finally {
      if (seq === state.psbtSeq) {
        state.psbtPending = false;
        state.psbtPendingKey = '';
        state.sendBusy = false;
        var panel = $('#send-out');
        if (panel) panel.removeAttribute('aria-busy');
        updateSendAvailability();
      }
    }
  }

  function downloadPsbtText(text, name) {
    if (!text) return;
    var blob = new Blob([text], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function downloadPsbt() {
    if (!state.psbt || state.psbtStale) return;
    downloadPsbtText(state.psbt.psbt,
      'psbt-' + String(state.psbt.txid || 'psbt').slice(0, 8) + '.psbt');
  }

  /* ------------------------------ transmitir o psbt assinado (Cofre BTC) */
  /* O arquivo volta assinado do Cofre BTC. Escolher o arquivo NÃO
     transmite: o servidor confere o PSBT contra esta carteira (entrada que
     não é sua, valor inventado, entrada não finalizada, taxa fora do padrão)
     e devolve o resumo; publicar é o clique em confirmar, porque a
     transmissão não tem volta. O texto do arquivo fica só na memória da
     tela, como o PSBT do envio. */
  var BROADCAST_MAX_TEXT = 400000;

  function setBroadcastStatus(kind, text) {
    setStatusTo($('#broadcast-status'), kind, text);
  }

  function updateBroadcastActions() {
    var send = $('#broadcast-send');
    var clear = $('#broadcast-clear');
    var sep = $('#broadcast-sep');
    var pick = $('#broadcast-import');
    var hasFile = !!state.broadcastName;
    var loaded = !!state.broadcast;
    var sent = !!state.broadcastSent;
    /* Escolhido o arquivo, o seletor some e quem age é o cancelar (ou o
       confirmar, com o resumo na tela); o cancelar traz o seletor de volta.
       O separador só existe entre o cancelar e o confirmar. */
    if (pick) pick.hidden = hasFile;
    if (send) {
      send.hidden = !loaded;
      if (loaded && !sent && !state.broadcastBusy) send.removeAttribute('aria-disabled');
      else send.setAttribute('aria-disabled', 'true');
      send.textContent = sent ? 'transmitida' : 'confirmar';
    }
    var showClear = hasFile && !sent;
    if (clear) clear.hidden = !showClear;
    if (sep) sep.hidden = !(showClear && loaded);
    /* Sem nenhum controle à vista, o grupo sai do fluxo: um .chips vazio
       ainda somaria o app-gap e deixaria uma faixa em branco abaixo do
       seletor, que a seta de rolagem anunciava como conteúdo. */
    var actions = $('#broadcast-actions');
    if (actions) actions.hidden = !(showClear || loaded);
  }

  function resetBroadcast() {
    state.broadcastSeq++;
    state.broadcast = null;
    state.broadcastText = '';
    state.broadcastName = '';
    state.broadcastBusy = false;
    state.broadcastSent = false;
    var out = $('#broadcast-out');
    if (out) {
      out.hidden = true;
      out.removeAttribute('aria-busy');
    }
    var block = $('#broadcast-import-block');
    if (block) block.removeAttribute('aria-busy');
    var file = $('#broadcast-file');
    if (file) file.value = '';
    setBroadcastStatus('', '');
    updateBroadcastActions();
  }

  function broadcastCell(sel, text) {
    var el = $(sel);
    if (el) el.textContent = text == null ? '—' : text;
  }

  /* Linha do resumo do transmitir, no desenho do resumo do PSBT: rótulo na
     coluna e valor na outra. `groupEnd` fecha o par, abrindo o vão do
     próximo. */
  function broadcastMetaRow(label, groupEnd) {
    var tr = document.createElement('tr');
    if (groupEnd) tr.className = 'group-end';
    var th = document.createElement('th');
    th.setAttribute('scope', 'row');
    th.textContent = label;
    var td = document.createElement('td');
    tr.appendChild(th);
    tr.appendChild(td);
    return { tr: tr, td: td };
  }

  /* O resumo é do servidor: cada saída classificada a partir dos scripts da
     carteira, e a taxa da transação FINAL (vsize real, não a estimada do
     envio). Cada saída vira um par saída/destino ou troco/endereço, na ordem
     da transação — o mesmo desenho do resumo do PSBT, sem somar valores nem
     juntar endereços. */
  function renderBroadcast(j) {
    broadcastCell('#broadcast-meta-file', state.broadcastName || '—');
    broadcastCell('#broadcast-meta-txid', j.txid);
    broadcastCell('#broadcast-meta-vsize', fmtInt(j.vsize) + ' vB');
    broadcastCell('#broadcast-meta-rbf', rbfText(j.rbf));
    broadcastCell('#broadcast-meta-scheduled', scheduledText(j.locktime));
    var fee = $('#broadcast-meta-fee');
    if (fee) fee.innerHTML = signedBtcShare(j.fee_sats, 'out');

    var metaBody = $('#broadcast-meta tbody');
    var feeRow = $('#broadcast-meta-fee-row');
    if (metaBody && feeRow) {
      Array.prototype.forEach.call(
        metaBody.querySelectorAll('tr[data-broadcast-output]'),
        function (tr) { metaBody.removeChild(tr); }
      );
      (j.outputs || []).forEach(function (out) {
        var change = out.own === 'troco';
        var value = broadcastMetaRow(change ? 'troco' : 'saída');
        value.td.innerHTML = signedBtcShare(out.value, change ? 'in' : 'out');
        value.tr.setAttribute('data-broadcast-output', '');
        metaBody.insertBefore(value.tr, feeRow);
        /* O destino externo leva o marcador no próprio endereço, no tom do
           "[ atenção ]"; as saídas da carteira seguem como texto puro. */
        var address = broadcastMetaRow(change ? 'endereço' : 'destino', true);
        if (out.own === 'externo') {
          address.td.innerHTML = esc(out.address || '—') +
            ' <span class="review-external">[ externo ]</span>';
        } else {
          address.td.textContent = out.address || '—';
        }
        address.tr.setAttribute('data-broadcast-output', '');
        metaBody.insertBefore(address.tr, feeRow);
      });
    }
    var warn = $('#broadcast-warn');
    var warnings = j.warnings || [];
    if (warn) warn.textContent = warnings.length ? '[ atenção ] ' + warnings.join('; ') : '';
    var out = $('#broadcast-out');
    if (out) {
      out.hidden = false;
      out.removeAttribute('aria-busy');
    }
    updateScroll();
  }

  async function importSignedPsbt(file) {
    if (!file) return;
    var seq = ++state.broadcastSeq;
    state.broadcast = null;
    state.broadcastText = '';
    state.broadcastSent = false;
    state.broadcastName = file.name || 'psbt assinado';
    state.broadcastBusy = true;
    var out = $('#broadcast-out');
    if (out) out.hidden = true;
    var block = $('#broadcast-import-block');
    if (block) block.setAttribute('aria-busy', 'true');
    updateBroadcastActions();
    setBroadcastStatus('', 'conferindo o psbt...');
    try {
      var text = await file.text();
      if (seq !== state.broadcastSeq) return;
      if (!text.trim()) throw new Error('o arquivo está vazio');
      if (text.length > BROADCAST_MAX_TEXT) throw new Error('psbt grande demais');
      if (!state.xpub) throw new Error('carregue a carteira antes de escolher o arquivo');
      state.broadcastText = text;
      var body = { xpub: state.xpub, psbt: text, preview: true };
      if (state.session) body.session = state.session;
      var r = await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (seq !== state.broadcastSeq) return;
      state.broadcast = j;
      renderBroadcast(j);
      /* O resumo na tela já diz que o arquivo conferiu: sem legenda de
         sucesso, só a falha ganha recado. */
      setBroadcastStatus('', '');
    } catch (e) {
      if (seq !== state.broadcastSeq) return;
      state.broadcast = null;
      state.broadcastText = '';
      /* Arquivo recusado é descartado: sem o "cancelar" pendurado, o
         seletor volta na hora e a próxima escolha é um clique só. */
      state.broadcastName = '';
      var panel = $('#broadcast-out');
      if (panel) panel.hidden = true;
      setBroadcastStatus('error', e && e.message ? e.message : String(e));
    } finally {
      if (seq === state.broadcastSeq) {
        state.broadcastBusy = false;
        var blk = $('#broadcast-import-block');
        if (blk) blk.removeAttribute('aria-busy');
        updateBroadcastActions();
        updateScroll();
      }
    }
  }

  async function transmitSignedPsbt() {
    if (!state.broadcast || !state.broadcastText || state.broadcastBusy || state.broadcastSent) return;
    var seq = ++state.broadcastSeq;
    state.broadcastBusy = true;
    updateBroadcastActions();
    setBroadcastStatus('', 'transmitindo...');
    var body = { xpub: state.xpub, psbt: state.broadcastText };
    if (state.session) body.session = state.session;
    try {
      var r = await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (seq !== state.broadcastSeq) return;
      state.broadcast = j;
      state.broadcastSent = true;
      state.broadcastText = '';
      renderBroadcast(j);
      setBroadcastStatus('ok', 'transação transmitida: ' + (j.txid || ''));
    } catch (e) {
      if (seq !== state.broadcastSeq) return;
      setBroadcastStatus('error', e && e.message ? e.message : String(e));
    } finally {
      if (seq === state.broadcastSeq) {
        state.broadcastBusy = false;
        updateBroadcastActions();
      }
    }
  }

  /* Linha de valor com sinal (VG-COR-16): o sinal vai no texto e a cor só
     reforça; o zero não tem direção e fica no --dim da linha. */
  function signedBtc(sats, dir) {
    var n = Number(sats) || 0;
    if (!n) return '<span class="value-none">' + fmtBtc(0) + '</span>';
    return '<span class="value-' + dir + '">' + (dir === 'in' ? '+' : '-') + fmtBtc(n) + '</span>';
  }

  /* Linha "pendente" da carteira: mostra só o que ainda não está no saldo
     disponível — entrada de terceiro que só conta depois de confirmar e o que
     já saiu de fato numa transação pendente (o troco que volta já está no
     total, por isso não aparece aqui). Com o sinal e a cor da direção
     (VG-COR-16); sem pendência, a linha não existe. */
  function pendingValues(pin, pout) {
    var parts = [];
    if (Number(pin) > 0) {
      parts.push('<span class="value-label">entrada</span> ' + signedBtc(pin, 'in'));
    }
    if (Number(pout) > 0) {
      parts.push('<span class="value-label">saída</span> ' + signedBtc(pout, 'out'));
    }
    if (!parts.length) return '';
    return '<span class="value-label">pendente</span> ' +
      parts.join(' <span class="value-sep" aria-hidden="true">|</span> ');
  }

  /* Percentual de uma linha de valor sobre o saldo total da conta — o mesmo
     número da tela da carteira, que é do que o envio é uma fatia —, precedido
     do separador `|` (o mesmo divisor das linhas de dados do extrato). Uma
     base só para todas as linhas da tabela: a taxa sobre o valor enviado é
     outra pergunta e tem lugar próprio, o seletor de taxa. As casas seguem o
     tamanho: uma casa no valor grande (25.4%), duas no médio e três no
     pequeno; abaixo de 0.001% o piso `<0.001%` diz que é pequeno sem fingir
     precisão. Sem saldo conhecido, nenhuma linha ganha percentual. */
  function sharePct(sats) {
    var b = state.data && state.data.balance;
    var total = b ? Number(b.total) || 0 : 0;
    if (!(total > 0)) return '';
    var pct = (Number(sats) || 0) / total * 100;
    if (!isFinite(pct) || pct <= 0) {
      return ' <span class="value-sep" aria-hidden="true">|</span> <span class="value-pct">0%</span>';
    }
    var text = pct >= 10 ? pct.toFixed(1)
      : pct >= 1 ? pct.toFixed(2)
      : pct.toFixed(3);
    if (text === '0.000') text = '<0.001';
    return ' <span class="value-sep" aria-hidden="true">|</span> <span class="value-pct">' + text + '%</span>';
  }

  /* Valor com sinal seguido da fatia sobre o saldo (resumo do PSBT): o
     percentual completa a legenda, não compete com o valor. */
  function signedBtcShare(sats, dir) {
    return signedBtc(sats, dir) + sharePct(sats);
  }

  /* Extrato (VG-LST-01): um item por transação, agrupado pelo txid, na
     ordem que o servidor manda — mempool primeiro e depois o bloco mais
     recente. O txid é o título, as entradas/saídas viram contagem e os
     endereços da carteira que participam da transação ficam na linha de
     apoio. A transação pendente que tem saída própria não gasta ganha a
     ação "acelerar" (CPFP). */
  function historyRows() {
    return (state.data && state.data.transactions) || [];
  }

  function historyPerPageCount() {
    return historyPerPage > 0 ? historyPerPage : PER_PAGE_FALLBACK;
  }

  function historyPages() {
    return Math.max(1, Math.ceil(historyRows().length / historyPerPageCount()));
  }

  function historySeparatorNode() {
    var sep = document.createElement('li');
    sep.className = 'rule-dots';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  }

  /* Mede quantos itens cabem entre o topo da lista e o fim da área que rola.
     As posições são relativas à própria lista, então a rolagem e a entrada
     em foco não mudam o resultado. Abaixo do piso do card a página inteira
     rola (VG-LAY-12) e a referência passa a ser a altura da janela. */
  function fitHistoryItems(rows) {
    var list = $('#history-list');
    var sc = $('#content-scroll');
    var page = $('.page');
    if (!list || !sc || list.hidden) return 0;
    var pageScroll = !!page && page.classList.contains('is-page-scroll');
    var listRect = list.getBoundingClientRect();
    /* na rolagem única a página inteira rola, então a página da lista vale
       uma tela de itens; prender a sobra abaixo do cabeçalho deixaria uma ou
       duas linhas por página em telas baixas. */
    var limit = pageScroll
      ? window.innerHeight
      : sc.clientHeight - (listRect.top - sc.getBoundingClientRect().top + sc.scrollTop);
    // pelo menos um item por página, mesmo quando o cabeçalho ocupa tudo
    if (!(limit > 1)) return 1;
    list.innerHTML = '';
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      if (i) list.appendChild(historySeparatorNode());
      var li = historyItemNode(rows[i]);
      list.appendChild(li);
      /* o respiro do último parágrafo do item escapa da caixa do <li> (não há
         borda nem padding que o segure) e entra na sobra da rolagem: contá-lo
         evita que a página preencha até o último pixel e o paginador só
         apareça depois de rolar alguns pixels. */
      var tail = li.lastElementChild;
      var tailGap = tail ? parseFloat(getComputedStyle(tail).marginBottom) || 0 : 0;
      if (li.getBoundingClientRect().bottom - listRect.top + tailGap > limit) {
        list.removeChild(li);
        if (i) list.removeChild(list.lastChild);
        break;
      }
      count = i + 1;
    }
    return count || 1;
  }

  function renderHistory() {
    var list = $('#history-list');
    if (!list) return;
    var rows = historyRows();
    var screen = $('#screen-historico');
    /* a medida só vale com a tela e a lista à vista: dados chegando enquanto
       a carteira está aberta não podem trocar o número de itens. */
    if (state.data && rows.length && state.historyState === 'ready' &&
        screen && !screen.hidden && !list.hidden) {
      var fits = fitHistoryItems(rows);
      if (fits > 0) historyPerPage = fits;
    }
    // sem dados, a página pedida pelo endereço espera a resposta; com dados,
    // um número fora do intervalo cai na última sem reescrever o endereço
    // (VG-MET-10).
    if (state.data) {
      var pages = historyPages();
      if (state.page > pages) state.page = pages;
      if (state.page < 1) state.page = 1;
    }
    var perPage = historyPerPageCount();
    var start = (state.page - 1) * perPage;
    list.innerHTML = '';
    rows.slice(start, start + perPage).forEach(function (a, i) {
      if (i) list.appendChild(historySeparatorNode());
      list.appendChild(historyItemNode(a));
    });
  }

  function historyItemNode(t) {
    var sep = ' <span class="tag-sep" aria-hidden="true">·</span> ';
    var status = t.pending
      ? '<span class="tag tag-pending">[ pendente ]</span>'
      : '<span class="tag">[ confirmada ]</span>';
    var direction = t.direction === 'out' ? 'enviado'
      : t.direction === 'in' ? 'recebido' : 'auto';
    var values = [];
    if (t.direction === 'in' && Number(t.received_sats) > 0) {
      values.push('<span class="value-label">recebido</span> ' + signedBtc(t.received_sats, 'in'));
    }
    if (t.direction === 'out' && Number(t.sent_sats) > 0) {
      values.push('<span class="value-label">enviado</span> ' + signedBtc(t.sent_sats, 'out'));
    }
    if (t.direction === 'self' && Number(t.received_sats) > 0) {
      values.push('<span class="value-label">auto</span> ' + fmtBtc(t.received_sats));
    }
    if (Number(t.fee_sats) > 0) {
      values.push('<span class="value-label">taxa</span> ' + signedBtc(t.fee_sats, 'out'));
    }
    var meta = status + sep + '<span class="tag">' + direction + '</span>' + sep +
      fmtInt(t.input_count) + (t.input_count === 1 ? ' entrada' : ' entradas') + sep +
      fmtInt(t.output_count) + (t.output_count === 1 ? ' saída' : ' saídas');
    var html =
      '<h3><span class="item-title is-static history-txid">' + esc(t.txid) + '</span></h3>' +
      '<p class="item-meta">' + meta + '</p>' +
      (values.length
        ? '<p class="item-meta history-values">' +
          values.join(' <span class="value-sep" aria-hidden="true">|</span> ') +
          '</p>'
        : '');
    var addrs = t.addresses || [];
    if (addrs.length) {
      var labels = { entrada: 'entrada', troco: 'troco', recebimento: 'recebimento' };
      var shown = addrs.slice(0, 2).map(function (a) {
        return '<span class="history-address">' + esc(a.address) + '</span> ' +
          '<span class="tag">' + (labels[a.role] || a.role) + '</span>';
      });
      if (addrs.length > 2) shown.push('<span class="tag">+' + (addrs.length - 2) + '</span>');
      html += '<p class="item-meta history-addresses">' + shown.join(sep) + '</p>';
    }
    if (t.cpfp && t.cpfp.eligible) {
      html += '<div class="chips history-actions" role="group" aria-label="Ações da transação">' +
        '<button type="button" data-cpfp="' + esc(t.txid) + '">acelerar</button></div>';
    } else if (t.pending && t.direction !== 'in' && t.cpfp && t.cpfp.reason) {
      html += '<p class="item-meta history-cpfp-note">[ não acelerável ] ' +
        esc(t.cpfp.reason) + '</p>';
    }
    var li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = html;
    return li;
  }

  /* Paginador mínimo (VG-LST-08): uma página por vez, com a seta fora de
     alcance em --dim e aria-disabled. Ele aparece no lugar da seta de
     rolagem quando a lista tem mais de uma página e a rolagem chega ao fim. */
  function setPagerEdge(btn, enabled) {
    if (!btn) return;
    btn.classList.toggle('is-off', !enabled);
    if (enabled) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
  }

  function updatePager(reach) {
    var pager = $('#history-pager');
    var content = $('#content');
    var screen = $('#screen-historico');
    if (!pager || !content || !screen) return;
    var pages = historyPages();
    var visible = state.historyState === 'ready' && !screen.hidden && pages > 1;
    pager.hidden = !visible;
    var el = $('#content-scroll');
    var atEnd = !el || reach <= 2 || el.scrollTop >= reach - 2;
    content.classList.toggle('show-pager', visible && atEnd);
    if (!visible) return;
    var current = $('#history-page');
    var total = $('#history-pages');
    if (current) current.textContent = String(state.page);
    if (total) total.textContent = String(pages);
    setPagerEdge($('#history-prev'), state.page > 1);
    setPagerEdge($('#history-next'), state.page < pages);
  }

  function goPage(delta) {
    var next = state.page + delta;
    if (next < 1 || next > historyPages()) return;
    state.page = next;
    renderHistory();
    syncHistoryState();
    pushScreenUrl();
    // a troca de página repete a revelação (VG-EFE-05)
    runReveal($('#screen-historico'));
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = 0;
    updateScroll();
  }

  /* A tela mudou de tamanho: mede de novo a área útil e redesenha a lista na
     mesma página, devolvendo o ponto de leitura. */
  function relayoutHistory() {
    if (state.screen !== 'historico' || state.historyState !== 'ready') return;
    var list = $('#history-list');
    var screen = $('#screen-historico');
    if (!list || !screen || screen.hidden || !historyRows().length) return;
    var sc = $('#content-scroll');
    var top = sc ? sc.scrollTop : 0;
    renderHistory();
    if (sc && top) sc.scrollTop = top;
    updateScroll();
  }

  /* ------------------------------ acelerar (CPFP) */
  function setCpfpStatus(kind, text) {
    setStatusTo($('#cpfp-status'), kind, text);
  }

  function resetCpfp() {
    state.cpfpSeq++;
    state.cpfp = null;
    var out = $('#cpfp-out');
    if (out) out.hidden = true;
    setCpfpStatus('', '');
    updateScroll();
  }

  function renderCpfp() {
    var out = $('#cpfp-out');
    var c = state.cpfp;
    if (out) out.hidden = !c;
    if (!c) return;
    var d = c.data;
    var meta = $('#cpfp-meta');
    var download = $('#cpfp-download');
    if (meta) meta.hidden = !d;
    if (download) {
      if (d) download.removeAttribute('aria-disabled');
      else download.setAttribute('aria-disabled', 'true');
    }
    if (!d) {
      ['#cpfp-parent', '#cpfp-parent-fee', '#cpfp-parent-vsize', '#cpfp-child-txid',
        '#cpfp-child-fee', '#cpfp-child-vsize', '#cpfp-package', '#cpfp-target',
        '#cpfp-return'].forEach(function (sel) {
        var el = $(sel);
        if (el) el.textContent = '—';
      });
      var warn = $('#cpfp-warn');
      if (warn) warn.textContent = '';
      if (c.status === 'loading') setCpfpStatus('', 'montando o psbt...');
      else if (c.status === 'error') setCpfpStatus('error', c.error || 'não foi possível montar o psbt.');
      updateScroll();
      return;
    }
    var rate = function (value) {
      var n = Number(value) || 0;
      return String(Math.round(n * 100) / 100).replace('.', ',');
    };
    var parent = $('#cpfp-parent');
    if (parent) parent.textContent = d.parent.txid;
    var parentFee = $('#cpfp-parent-fee');
    if (parentFee) parentFee.innerHTML = signedBtc(d.parent.fee_sats, 'out');
    var parentVsize = $('#cpfp-parent-vsize');
    if (parentVsize) parentVsize.textContent = fmtInt(d.parent.vsize) + ' vB';
    var child = $('#cpfp-child-txid');
    if (child) child.textContent = d.txid;
    var childFee = $('#cpfp-child-fee');
    if (childFee) childFee.innerHTML = signedBtc(d.fee_sats, 'out');
    var childVsize = $('#cpfp-child-vsize');
    if (childVsize) childVsize.textContent = fmtInt(d.vsize) + ' vB';
    var pkg = $('#cpfp-package');
    if (pkg) {
      pkg.innerHTML = signedBtc(d.package.fee_sats, 'out') +
        ' <span class="value-sep" aria-hidden="true">|</span> ' +
        '<span class="value-pct">' + rate(d.package.fee_rate) + ' sat/vB</span>';
    }
    var target = $('#cpfp-target');
    if (target) target.textContent = rate(d.package.target_fee_rate) + ' sat/vB';
    var ret = $('#cpfp-return');
    if (ret) {
      ret.innerHTML = signedBtc(d.output.value, 'in') +
        ' <span class="value-sep" aria-hidden="true">|</span> ' +
        '<span class="history-address">' + esc(d.output.address) + '</span>';
    }
    var warnings = [];
    if (Number(d.package.ancestors) > 0) {
      warnings.push('o pacote inclui ' + fmtInt(d.package.ancestors) + ' transação(ões) anterior(es) ainda no mempool.');
    }
    if (Array.isArray(d.warnings) && d.warnings.length) warnings = warnings.concat(d.warnings);
    var warnEl = $('#cpfp-warn');
    if (warnEl) warnEl.textContent = warnings.join(' ');
    setCpfpStatus('', 'psbt montado; baixe e assine no Cofre BTC.');
    updateScroll();
  }

  async function startCpfp(txid) {
    if (!state.xpub) return;
    var seq = ++state.cpfpSeq;
    state.cpfp = { txid: txid, status: 'loading', data: null, error: '' };
    renderCpfp();
    var panel = $('#cpfp-out');
    if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    try {
      var rate = feeRateNow();
      if (!feeRateOk(rate)) {
        await loadFees();
        rate = feeRateNow();
      }
      if (!feeRateOk(rate)) throw new Error('taxa indisponível; tente de novo.');
      var xpub = state.xpub;
      var body = { xpub: xpub, txid: txid, fee_rate: rate };
      if (state.session) body.session = state.session;
      var r = await fetch('/api/cpfp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      // sessão do Durable Object caiu: reenvia a xpub e tenta uma vez
      if (r.status === 409) {
        await load(true);
        if (state.xpub !== xpub) throw new Error('a carteira mudou; tente de novo.');
        if (!state.session) throw new Error('sessão expirada; recarregue a carteira.');
        body.session = state.session;
        r = await fetch('/api/cpfp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        j = await r.json();
      }
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      if (seq !== state.cpfpSeq || state.xpub !== xpub) return;
      state.cpfp = { txid: txid, status: 'ready', data: j, error: '' };
      renderCpfp();
    } catch (e) {
      if (seq !== state.cpfpSeq) return;
      state.cpfp = {
        txid: txid, status: 'error', data: null,
        error: e && e.message ? e.message : String(e)
      };
      renderCpfp();
    }
  }

  function downloadCpfp() {
    var d = state.cpfp && state.cpfp.data;
    if (!d || !d.psbt) return;
    downloadPsbtText(d.psbt, 'cpfp-' + String(d.txid || 'psbt').slice(0, 8) + '.psbt');
  }

  function render(d) {
    stopScan();
    state.data = d;
    var b = d.balance || {};
    var total = $('#v-total');
    total.textContent = fmtBtc(b.total);
    total.hidden = false;
    var pending = $('#v-pending');
    if (pending) {
      var pendingHtml = pendingValues(b.pending_in, b.pending_out);
      pending.innerHTML = pendingHtml;
      pending.hidden = !pendingHtml;
    }
    var updated = $('#v-updated');
    updated.textContent = d.updated_at
      ? 'atualizado ' + new Date(d.updated_at).toLocaleString('pt-BR')
      : '';
    updated.hidden = !d.updated_at;
    renderReceive(d);
    $('#v-warnings').innerHTML = (d.warnings || []).map(function (w) { return esc(w); }).join('<br>');

    var txs = d.transactions || [];
    var sum = { received: 0, sent: 0 };
    txs.forEach(function (t) {
      if (t.direction === 'in') sum.received += Number(t.received_sats) || 0;
      if (t.direction === 'out') sum.sent += Number(t.sent_sats) || 0;
    });
    var countLabel = txs.length === 1 ? 'transação' : 'transações';
    /* O resumo é a tabela de leitura da carteira (VG-ABS-04): o total de
       transações vira uma linha de dados, com o plural do rótulo pela
       contagem, e os valores repetem a marcação do extrato — rótulo em
       --dim, valor com o sinal e a cor da direção (VG-COR-16). Os valores
       zerados não viram linha. */
    var summaryRows =
      '<tr><th scope="row">' + countLabel + '</th><td>' + fmtInt(txs.length) + '</td></tr>';
    if (sum.received > 0) {
      summaryRows +=
        '<tr><th scope="row">recebido</th><td>' + signedBtc(sum.received, 'in') + '</td></tr>';
    }
    if (sum.spent > 0) {
      summaryRows +=
        '<tr><th scope="row">enviado</th><td>' + signedBtc(sum.spent, 'out') + '</td></tr>';
    }
    $('#history-summary').innerHTML =
      '<table class="data-table key-readout" aria-label="totais do histórico">' +
        '<tbody>' + summaryRows + '</tbody>' +
      '</table>';
    state.historyState = 'ready';
    syncHistoryState();
    renderHistory();
    $('#out').hidden = false;
    // saldo novo pode mudar o máximo enviável
    scheduleLimits();
    updateScroll();
  }

  /* Some com o que está na tela quando a xpub do campo deixa de ser a que
     gerou os dados: edição, apagão ou outra chave/endereço digitado. */
  function clearView() {
    if (state.timer) { clearInterval(state.timer); state.timer = 0; }
    closeWatch();
    state.xpub = '';
    state.data = null;
    var out = $('#out');
    if (out) out.hidden = true;
    // o saldo e o horário ficam fora do #out (abaixo do campo): saem da tela
    // e voltam ao travessão até a próxima consulta
    ['#v-total', '#v-pending', '#v-updated'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      el.textContent = sel === '#v-total' ? '—' : '';
      el.hidden = true;
    });
    var warnings = $('#v-warnings');
    if (warnings) warnings.textContent = '';
    var receiveBody = $('#receive-table tbody');
    if (receiveBody) receiveBody.innerHTML = '';
    var receiveTable = $('#receive-table');
    if (receiveTable) receiveTable.hidden = true;
    var receiveHeading = $('#receive-heading');
    if (receiveHeading) receiveHeading.hidden = true;
    var body = $('#history-list');
    if (body) { body.innerHTML = ''; body.hidden = true; }
    state.page = 1;
    state.historyState = 'idle';
    stopScan();
    var summary = $('#history-summary');
    if (summary) summary.textContent = 'cole a xpub, zpub ou ypub na carteira para ver o histórico.';
    resetSend();
    resetBroadcast();
    resetCpfp();
    setStatus('', '');
    syncHistoryState();
    updateScroll();
  }

  /* A tela só mostra dados da xpub que está no campo. */
  function syncViewToInput() {
    if (!state.data && !state.xpub) return;
    if ($('#xpub').value.trim() !== state.xpub) clearView();
  }

  /* A varredura longa é feita em passos: a tela mostra o progresso e pede
     o próximo passo, em vez de esperar tudo numa resposta só. */
  function scanText(progress) {
    var p = progress || {};
    var scanned = p.scanned || 0;
    return 'verificando ' + fmtInt(scanned) +
      (scanned === 1 ? ' endereço' : ' endereços');
  }

  /* `keepView` é a atualização da MESMA xpub que já está na tela (polling,
     reabertura do tempo real, sessão expirada): o retrato anterior continua
     visível e só é substituído quando a varredura termina. Sem isso, cada
     passo da busca escondia saldo, endereços e histórico, e a tela piscava
     vazia mesmo sem a chave ter mudado. */
  function showScan(progress, keepView, quiet) {
    state.scanning = true;
    // o progresso ocupa a mesma linha que anunciava a consulta; numa
    // atualização silenciosa a linha atual fica como está
    if (!keepView || !quiet) setStatus('', scanText(progress));
    var btn = $('#scan-continue');
    if (btn) btn.hidden = true;
    if (keepView) return;
    // durante a primeira busca o saldo anterior não é apresentado como final
    var total = $('#v-total');
    if (total) total.hidden = true;
    var pending = $('#v-pending');
    if (pending) pending.hidden = true;
    var updated = $('#v-updated');
    if (updated) updated.hidden = true;
    var out = $('#out');
    if (out) out.hidden = true;
    var summary = $('#history-summary');
    if (summary) summary.textContent = '';
  }

  function stopScan() {
    state.scanning = false;
    var btn = $('#scan-continue');
    if (btn) btn.hidden = true;
  }

  function scanIncomplete(message) {
    state.scanning = false;
    setStatus('error', message);
    var btn = $('#scan-continue');
    if (btn) btn.hidden = false;
    var summary = $('#history-summary');
    if (summary) summary.textContent = 'busca incompleta: ainda podem existir valores não contabilizados.';
    if (!state.data) {
      state.historyState = 'error';
      syncHistoryState();
    }
  }

  async function load(quiet) {
    var xpub = $('#xpub').value.trim();
    // nunca mostra o estado de uma xpub que não está mais no campo
    syncViewToInput();
    // mesma chave já desenhada: a busca pode correr por baixo sem limpar a tela
    var keepView = !!(state.data && state.xpub === xpub);
    var problem = xpubProblem(xpub);
    if (problem) {
      setFieldInvalid($('#xpub'), true);
      setStatus('error', problem);
      return;
    }
    setFieldInvalid($('#xpub'), false);
    if (state.busy) return;
    state.busy = true;
    stopScan();
    closeWatch();
    if (!state.data) {
      state.historyState = 'loading';
      syncHistoryState();
    }
    if (!quiet) setStatus('', scanText());
    try {
      // A xpub vai no corpo a cada consulta: o servidor não guarda nada,
      // então ela nunca fica armazenada. O session só reaproveita a conexão
      // do Durable Object enquanto esta tela estiver aberta.
      while (true) {
        var body = { xpub: xpub, scan: 'step' };
        if (state.session) body.session = state.session;
        var r = await fetch('/api/wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        // a xpub pode ter mudado enquanto a consulta corria: descarta a resposta
        if ($('#xpub').value.trim() !== xpub) return;
        state.xpub = xpub;
        state.session = j.session || '';
        if (j.scanning) {
          showScan(j.progress, keepView, quiet);
          continue;
        }
        stopScan();
        render(j);
        // a tela já mostra o resultado: o recado de "verificando" sai de cena
        // sem virar uma legenda de sucesso permanente
        setStatus('', '');
        if (j.watch) openWatch();
        else closeWatch();
        loadFees();
        startFeeTimer();
        schedule();
        break;
      }
    } catch (e) {
      if (state.scanning && state.session) {
        scanIncomplete('busca interrompida: o saldo pode estar incompleto. ' +
          (e && e.message ? e.message : String(e)));
      } else {
        setStatus('error', e && e.message ? e.message : String(e));
        if (!state.data) {
          state.historyState = 'error';
          syncHistoryState();
        }
      }
    } finally {
      state.busy = false;
    }
  }

  /* A consulta começa sozinha quando a digitação/colagem deixa a xpub
     completa e válida. O debounce curto evita
     disparar no meio de uma correção e a comparação com state.xpub evita
     reconsultar a carteira que já está na tela. */
  var AUTO_DELAY = 350;
  function scheduleAutoLoad() {
    if (state.autoTimer) { clearTimeout(state.autoTimer); state.autoTimer = 0; }
    var xpub = $('#xpub').value.trim();
    if (xpubProblem(xpub)) return;
    if (xpub === state.xpub && state.data) return;
    state.autoTimer = setTimeout(function () {
      state.autoTimer = 0;
      var current = $('#xpub').value.trim();
      if (current !== xpub || xpubProblem(current)) return;
      if (current === state.xpub && state.data) return;
      // uma consulta em andamento pode ser de outra xpub: espera terminar
      if (state.busy) { scheduleAutoLoad(); return; }
      closeWatch();
      load(false);
    }, AUTO_DELAY);
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!state.xpub) return;
      // com o tempo real aberto quem avisa é o Durable Object; o polling
      // fica só como rede de segurança, bem mais espaçado.
      if (state.watch && state.watch.readyState === 1) return;
      load(true);
    }, 30000);
  }

  /* Tempo real: o Durable Object segura a conexão Electrum e as assinaturas
     de scripthash; quando algo muda ele manda o estado novo por aqui. */
  function closeWatch() {
    if (state.watch) {
      try { state.watch.close(); } catch (e) {}
      state.watch = null;
    }
    clearWatchTimer();
  }

  function clearWatchTimer() {
    if (state.watchTimer) clearTimeout(state.watchTimer);
    state.watchTimer = 0;
  }

  /* Fechou sem abrir (409 de sessão expirada, proxy, rede): reenvia a xpub
     em /api/wallet, que refaz a varredura, e reabre o canal. */
  function retryWatch(ws) {
    if (state.watch !== ws) return;
    state.watch = null;
    clearWatchTimer();
    if (!state.xpub || document.hidden) return;
    var wait = Math.min(30000, 2000 * Math.pow(2, state.watchRetry++));
    setTimeout(function () {
      if (!state.xpub || document.hidden) return;
      // reenvia a xpub (nada fica guardado no servidor) e reabre o canal
      load(true);
    }, wait);
  }

  /* O WebSocket só leva o id da sessão (aleatório), nunca a xpub. Se o DO
     foi despejado, ele responde 409 e a reconexão reenvia a xpub. */
  function openWatch() {
    if (!state.session || !window.WebSocket) return;
    if (state.watch && (state.watch.readyState === 0 || state.watch.readyState === 1)) return;
    closeWatch();
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/api/events?session=' + encodeURIComponent(state.session)); }
    catch (e) { return; }
    state.watch = ws;
    ws.onopen = function () { state.watchRetry = 0; clearWatchTimer(); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'payload' && msg.payload) {
        render(msg.payload);
      } else if (msg.type === 'error') {
        setStatus('error', 'tempo real: ' + msg.error);
      }
    };
    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
      retryWatch(ws);
    };
    ws.onclose = function () { retryWatch(ws); };
    // handshake que não abre nem fecha não pode deixar a tela presa
    state.watchTimer = setTimeout(function () {
      state.watchTimer = 0;
      if (state.watch === ws && ws.readyState === 0) {
        try { ws.close(); } catch (e) {}
        retryWatch(ws);
      }
    }, 8000);
  }

  function wire() {
    fillFrames();
    markLanguage();
    var themeParam = themeFromUrl();
    var savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('monitor-btc-theme') || 'dark'; } catch (e) {}
    setTheme(themeParam || savedTheme, { immediate: true, save: !themeParam });

    noticeWire($('#status'));
    noticeWire($('#send-status'));

    $$('.menu button[data-screen]').forEach(function (b) {
      b.addEventListener('click', function () {
        showScreen(b.getAttribute('data-screen'));
      });
    });

    /* Link de salto (VG-ACR-07): leva o foco ao título da tela aberta, sem
       escrever no endereço. */
    var skip = $('#skip-link');
    if (skip) skip.addEventListener('click', function (ev) {
      ev.preventDefault();
      var target = $('#head-' + (state.langOpen ? 'language' : state.screen));
      if (target) target.focus();
    });

    /* Tela de idiomas (VG-IDI-01/05): abre no lugar da tela atual e volta com
       o voltar, o Esc ou o botão que a abriu. */
    var langBtn = $('#lang-btn');
    if (langBtn) langBtn.addEventListener('click', showLanguage);
    var langList = $('.lang-list');
    if (langList) langList.addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('.lang-item[data-lang]') : null;
      if (item) selectLanguage(item);
    });
    var langBack = $('#lang-back');
    if (langBack) langBack.addEventListener('click', function () { closeLanguage(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.langOpen) {
        ev.preventDefault();
        closeLanguage();
      }
    });

    /* Erro de dados do histórico (VG-ABS-10): a nova tentativa é um link de
       prosa, não um botão novo; o endereço não muda. */
    var historyRetry = $('#history-retry');
    if (historyRetry) historyRetry.addEventListener('click', function (ev) {
      ev.preventDefault();
      if (!state.busy) load(false);
    });

    /* Volta da 404 (VG-ABS-09): link de prosa leva à carteira, com o foco
       no item de menu da tela de destino. */
    var notfoundBack = $('#notfound-back');
    if (notfoundBack) notfoundBack.addEventListener('click', function (ev) {
      ev.preventDefault();
      showScreen('carteira');
      var b = $('.menu button[data-screen="carteira"]');
      if (b) b.focus();
    });

    /* Voltar e Avançar devolvem a tela e a página anteriores (VG-MET-10). */
    window.addEventListener('popstate', function () {
      var u = readUrl();
      showScreen(u.screen, { page: u.page, noUrl: true });
    });

    $('#wallet-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      // reaproveita a sessão: se a xpub mudou, o DO reinicia sozinho
      load(false);
      if (xpubProblem($('#xpub').value.trim())) $('#xpub').focus();
    });
    var xpubInput = $('#xpub');
    function applyXpubFilter(ev) {
      syncViewToInput();
      var raw = xpubInput.value;
      var out = filterXpub(raw);
      if (out.value !== raw) {
        var caret = xpubInput.selectionStart;
        var removed = raw.length - out.value.length;
        xpubInput.value = out.value;
        try {
          var pos = Math.max(0, Math.min(out.value.length, caret - removed));
          xpubInput.setSelectionRange(pos, pos);
        } catch (e) {}
      }
      if (out.blocked) {
        setFieldInvalid(xpubInput, true);
        if (ev && ev.type === 'input') {
          setStatus('error', 'chave inválida: use a xpub, zpub ou ypub da conta; endereço, chave privada e outro texto são recusados.');
        }
      } else if (out.value && !xpubProblem(out.value)) {
        setFieldInvalid(xpubInput, false);
      }
      scheduleAutoLoad();
    }
    if (xpubInput) {
      xpubInput.addEventListener('input', applyXpubFilter);
      xpubInput.addEventListener('paste', function (ev) {
        var data = '';
        try { data = (ev.clipboardData || window.clipboardData).getData('text') || ''; } catch (e) {}
        if (!data) return;
        var out = filterXpub(data);
        if (out.value !== data.replace(/\s+/g, '')) {
          ev.preventDefault();
          var missing = xpubProblem(out.value);
          if (out.value && out.value.length > EXT_PREFIX_LEN) {
            xpubInput.value = out.value;
            syncViewToInput();
            scheduleAutoLoad();
          }
          if (missing) {
            setFieldInvalid(xpubInput, true);
            setStatus('error', xpubProblem(data) || missing);
          } else {
            setFieldInvalid(xpubInput, false);
          }
        }
      });
      xpubInput.addEventListener('blur', function () {
        applyXpubFilter(null);
        var value = xpubInput.value.trim();
        var problem = value ? xpubProblem(value) : '';
        if (problem) {
          setFieldInvalid(xpubInput, true);
          setStatus('error', problem);
        } else if (value) {
          setFieldInvalid(xpubInput, false);
        }
      });
    }

    document.addEventListener('visibilitychange', function () {
      /* Pausa do grão (VG-EFE-09): com a aba oculta o intervalo é cancelado;
         ao voltar, ele retoma (com menos movimento, fica parado). */
      if (document.hidden) stopGrain();
      else if (grain.ctx && !prefersReducedMotion()) startGrain();
      // aba em segundo plano continua aberta: a sessão e o tempo real
      // seguem; só sair da página (pagehide) encerra tudo
      if (!document.hidden) syncViewportSoon();
      if (!document.hidden && state.xpub && state.data &&
          (!state.watch || state.watch.readyState > 1)) load(true);
      if (!document.hidden && state.xpub) loadFees();
    });
    window.addEventListener('pagehide', closeWatch);
    $('#theme-toggle').addEventListener('click', function () {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
    // copiar o endereço no bloco receber: pelo botão ao lado ou pelo clique
    // no próprio código
    async function copyAddress(ev, statusEl) {
      var action = ev.target.closest ? ev.target.closest('.key-action') : null;
      /* Enquanto mostra "copiado" o botão só informa: não copia de novo nem
         responde ao clique. Não usa disabled para não devolver o foco ao
         body; o aria-disabled tira a cor de ação e o JavaScript segura o
         clique repetido. */
      if (action && action.getAttribute('aria-disabled') === 'true') return;
      var code = ev.target.closest ? ev.target.closest('code') : null;
      var value = action ? action.getAttribute('data-copy') : (code ? code.textContent.trim() : '');
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        if (action) {
          action.textContent = 'copiado';
          action.setAttribute('aria-disabled', 'true');
          if (!action._copyLabel) action._copyLabel = action.getAttribute('aria-label');
          action.setAttribute('aria-label', 'endereço copiado');
          if (action._copyTimer) clearTimeout(action._copyTimer);
          action._copyTimer = setTimeout(function () {
            action.textContent = 'copiar';
            action.removeAttribute('aria-disabled');
            if (action._copyLabel) action.setAttribute('aria-label', action._copyLabel);
            action._copyTimer = 0;
          }, 1400);
        }
      } catch (e) {
        setStatusTo(statusEl, 'error', 'não foi possível copiar.');
      }
    }
    var receiveTable = $('#receive-table');
    if (receiveTable) receiveTable.addEventListener('click', function (ev) { copyAddress(ev, $('#status')); });
    var pager = $('#history-pager');
    if (pager) pager.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.pager-arrow') : null;
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
      goPage(btn.id === 'history-next' ? 1 : -1);
    });
    var historyList = $('#history-list');
    if (historyList) historyList.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-cpfp]') : null;
      if (!btn) return;
      startCpfp(btn.getAttribute('data-cpfp'));
    });
    var cpfpDownload = $('#cpfp-download');
    if (cpfpDownload) cpfpDownload.addEventListener('click', downloadCpfp);
    var cpfpClear = $('#cpfp-clear');
    if (cpfpClear) cpfpClear.addEventListener('click', resetCpfp);

    var scanContinue = $('#scan-continue');
    if (scanContinue) scanContinue.addEventListener('click', function () {
      if (!state.busy) load(false);
    });

    /* ---------------------------------------------------------- enviar */
    /* Sem botão de envio: o PSBT se monta sozinho. O Enter no formulário
       só antecipa a montagem; a página não navega nem recarrega. */
    var sendForm = $('#send-form');
    if (sendForm) sendForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      updateSendAvailability();
      focusFirstInvalid(sendForm);
    });
    /* Máscara de satoshis: dígitos entram da direita, o ponto é automático,
       backspace apaga o último dígito e colar aceita BTC com ponto/vírgula. */
    var amountInput = $('#send-amount');
    if (amountInput) {
      amountInput.addEventListener('keydown', function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (/^[0-9]$/.test(ev.key)) {
          ev.preventDefault();
          var all = amountInput.selectionStart === 0 &&
            amountInput.selectionEnd === amountInput.value.length;
          setAmountDigits((all ? '' : state.amountDigits) + ev.key);
          invalidatePsbt();
          return;
        }
        if (ev.key === 'Backspace' || ev.key === 'Delete') {
          ev.preventDefault();
          var whole = amountInput.selectionStart === 0 &&
            amountInput.selectionEnd === amountInput.value.length;
          setAmountDigits(whole ? '' : state.amountDigits.slice(0, -1));
          invalidatePsbt();
          return;
        }
        if (ev.key === '.' || ev.key === ',') ev.preventDefault();
      });
      amountInput.addEventListener('input', function (ev) {
        if (amountInput.value === amountDisplay(state.amountDigits)) {
          updateSendAvailability();
          return;
        }
        if (ev.inputType === 'deleteContentBackward' || ev.inputType === 'deleteContentForward') {
          setAmountDigits(state.amountDigits.slice(0, -1));
        } else {
          syncAmountFromValue();
        }
        invalidatePsbt();
      });
      amountInput.addEventListener('paste', function (ev) {
        var text = '';
        try { text = (ev.clipboardData || window.clipboardData).getData('text') || ''; } catch (e) {}
        if (!text.trim()) return;
        ev.preventDefault();
        var sats = /[.,]/.test(text) ? parseBtcSats(text) : (function () {
          var d = text.replace(/\D/g, '');
          return d ? Number(BigInt(d)) : 0;
        })();
        if (sats == null) return;
        setAmountDigits(String(sats));
        invalidatePsbt();
      });
    }
    var addressInput = $('#send-address');
    if (addressInput) addressInput.addEventListener('input', function () {
      dropPsbt(); // destino novo: o retrato anterior não fica na tela
      scheduleLimits();
    });
    var sendDownload = $('#send-download');
    if (sendDownload) sendDownload.addEventListener('click', downloadPsbt);

    /* ------------------------------------------ transmitir (psbt assinado) */
    var broadcastFile = $('#broadcast-file');
    if (broadcastFile) broadcastFile.addEventListener('change', function () {
      var file = broadcastFile.files && broadcastFile.files[0];
      // esvazia o input para o mesmo arquivo poder ser escolhido de novo
      broadcastFile.value = '';
      if (file) importSignedPsbt(file);
    });
    var broadcastSend = $('#broadcast-send');
    if (broadcastSend) broadcastSend.addEventListener('click', transmitSignedPsbt);
    var broadcastClear = $('#broadcast-clear');
    if (broadcastClear) broadcastClear.addEventListener('click', resetBroadcast);
    renderFees();
    renderAmountInput();

    var sc = $('#content-scroll');
    if (sc) sc.addEventListener('scroll', updateScroll);
    watchContentHeight();

    /* Reavalia a altura medida em toda mudança de viewport que não passa
       pelo resize da janela (a barra do iOS, a volta do bfcache). */
    window.addEventListener('orientationchange', syncViewportSoon);
    window.addEventListener('pageshow', syncViewportSoon);
    window.addEventListener('load', syncViewportSoon);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', syncViewportSoon);
    }

    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = 0;
        syncViewportHeight();
        syncBars();
        syncPageMode();
        resizeGrain();
        relayoutHistory();
      }, 150);
    });

    $$('.scroll-arrow').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!sc) return;
        var up = b.classList.contains('scroll-arrow-up');
        sc.scrollBy({
          top: (up ? -1 : 1) * sc.clientHeight * 0.8,
          /* Menos movimento (VG-EFE-04): a seta salta direto. */
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        });
      });
    });

    if (reducedMotionQuery.addEventListener) {
      reducedMotionQuery.addEventListener('change', function () {
        if (prefersReducedMotion()) stopGrain();
        else if (grain.ctx) startGrain();
      });
    } else if (reducedMotionQuery.addListener) {
      reducedMotionQuery.addListener(function () {
        if (prefersReducedMotion()) stopGrain();
        else if (grain.ctx) startGrain();
      });
    }

    /* A abertura direta pelo endereço já desenha a tela e a página pedidas
       (VG-MET-10); sem parâmetro, começa na carteira. A primeira pintura não
       repete a entrada em foco (VG-EFE-02): o HTML já chega na posição final e
       a animação só marcaria telas trocadas depois, sem fazer o conteúdo
       tremer na abertura. */
    var initial = readUrl();
    showScreen(initial.screen, { page: initial.page, noUrl: true, noReveal: true });
    syncViewportHeight();
    syncBars();
    syncPageMode();

    /* A tinta do grão depende da cobertura dos glifos reais: espera a fonte
       carregar para medir, e o desenho entra estático nesse intervalo. */
    var startVisuals = function () {
      initGrain();
      syncViewportHeight();
      syncBars();
      syncPageMode();
      relayoutHistory();
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(startVisuals).catch(startVisuals);
    } else {
      startVisuals();
    }

    // A tela abre sempre limpa: a xpub nunca foi salva (nem aqui, nem no
    // servidor), então não há nada para restaurar.
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
