/* Projeto 2 — Worker + D1 com fonte única Electrum.
   O navegador não deriva nem consulta saldo: só manda a xpub e mostra o
   estado que o Worker devolve. A xpub é a credencial; não há senha. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var TYPE_LABEL = {
    bip86: 'bip86 / p2tr',
    bip84: 'bip84 / p2wpkh',
    bip49: 'bip49 / p2sh-p2wpkh',
    bip44: 'bip44 / p2pkh'
  };
  var TYPE_PURPOSE = { bip86: 86, bip84: 84, bip49: 49, bip44: 44 };

  var state = {
    xpub: '',
    data: null,
    timer: 0,
    busy: false,
    watch: null,        // WebSocket do tempo real (Durable Object)
    watchHash: '',
    watchRetry: 0,
    autoTimer: 0        // debounce da consulta automática
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* Só xpub. O campo nem aceita outra coisa: o filtro abaixo bloqueia a
     digitação/colagem que não comece com "xpub" e só deixa passar caracteres
     do alfabeto base58. Endereço, chave privada, zpub/ypub, seed ou lixo não
     chegam a formar valor. */
  var XPUB_PREFIX = 'xpub';
  var B58_CHARS = /[1-9A-HJ-NP-Za-km-z]/;
  var XPUB_TOTAL = 111;
  var EXT_PRIVATE = /^(xprv|yprv|zprv)/;
  var EXT_OTHER = /^(ypub|zpub)/;

  function filterXpub(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s+/g, '');
    var keep = 0;
    while (keep < s.length && keep < XPUB_PREFIX.length && s[keep] === XPUB_PREFIX[keep]) keep++;
    if (keep < XPUB_PREFIX.length) {
      // enquanto o texto é prefixo de "xpub" (x, xp, xpu) deixa digitar; se já
      // passou disso e não casou (xprv, ypub, bc1, 1Efg…), limpa o campo
      var partial = s.length <= XPUB_PREFIX.length;
      return { value: partial ? XPUB_PREFIX.slice(0, keep) : '', blocked: true };
    }
    var rest = '';
    var dropped = false;
    for (var i = XPUB_PREFIX.length; i < s.length; i++) {
      if (B58_CHARS.test(s[i])) rest += s[i];
      else dropped = true;
    }
    var value = XPUB_PREFIX + rest.slice(0, XPUB_TOTAL - XPUB_PREFIX.length);
    return { value: value, blocked: dropped || rest.length > XPUB_TOTAL - XPUB_PREFIX.length };
  }

  function xpubProblem(value) {
    var s = String(value || '').trim();
    if (!s) return 'cole a xpub da conta.';
    if (EXT_PRIVATE.test(s)) {
      return 'isso é uma chave privada (xprv/yprv/zprv). Nunca cole a privada aqui: o projeto só consulta.';
    }
    if (EXT_OTHER.test(s)) {
      return 'este campo aceita só xpub; zpub/ypub não entram.';
    }
    if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/.test(s)) {
      return 'isso é um endereço Bitcoin, não uma xpub. Use a chave estendida pública da conta.';
    }
    if (s.length !== XPUB_TOTAL || !/^xpub[1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
      return 'xpub incompleta ou com caractere inválido (são ' + XPUB_TOTAL + ' caracteres). Confira a cópia da chave da conta.';
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
  function setStatus(kind, text) {
    var el = $('#status');
    el.textContent = text || '';
    el.classList.remove('ok', 'error');
    if (kind === 'ok' || kind === 'error') el.classList.add(kind);
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
  }

  function render(d) {
    state.data = d;
    var b = d.balance || {};
    $('#v-type').textContent = d.detected_label + ' (' + d.version_type + ')';
    $('#v-balance').textContent = fmtBtc(b.total) + ' BTC · ' + fmtInt(b.total) + ' sats';
    $('#v-breakdown').textContent = 'tipo detectado: ' + fmtBtc(b.detected) + ' BTC · outros tipos: ' + fmtBtc(b.extras) + ' BTC';
    $('#v-address').textContent = d.receive && d.receive.address ? d.receive.address : '—';
    $('#v-path').textContent = d.receive && d.receive.path ? d.receive.path : '—';
    $('#v-change').textContent = d.change ? (d.change.path + ' · ' + d.change.address) : '—';
    $('#v-extras').innerHTML = (d.extras && d.extras.length)
      ? d.extras.map(function (e) {
        return '<div>' + esc(e.label) + ' · ' + fmtBtc(e.balance) + ' BTC · <code>' + esc(e.address) + '</code></div>';
      }).join('')
      : '—';
    $('#v-source').textContent = d.source ? d.source : 'electrum (scripthash)';
    $('#v-updated').textContent = d.updated_at ? new Date(d.updated_at).toLocaleString('pt-BR') : '—';
    $('#v-warnings').innerHTML = (d.warnings || []).map(function (w) { return esc(w); }).join('<br>');

    var body = $('#addresses-table tbody');
    body.innerHTML = '';
    var rows = d.addresses || [];
    rows.forEach(function (a) {
      var tr = document.createElement('tr');
      var purpose = TYPE_PURPOSE[a.account_type] || '?';
      tr.innerHTML = '<td>m/' + purpose + "'/0'/0'/" + a.chain + '/' + a.idx + '</td>' +
        '<td><code>' + esc(a.address) + '</code></td>' +
        '<td class="is-num">' + fmtInt(a.received) + '</td>' +
        '<td class="is-num">' + fmtInt(a.spent) + '</td>' +
        '<td class="is-num">' + fmtInt(a.balance) + '</td>';
      body.appendChild(tr);
    });
    $('#addresses-empty').hidden = rows.length > 0;
    $('#out').hidden = false;
    updateScroll();
  }

  async function load(quiet) {
    var xpub = $('#xpub').value.trim();
    var problem = xpubProblem(xpub);
    if (problem) {
      setStatus('error', problem);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    if (!quiet) setStatus('', 'consultando o Worker…');
    try {
      var r = await fetch('/api/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xpub: xpub })
      });
      var j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      state.xpub = xpub;
      try { localStorage.setItem('projeto2-fase1-xpub', xpub); } catch (e) {}
      render(j);
      setStatus('ok', j.watch
        ? 'carteira carregada · tempo real ligado.'
        : 'carteira carregada · saldo e próximo endereço atualizados.');
      if (j.watch) openWatch(j.xpub_hash);
      else closeWatch();
      schedule();
    } catch (e) {
      setStatus('error', e && e.message ? e.message : String(e));
    } finally {
      state.busy = false;
    }
  }

  /* A consulta começa sozinha quando a digitação/colagem deixa a xpub
     completa e válida: sem clique em carregar. O debounce curto evita
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
    state.watchHash = '';
  }

  function openWatch(hash) {
    if (!hash || !window.WebSocket) return;
    if (state.watch && state.watchHash === hash &&
        (state.watch.readyState === 0 || state.watch.readyState === 1)) return;
    closeWatch();
    state.watchHash = hash;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/api/events?hash=' + hash); }
    catch (e) { return; }
    state.watch = ws;
    ws.onopen = function () { state.watchRetry = 0; };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'payload' && msg.payload) {
        render(msg.payload);
        setStatus('ok', 'tempo real · saldo atualizado pelo servidor Electrum.');
      } else if (msg.type === 'error') {
        setStatus('error', 'tempo real: ' + msg.error);
      }
    };
    ws.onclose = function () {
      if (state.watch !== ws) return;
      state.watch = null;
      if (!state.xpub || document.hidden) return;
      var wait = Math.min(30000, 2000 * Math.pow(2, state.watchRetry++));
      setTimeout(function () {
        if (state.xpub && !document.hidden) openWatch(state.watchHash);
        else if (state.xpub) load(true);
      }, wait);
    };
  }

  function wire() {
    fillFrames();
    try { setTheme(localStorage.getItem('projeto2-fase1-theme') || 'dark'); }
    catch (e) { setTheme('dark'); }

    $('#wallet-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      closeWatch();
      load(false);
    });
    var xpubInput = $('#xpub');
    function applyXpubFilter(ev) {
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
          setStatus('error', 'este campo só aceita xpub: endereço, chave privada e outro texto são recusados.');
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
          if (missing) setStatus('error', xpubProblem(data) || missing);
          if (out.value && out.value.length > XPUB_PREFIX.length) {
            xpubInput.value = out.value;
            scheduleAutoLoad();
          }
        }
      });
      xpubInput.addEventListener('blur', function () {
        applyXpubFilter(null);
      });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) closeWatch();
      else if (state.xpub && state.data) load(true);
    });
    $('#refresh').addEventListener('click', function () { load(false); });
    $('#theme-toggle').addEventListener('click', function () {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
    $('#copy-address').addEventListener('click', async function () {
      var text = $('#v-address').textContent.trim();
      try {
        await navigator.clipboard.writeText(text);
        setStatus('ok', 'endereço copiado.');
      } catch (e) {
        setStatus('error', 'não foi possível copiar.');
      }
    });
    $('#addresses-table').addEventListener('click', async function (ev) {
      var code = ev.target.closest ? ev.target.closest('code') : null;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        setStatus('ok', 'endereço copiado.');
      } catch (e) {}
    });

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

    var saved = '';
    try { saved = localStorage.getItem('projeto2-fase1-xpub') || ''; } catch (e) {}
    if (saved && !xpubProblem(saved)) {
      $('#xpub').value = saved;
      load(false);
    } else {
      setStatus('', 'cole a xpub da conta; ela é a credencial, não precisa de senha.');
    }
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
