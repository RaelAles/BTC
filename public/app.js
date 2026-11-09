/* Projeto 2 — Worker + Durable Object, fonte única Electrum.
   O navegador não deriva nem consulta saldo: só manda a chave estendida
   pública (xpub, zpub ou ypub) e mostra o
   estado que o Worker devolve. A xpub é a credencial; não há senha. Nada
   é gravado: nem no navegador (sem localStorage), nem no servidor. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Rótulo curto do tipo de conta: o formato do endereço (p2tr, p2wpkh…) já
     aparece na própria chave, então a tabela fica só com o BIP. */
  var TYPE_PURPOSE = { bip86: 86, bip84: 84, bip49: 49, bip44: 44 };

  /* Lista do histórico: cinco itens por página (VG-LST-03). Só o ramo de
     troco ganha palavra, para o caminho não ficar só com número. */
  var PER_PAGE = 5;

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
    feesError: false,   // a última consulta da taxa falhou
    feeQuotes: null,    // custo em BTC de cada nível para o valor atual
    feeLevel: 'standard', // minimum | standard | high | urgent
    feeTimer: 0,        // reconsulta periódica da taxa
    amountDigits: '',   // satoshis digitados (o ponto é só desenho)
    limits: null,       // máximo enviável para o destino e a taxa
    limitsError: '',
    limitsTimer: 0,
    limitsSeq: 0,
    sendBusy: false,
    psbt: null          // PSBT criado (texto e resumo)
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
      return { value: partial ? s.slice(0, keep) : '', blocked: true };
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

  function xpubProblem(value) {
    var s = String(value || '').trim();
    if (!s) return 'cole a xpub, zpub ou ypub da conta.';
    if (EXT_PRIVATE.test(s)) {
      return 'isso é uma chave privada (xprv/yprv/zprv). Nunca cole a privada aqui: o projeto só consulta.';
    }
    if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(s)) {
      return 'isso é um endereço Bitcoin, não uma xpub. Use a chave estendida pública da conta (xpub, zpub ou ypub).';
    }
    if (s.length !== XPUB_TOTAL || !EXT_PUBLIC_RE.test(s)) {
      return 'chave incompleta, com caractere inválido ou tipo não aceito: use a xpub, zpub ou ypub da conta (' + XPUB_TOTAL + ' caracteres). Confira a cópia da chave da conta.';
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
  function setStatusTo(el, kind, text) {
    if (!el) return;
    el.textContent = text ? (PREFIX[kind] || PREFIX['']) + ' ' + text : '';
    el.classList.remove('ok', 'error');
    if (kind === 'ok' || kind === 'error') el.classList.add(kind);
  }
  function setStatus(kind, text) {
    setStatusTo($('#status'), kind, text);
  }
  function setSendStatus(kind, text) {
    setStatusTo($('#send-status'), kind, text);
  }
  var SCREEN_TITLES = {
    carteira: 'Projeto 2 — carteira',
    historico: 'Projeto 2 — histórico'
  };
  function showScreen(name) {
    if (!SCREEN_TITLES[name]) name = 'carteira';
    Object.keys(SCREEN_TITLES).forEach(function (n) {
      var sec = $('#screen-' + n);
      if (sec) sec.hidden = n !== name;
    });
    $$('.menu button[data-screen]').forEach(function (b) {
      if (b.getAttribute('data-screen') === name) {
        b.setAttribute('aria-current', 'page');
        b.setAttribute('tabindex', '-1');
      } else {
        b.removeAttribute('aria-current');
        b.removeAttribute('tabindex');
      }
    });
    // abrir a lista pelo menu recomeça na primeira página (VG-LST-03)
    if (name === 'historico') {
      state.page = 1;
      renderHistory();
    }
    document.title = SCREEN_TITLES[name];
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = 0;
    updateScroll();
  }
  function fillFrames() {
    $$('.edge').forEach(function (el) {
      el.innerHTML = '<span>+</span><span class="fill">' + '-'.repeat(240) + '</span><span>+</span>';
    });
    $$('.rule:not(.rule-dots)').forEach(function (el) {
      el.textContent = '='.repeat(240);
    });
  }
  function setTheme(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('projeto2-fase1-theme', t); } catch (e) {}
    var b = $('#theme-toggle');
    if (b) {
      b.textContent = t === 'light' ? '●' : '○';
      b.setAttribute('aria-label', t === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro');
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (meta && bg) meta.setAttribute('content', bg);
  }
  function updateScroll() {
    var el = $('#content-scroll');
    var c = $('#content');
    if (!el || !c) return;
    var max = el.scrollHeight - el.clientHeight;
    c.classList.toggle('can-scroll-up', max > 2 && el.scrollTop > 2);
    c.classList.toggle('can-scroll-down', max > 2 && el.scrollTop < max - 2);
    updatePager(max);
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
  /* Níveis de prioridade da taxa, na ordem do formulário. O rótulo é o nome
     que a tela mostra; a taxa de cada nível vem do /api/fees e o custo em
     BTC, do preview do valor e do destino digitados. */
  var FEE_ORDER = ['minimum', 'standard', 'high', 'urgent'];
  /* Ordem de preferência quando o nível escolhido deixa de ter estimativa:
     o padrão é a escolha natural; a mínima é o último recurso. */
  var FEE_PREF = ['standard', 'high', 'urgent', 'minimum'];
  var FEE_MAX = 10000;

  function feeRateOf(level) {
    var levels = (state.fees && state.fees.levels) || {};
    return Number(levels[level]) || 0;
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
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    var rate = feeRateOf(state.feeLevel);
    var hint = $('#send-amount-hint');
    var box = $('#send-amount-box');
    var input = $('#send-amount');
    var problem = '';
    var hintText = '';

    if (amount > 0 && amount < DUST_SATS) {
      problem = 'valor abaixo do mínimo: ' + fmtBtc(DUST_SATS) + ' BTC.';
    } else if (state.limits) {
      var max = Number(state.limits.max_send_sats) || 0;
      hintText = 'máximo ' + fmtBtc(max) + ' BTC.';
      if (max < DUST_SATS) problem = 'saldo insuficiente para enviar com essa taxa.';
      else if (amount > max) {
        problem = 'valor acima do máximo enviável: ' + fmtBtc(max) + ' BTC.';
      }
    } else if (state.limitsError) {
      hintText = 'máximo indisponível: ' + state.limitsError;
    } else if (amount > 0 && addressLooksValid(address)) {
      hintText = 'calculando a taxa…';
    }

    if (box) box.classList.toggle('is-invalid', !!problem);
    if (input) {
      if (problem) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (hint) {
      hint.textContent = problem || hintText;
      hint.classList.toggle('is-error', !!problem);
    }
    var disabled = state.sendBusy || !amount || amount < DUST_SATS ||
      !addressLooksValid(address) || !Number.isInteger(rate) || rate < 1 ||
      !state.limits || Number(state.limits.max_send_sats) < DUST_SATS ||
      amount > Number(state.limits.max_send_sats);
    var btn = $('#send-submit');
    if (btn) {
      if (disabled) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    }
    state.sendBlocked = disabled;
    updateFeeVisibility();
    /* o custo de cada nível depende do valor, do destino e do preview que
       acabou de mudar; é o único lugar em que todos os três se encontram */
    renderFeeLevels();
  }

  /* O seletor de taxa só aparece quando há valor e destino válidos: é quando
     o preview consegue cotar cada nível em BTC. Sem os dois, a escolha não
     teria custo para mostrar. */
  function updateFeeVisibility() {
    var section = $('#fee-section');
    if (!section) return;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    section.hidden = !(amount > 0 && addressLooksValid(address));
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
    var rate = feeRateOf(state.feeLevel);
    var amount = amountSats();
    if (!state.xpub || !addressLooksValid(address) || !Number.isInteger(rate) || rate < 1) return;
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
    /* As taxas estimadas vão junto para o servidor cotar o custo de cada
       nível para o mesmo valor, numa seleção de entradas só. Níveis que
       caem na mesma taxa entram uma vez: a cota é a mesma. */
    var quoteRates = FEE_ORDER.map(function (k) {
      return Number((state.fees && state.fees.levels || {})[k]) || 0;
    }).filter(function (r) { return r > 0; })
      .filter(function (r, i, all) { return all.indexOf(r) === i; });
    if (quoteRates.length) body.quote_rates = quoteRates;
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
      state.limitsError = e && e.message ? e.message : String(e);
    }
    updateSendAvailability();
  }

  /* Desenha a taxa: o custo em BTC e o percentual de cada nível nas opções.
     O grupo de rádio é nativo: o navegador guarda a escolha, anda com as
     setas e leva o foco ao marcador; o JavaScript só reflete o estado da
     estimativa. */
  function renderFees() {
    var levels = (state.fees && state.fees.levels) || {};
    FEE_ORDER.forEach(function (key) {
      var input = $('input[name="fee-level"][value="' + key + '"]');
      if (!input) return;
      var available = Number(levels[key]) > 0;
      input.disabled = !available;
      input.checked = state.feeLevel === key;
      var label = input.closest ? input.closest('.fee-level') : null;
      if (label) label.classList.toggle('is-empty', !available);
    });
    renderFeeLevels();
    var upd = $('#fee-updated');
    if (!upd) return;
    var any = FEE_ORDER.some(function (k) { return Number(levels[k]) > 0; });
    upd.textContent = state.fees
      ? any
        ? 'atualizado ' + new Date(state.fees.updated_at).toLocaleTimeString('pt-BR')
        : 'estimativa indisponível'
      : state.feesError
        ? 'estimativa indisponível'
        : 'calculando…';
  }

  /* Custo e percentual de cada nível para o valor que está no formulário. Só
     vale quando o preview respondeu para o mesmo valor e o mesmo destino;
     fora disso a opção fica em `—`, como manda a regra da tela. Níveis que
     caem na mesma taxa mostram o mesmo custo: o valor é do sat/vB, não do
     nome. */
  function feeQuotes() {
    var cached = state.feeQuotes;
    var amount = amountSats();
    var address = $('#send-address') ? $('#send-address').value.trim() : '';
    if (!cached || !(amount > 0) || cached.amount !== amount ||
      cached.address !== address) return {};
    return cached.byRate;
  }

  function renderFeeLevels() {
    var levels = (state.fees && state.fees.levels) || {};
    var quotes = feeQuotes();
    var amount = amountSats();
    FEE_ORDER.forEach(function (key) {
      var label = $('.fee-level[data-level="' + key + '"]');
      if (!label) return;
      var rate = Number(levels[key]) || 0;
      var fee = rate > 0 ? quotes[rate] : null;
      var btc = $('.fee-level-btc', label);
      var pct = $('.fee-level-pct', label);
      if (btc) btc.textContent = fee > 0 ? fmtBtc(fee) + ' BTC' : '—';
      if (pct) pct.textContent = fee > 0 && amount > 0
        ? ' · ' + fmtPercent(fee, amount) + '%'
        : '';
    });
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
      var before = feeRateOf(state.feeLevel);
      state.fees = j;
      state.feesError = false;
      if (!(Number(j.levels[state.feeLevel]) > 0)) {
        state.feeLevel = FEE_PREF.find(function (k) { return Number(j.levels[k]) > 0; }) || state.feeLevel;
      }
      renderFees();
      /* taxa escolhida mudou: o máximo é recalculado sem manter o antigo.
         Só os níveis mudaram: mantém o máximo e refaz as cotas das opções. */
      if (!state.limits || feeRateOf(state.feeLevel) !== before) scheduleLimits();
      else scheduleLimits(true);
    } catch (e) {
      state.feesError = true;
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

  function invalidatePsbt() {
    if (!state.psbt) return;
    state.psbt = null;
    var out = $('#send-out');
    if (out) out.hidden = true;
    var pre = $('#send-psbt');
    if (pre) pre.textContent = '';
    var meta = $('#send-meta');
    if (meta) meta.textContent = '';
  }

  function resetSend() {
    invalidatePsbt();
    state.sendBusy = false;
    state.fees = null;
    state.feesError = false;
    state.feeQuotes = null;
    state.feeLevel = 'standard';
    state.amountDigits = '';
    state.limits = null;
    state.limitsError = '';
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
    var btn = $('#send-submit');
    if (btn) {
      btn.removeAttribute('aria-busy');
      btn.textContent = 'criar psbt';
    }
    setSendStatus('', '');
    renderFees();
    renderAmountInput();
  }

  function sendMeta(j) {
    var parts = [];
    parts.push(fmtInt(j.inputs.length) + (j.inputs.length === 1 ? ' entrada' : ' entradas'));
    parts.push(fmtInt(j.outputs.length) + (j.outputs.length === 1 ? ' saída' : ' saídas'));
    parts.push('taxa ' + fmtBtc(j.fee_sats) + ' BTC (' + Number(j.fee_rate).toFixed(2) + ' sat/vB)');
    parts.push('vsize ~' + fmtInt(j.vsize) + ' vB');
    if (j.change) parts.push('troco ' + fmtBtc(j.change.value) + ' BTC em ' + j.change.address);
    return 'txid ' + j.txid + ' · ' + parts.join(' · ');
  }

  async function createPsbt() {
    if (state.sendBusy) return;
    invalidatePsbt();
    var amount = amountSats();
    if (!amount) {
      setSendStatus('error', 'digite o valor em BTC.');
      $('#send-amount').focus();
      return;
    }
    if (amount < DUST_SATS) {
      setSendStatus('error', 'valor abaixo do mínimo: ' + fmtBtc(DUST_SATS) + ' BTC.');
      $('#send-amount').focus();
      return;
    }
    var address = $('#send-address').value.trim();
    if (!address) {
      setSendStatus('error', 'informe o endereço de destino.');
      $('#send-address').focus();
      return;
    }
    if (!addressLooksValid(address)) {
      setSendStatus('error', 'endereço de destino inválido.');
      $('#send-address').focus();
      return;
    }
    var rate = feeRateOf(state.feeLevel);
    if (!Number.isInteger(rate) || rate < 1 || rate > FEE_MAX) {
      setSendStatus('error', 'escolha um nível de taxa disponível.');
      var chosen = $('input[name="fee-level"]:checked');
      if (chosen) chosen.focus();
      return;
    }
    if (!state.limits) {
      setSendStatus('error', state.limitsError
        ? 'não foi possível calcular o máximo: ' + state.limitsError
        : 'aguarde o cálculo do máximo enviável.');
      return;
    }
    if (Number(state.limits.max_send_sats) < DUST_SATS) {
      setSendStatus('error', 'saldo insuficiente para enviar com essa taxa.');
      return;
    }
    if (amount > Number(state.limits.max_send_sats)) {
      setSendStatus('error', 'valor acima do máximo enviável: ' +
        fmtBtc(state.limits.max_send_sats) + ' BTC.');
      $('#send-amount').focus();
      return;
    }
    state.sendBusy = true;
    updateSendAvailability();
    var btn = $('#send-submit');
    if (btn) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'criando';
    }
    setSendStatus('', 'montando o psbt...');
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
      state.psbt = j;
      $('#send-psbt').textContent = j.psbt;
      $('#send-meta').textContent = sendMeta(j);
      $('#send-out').hidden = false;
      setSendStatus('ok', 'psbt criado. confira no chave-btc.html antes de assinar.');
      updateScroll();
    } catch (e) {
      setSendStatus('error', e && e.message ? e.message : String(e));
    } finally {
      state.sendBusy = false;
      if (btn) {
        btn.removeAttribute('aria-busy');
        btn.textContent = 'criar psbt';
      }
      updateSendAvailability();
    }
  }

  function copyPsbt(button) {
    if (!state.psbt || !button) return;
    if (button.getAttribute('aria-disabled') === 'true') return;
    navigator.clipboard.writeText(state.psbt.psbt).then(function () {
      button.textContent = 'copiado';
      button.setAttribute('aria-disabled', 'true');
      if (button._copyTimer) clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(function () {
        button.textContent = 'copiar psbt';
        button.removeAttribute('aria-disabled');
        button._copyTimer = 0;
      }, 1400);
    }).catch(function () {
      setSendStatus('error', 'não foi possível copiar o psbt.');
    });
  }

  function downloadPsbt() {
    if (!state.psbt) return;
    var blob = new Blob([state.psbt.psbt], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'projeto2-' + String(state.psbt.txid || 'psbt').slice(0, 8) + '.psbt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* Linha de valor com sinal (VG-COR-16): o sinal vai no texto e a cor só
     reforça; o zero não tem direção e fica no --dim da linha. */
  function signedBtc(sats, dir) {
    var n = Number(sats) || 0;
    if (!n) return '<span class="value-none">' + fmtBtc(0) + '</span>';
    return '<span class="value-' + dir + '">' + (dir === 'in' ? '+' : '-') + fmtBtc(n) + '</span>';
  }

  /* Extrato (VG-LST-01): um item por endereço usado, cinco por página, na
     ordem que o servidor manda — o uso mais recente primeiro. O endereço é o
     título em texto simples (sem a caixa do <code>), o caminho e o ramo de
     troco viram tags, e a linha de dados traz recebido, enviado e saldo. O
     histórico é só leitura: quem copia endereço é o bloco receber. */
  function historyRows() {
    return (state.data && state.data.addresses) || [];
  }

  function historyPages() {
    return Math.max(1, Math.ceil(historyRows().length / PER_PAGE));
  }

  function renderHistory() {
    var list = $('#history-list');
    if (!list) return;
    var rows = historyRows();
    var pages = historyPages();
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * PER_PAGE;
    list.innerHTML = '';
    rows.slice(start, start + PER_PAGE).forEach(function (a, i) {
      if (i) {
        var sep = document.createElement('li');
        sep.className = 'rule-dots';
        sep.setAttribute('aria-hidden', 'true');
        list.appendChild(sep);
      }
      var purpose = TYPE_PURPOSE[a.account_type] || '?';
      var chain = a.chain === 1 ? 'troco' : '';
      var li = document.createElement('li');
      li.className = 'item';
      li.innerHTML =
        '<h3><span class="item-title is-static">' + esc(a.address) + '</span></h3>' +
        '<p class="item-meta">m/' + purpose + "'/0'/0'/" + a.chain + '/' + a.idx +
          (chain
            ? ' <span class="tag-sep" aria-hidden="true">·</span> ' +
              '<span class="tag">' + chain + '</span>'
            : '') +
          ' <span class="tag-sep" aria-hidden="true">·</span> ' +
          '<span class="tag">bip' + purpose + '</span>' +
          (a.pending
            ? ' <span class="tag-sep" aria-hidden="true">·</span> <span class="tag">[ mempool ]</span>'
            : '') +
        '</p>' +
        '<p class="item-meta history-values">' +
          '<span class="value-label">recebido</span> ' + signedBtc(a.received, 'in') +
          ' <span class="value-sep" aria-hidden="true">|</span> ' +
          '<span class="value-label">enviado</span> ' + signedBtc(a.spent, 'out') +
          ' <span class="value-sep" aria-hidden="true">|</span> ' +
          '<span class="value-label">saldo</span> ' + fmtBtc(a.balance) +
        '</p>';
      list.appendChild(li);
    });
    list.hidden = rows.length === 0;
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

  function updatePager(max) {
    var pager = $('#history-pager');
    var content = $('#content');
    var screen = $('#screen-historico');
    if (!pager || !content || !screen) return;
    var pages = historyPages();
    var visible = !screen.hidden && pages > 1;
    pager.hidden = !visible;
    var el = $('#content-scroll');
    var atEnd = !el || max <= 2 || el.scrollTop >= max - 2;
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
    var sc = $('#content-scroll');
    if (sc) sc.scrollTop = 0;
    updateScroll();
  }

  function render(d) {
    stopScan();
    state.data = d;
    var b = d.balance || {};
    var total = $('#v-total');
    total.textContent = fmtBtc(b.total) + ' BTC';
    total.hidden = false;
    var updated = $('#v-updated');
    updated.textContent = d.updated_at
      ? 'atualizado ' + new Date(d.updated_at).toLocaleString('pt-BR')
      : '';
    updated.hidden = !d.updated_at;
    renderReceive(d);
    $('#v-warnings').innerHTML = (d.warnings || []).map(function (w) { return esc(w); }).join('<br>');

    var rows = d.addresses || [];
    var sum = { received: 0, spent: 0, balance: 0 };
    rows.forEach(function (a) {
      sum.received += Number(a.received) || 0;
      sum.spent += Number(a.spent) || 0;
      sum.balance += Number(a.balance) || 0;
    });
    var countLabel = rows.length === 1 ? '1 endereço usado' : fmtInt(rows.length) + ' endereços usados';
    $('#history-summary').textContent = countLabel +
      ' · recebido ' + fmtBtc(sum.received) + ' BTC' +
      ' · enviado ' + fmtBtc(sum.spent) + ' BTC' +
      ' · saldo ' + fmtBtc(sum.balance) + ' BTC';
    renderHistory();
    $('#addresses-empty').hidden = rows.length > 0;
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
    ['#v-total', '#v-updated'].forEach(function (sel) {
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
    stopScan();
    var empty = $('#addresses-empty');
    if (empty) empty.hidden = true;
    var summary = $('#history-summary');
    if (summary) summary.textContent = 'cole a xpub, zpub ou ypub na carteira para ver o histórico.';
    resetSend();
    setStatus('', '');
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
    return 'verificando endereços: ' + fmtInt(p.scanned || 0) + ' · ' +
      fmtInt(p.used || 0) + ' com atividade';
  }

  function showScan(progress) {
    state.scanning = true;
    // o progresso ocupa a mesma linha que anunciava a consulta
    setStatus('', scanText(progress));
    var btn = $('#scan-continue');
    if (btn) btn.hidden = true;
    // durante a busca o saldo anterior não é apresentado como final
    var total = $('#v-total');
    if (total) total.hidden = true;
    var updated = $('#v-updated');
    if (updated) updated.hidden = true;
    var out = $('#out');
    if (out) out.hidden = true;
    var summary = $('#history-summary');
    if (summary) summary.textContent = 'verificando endereços... o saldo aparece ao terminar.';
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
  }

  async function load(quiet) {
    var xpub = $('#xpub').value.trim();
    // nunca mostra o estado de uma xpub que não está mais no campo
    syncViewToInput();
    var problem = xpubProblem(xpub);
    if (problem) {
      setStatus('error', problem);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    stopScan();
    closeWatch();
    if (!quiet) setStatus('', 'verificando endereços...');
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
          showScan(j.progress);
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
    try { setTheme(localStorage.getItem('projeto2-fase1-theme') || 'dark'); }
    catch (e) { setTheme('dark'); }

    $$('.menu button[data-screen]').forEach(function (b) {
      b.addEventListener('click', function () {
        showScreen(b.getAttribute('data-screen'));
      });
    });

    $('#wallet-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      // reaproveita a sessão: se a xpub mudou, o DO reinicia sozinho
      load(false);
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
        if (out.blocked && ev && ev.type === 'input') {
          setStatus('error', 'este campo só aceita xpub, zpub ou ypub: endereço, chave privada e outro texto são recusados.');
        }
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
          if (missing) setStatus('error', xpubProblem(data) || missing);
        }
      });
      xpubInput.addEventListener('blur', function () {
        applyXpubFilter(null);
      });
    }

    document.addEventListener('visibilitychange', function () {
      // aba em segundo plano continua aberta: a sessão e o tempo real
      // seguem; só sair da página (pagehide) encerra tudo
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

    var scanContinue = $('#scan-continue');
    if (scanContinue) scanContinue.addEventListener('click', function () {
      if (!state.busy) load(false);
    });

    /* ---------------------------------------------------------- enviar */
    var sendForm = $('#send-form');
    if (sendForm) sendForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      createPsbt();
    });
    /* A taxa é um grupo de rádio nativo: o navegador guarda a escolha e
       anda com as setas; aqui só o estado da tela e o preview acompanham. */
    var feeLevels = $('#fee-levels');
    if (feeLevels) feeLevels.addEventListener('change', function (ev) {
      var input = ev.target;
      if (!input || input.name !== 'fee-level') return;
      state.feeLevel = input.value;
      renderFees();
      invalidatePsbt();
      scheduleLimits();
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
      invalidatePsbt();
      scheduleLimits();
    });
    var sendCopy = $('#send-copy');
    if (sendCopy) sendCopy.addEventListener('click', function () { copyPsbt(sendCopy); });
    var sendDownload = $('#send-download');
    if (sendDownload) sendDownload.addEventListener('click', downloadPsbt);
    renderFees();
    renderAmountInput();

    var sc = $('#content-scroll');
    if (sc) sc.addEventListener('scroll', updateScroll);
    window.addEventListener('resize', updateScroll);
    $$('.scroll-arrow').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!sc) return;
        var up = b.classList.contains('scroll-arrow-up');
        sc.scrollBy({ top: (up ? -1 : 1) * sc.clientHeight * 0.8, behavior: 'smooth' });
      });
    });

    // A tela abre sempre limpa: a xpub nunca foi salva (nem aqui, nem no
    // servidor), então não há nada para restaurar.
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
