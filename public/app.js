/* Projeto 2 — Fase 1 (Cloudflare Worker + D1).
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
    busy: false
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(v) {
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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
    $('#v-source').textContent = d.source ? d.source : 'blockchain.info (pkh) · blockstream.info/mempool.space (demais)';
    $('#v-updated').textContent = d.updated_at ? new Date(d.updated_at).toLocaleString('pt-BR') : '—';
    $('#v-warnings').innerHTML = (d.warnings || []).map(function (w) { return esc(w); }).join('<br>');

    var body = $('#addresses-table tbody');
    body.innerHTML = '';
    var rows = d.addresses || [];
    rows.forEach(function (a) {
      var tr = document.createElement('tr');
      var purpose = TYPE_PURPOSE[a.account_type] || '?';
      tr.innerHTML = '<td>' + esc(TYPE_LABEL[a.account_type] || a.account_type) + '</td>' +
        '<td>m/' + purpose + "'/0'/0'/" + a.chain + '/' + a.idx + '</td>' +
        '<td><code>' + esc(a.address) + '</code></td>' +
        '<td>' + (a.used ? 'sim' : 'não') + '</td>' +
        '<td class="is-num">' + fmtInt(a.balance) + '</td>';
      body.appendChild(tr);
    });
    $('#addresses-empty').hidden = rows.length > 0;
    $('#out').hidden = false;
    updateScroll();
  }

  async function load(quiet) {
    var xpub = $('#xpub').value.trim();
    if (!xpub) {
      setStatus('error', 'cole a xpub da conta.');
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
      setStatus('ok', 'carteira carregada · saldo e próximo endereço atualizados.');
      schedule();
    } catch (e) {
      setStatus('error', e && e.message ? e.message : String(e));
    } finally {
      state.busy = false;
    }
  }

  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!state.xpub) return;
      // o Worker checa o endereço atual; se recebeu, avança o índice.
      load(true);
    }, 30000);
  }

  function wire() {
    fillFrames();
    try { setTheme(localStorage.getItem('projeto2-fase1-theme') || 'dark'); }
    catch (e) { setTheme('dark'); }

    $('#wallet-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      load(false);
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
    if (saved) {
      $('#xpub').value = saved;
      load(false);
    } else {
      setStatus('', 'cole a xpub da conta; ela é a credencial, não precisa de senha.');
    }
  }

  document.addEventListener('DOMContentLoaded', wire);
})();
