(function () {
  'use strict';

  // ---------- state ----------

  const state = {
    strings: null,
    professions: null,
    questions: null,
    maxScores: {},
    scores: {},
    currentQuestion: 0,
    history: [],
    ranking: [],
    contactType: 'phone',
    submitting: false,
    tg: (window.Telegram && window.Telegram.WebApp) || null,
    source: 'kiosk',
  };

  // ---------- bootstrap ----------

  async function boot() {
    try {
      const [strings, professions, questions] = await Promise.all([
        fetchJSON('content/strings.json'),
        fetchJSON('content/professions.json'),
        fetchJSON('content/questions.json'),
      ]);
      state.strings = strings;
      state.professions = professions;
      state.questions = questions;

      precomputeMaxScores();
      resetScores();

      initTelegram();
      bindStaticTexts();
      bindActions();
      bindLeadForm();

      document.getElementById('loading').hidden = true;
      document.getElementById('app').hidden = false;

      showScreen('welcome');

      if (typeof console !== 'undefined' && console.info) {
        console.info('[alfafuture] maxScores per profession:', state.maxScores);
      }
    } catch (e) {
      console.error('boot failed', e);
      const loading = document.getElementById('loading');
      if (loading) loading.textContent = 'Не получилось загрузить тест. Перезагрузи страницу.';
    }
  }

  async function fetchJSON(path) {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }

  function initTelegram() {
    const tg = state.tg;
    if (tg && tg.initData) {
      try {
        tg.ready();
        tg.expand();
        if (tg.setHeaderColor) tg.setHeaderColor('#EF3124');
        if (tg.setBackgroundColor) tg.setBackgroundColor('#FFFFFF');
        state.source = 'telegram';
      } catch (e) { /* ignore */ }
    }
  }

  // ---------- texts ----------

  function getString(path) {
    return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : ''), state.strings);
  }

  function bindStaticTexts() {
    document.querySelectorAll('[data-text]').forEach(el => {
      const v = getString(el.getAttribute('data-text'));
      if (v) el.textContent = v;
    });
    const link = document.getElementById('lead-consent-link');
    if (link) link.href = getString('lead.consent_link_url') || '#';
  }

  // ---------- screens ----------

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = s.getAttribute('data-screen') !== name;
    });
    updateBackButton(name);
    if (name === 'quiz') renderQuestion();
    if (name === 'result') renderResult();
    window.scrollTo(0, 0);
  }

  function updateBackButton(name) {
    const tg = state.tg;
    if (!tg || !tg.initData || !tg.BackButton) return;
    const showOn = { quiz: true, result: true, lead: true };
    try {
      if (showOn[name]) {
        tg.BackButton.show();
        tg.BackButton.onClick(handleBack);
      } else {
        tg.BackButton.hide();
        tg.BackButton.offClick(handleBack);
      }
    } catch (e) { /* unsupported on old TG clients */ }
  }

  function handleBack() {
    const visible = document.querySelector('.screen:not([hidden])');
    const name = visible && visible.getAttribute('data-screen');
    if (name === 'quiz') {
      if (state.currentQuestion === 0) {
        showScreen('welcome');
        return;
      }
      const last = state.history.pop();
      if (last) {
        for (const k in last.weights) state.scores[k] -= last.weights[k];
        state.currentQuestion -= 1;
        renderQuestion();
      }
    } else if (name === 'result') {
      state.currentQuestion = state.questions.length - 1;
      showScreen('quiz');
    } else if (name === 'lead') {
      showScreen('result');
    }
  }

  // ---------- scoring ----------

  function precomputeMaxScores() {
    const max = {};
    for (const q of state.questions) {
      const perProfThisQ = {};
      for (const opt of q.options) {
        for (const [k, v] of Object.entries(opt.weights || {})) {
          if (!(k in perProfThisQ) || perProfThisQ[k] < v) perProfThisQ[k] = v;
        }
      }
      for (const [k, v] of Object.entries(perProfThisQ)) {
        max[k] = (max[k] || 0) + v;
      }
    }
    state.maxScores = max;
  }

  function resetScores() {
    state.scores = {};
    state.currentQuestion = 0;
    state.history = [];
    state.ranking = [];
    for (const k of Object.keys(state.professions)) state.scores[k] = 0;
  }

  function computeRanking() {
    const items = [];
    for (const k of Object.keys(state.professions)) {
      const max = state.maxScores[k] || 0;
      const got = state.scores[k] || 0;
      const pct = max > 0 ? Math.round((got / max) * 100) : 0;
      items.push({ id: k, percent: pct });
    }
    items.sort((a, b) => b.percent - a.percent || a.id.localeCompare(b.id));
    return items;
  }

  // ---------- quiz ----------

  function renderQuestion() {
    const total = state.questions.length;
    const idx = state.currentQuestion;
    const q = state.questions[idx];

    const label = (getString('quiz.progress_template') || 'Вопрос {current} из {total}')
      .replace('{current}', idx + 1)
      .replace('{total}', total);
    document.getElementById('quiz-progress-label').textContent = label;
    document.getElementById('quiz-progress-fill').style.width = Math.round(((idx + 1) / total) * 100) + '%';

    document.getElementById('quiz-question').textContent = q.text;

    const list = document.getElementById('quiz-options');
    list.innerHTML = '';
    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiz-option';
      btn.textContent = opt.text;
      btn.addEventListener('click', () => answer(i));
      list.appendChild(btn);
    });
  }

  function answer(optionIdx) {
    const q = state.questions[state.currentQuestion];
    const opt = q.options[optionIdx];
    const weights = opt.weights || {};
    for (const [k, v] of Object.entries(weights)) {
      state.scores[k] = (state.scores[k] || 0) + v;
    }
    state.history.push({ qIdx: state.currentQuestion, weights });

    if (state.currentQuestion + 1 >= state.questions.length) {
      state.ranking = computeRanking();
      const fill = document.getElementById('quiz-progress-fill');
      if (fill) fill.style.width = '100%';
      showScreen('result');
    } else {
      state.currentQuestion += 1;
      renderQuestion();
    }
  }

  // ---------- result ----------

  function renderResult() {
    const ranking = state.ranking.length ? state.ranking : computeRanking();
    state.ranking = ranking;

    const top = ranking[0];
    const topProf = state.professions[top.id] || { title: top.id, emoji: '✨', short_description: '' };

    document.getElementById('result-emoji').textContent = topProf.emoji || '✨';
    document.getElementById('result-headline').textContent =
      (getString('result.headline_template') || 'Тебе подходит — {profession} на {percent}%')
        .replace('{profession}', topProf.title)
        .replace('{percent}', top.percent);
    document.getElementById('result-description').textContent = topProf.short_description || '';

    const list = document.getElementById('result-list');
    list.innerHTML = '';
    ranking.slice(1, 4).forEach(item => {
      const prof = state.professions[item.id] || { title: item.id, emoji: '•' };
      const li = document.createElement('li');
      li.className = 'result-item';
      li.innerHTML =
        '<div class="result-item__emoji"></div>' +
        '<div class="result-item__title"></div>' +
        '<div class="result-item__pct"></div>';
      li.children[0].textContent = prof.emoji || '•';
      li.children[1].textContent = prof.title;
      li.children[2].textContent = item.percent + '%';
      list.appendChild(li);
    });
  }

  // ---------- actions ----------

  function bindActions() {
    document.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', (e) => {
        const a = el.getAttribute('data-action');
        if (a === 'start') {
          resetScores();
          showScreen('quiz');
        } else if (a === 'to-lead') {
          showScreen('lead');
        } else if (a === 'open-channel') {
          openChannel();
        }
      });
    });
  }

  function openChannel() {
    const url = getString('outro.channel_url') || 'https://t.me/alfafuture';
    const tg = state.tg;
    if (tg && tg.openTelegramLink) {
      try { tg.openTelegramLink(url); return; } catch (e) { /* fallthrough */ }
    }
    window.open(url, '_blank', 'noopener');
  }

  // ---------- lead form ----------

  function bindLeadForm() {
    const form = document.getElementById('lead-form');
    const contactInput = document.getElementById('lead-contact');

    document.querySelectorAll('.contact-switch__btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.contact-switch__btn').forEach(x => x.classList.remove('is-active'));
        b.classList.add('is-active');
        state.contactType = b.getAttribute('data-contact-type');
        applyContactType();
      });
    });
    applyContactType();

    // TG contact button — only when API supports it
    const tg = state.tg;
    const tgBtn = document.getElementById('btn-tg-contact');
    if (tg && tg.initData && typeof tg.requestContact === 'function') {
      tgBtn.hidden = false;
      tgBtn.addEventListener('click', () => {
        try {
          tg.requestContact((ok, evt) => {
            if (!ok || !evt) return;
            const phone =
              (evt.responseUnsafe && evt.responseUnsafe.contact && evt.responseUnsafe.contact.phone_number) ||
              (evt.contact && evt.contact.phone_number) || '';
            if (phone) {
              // ensure phone tab
              document.querySelector('[data-contact-type="phone"]').click();
              contactInput.value = formatPhone(phone);
            }
          });
        } catch (e) { /* ignore */ }
      });
    }

    form.addEventListener('submit', onSubmit);
  }

  function applyContactType() {
    const input = document.getElementById('lead-contact');
    if (state.contactType === 'email') {
      input.type = 'email';
      input.autocomplete = 'email';
      input.inputMode = 'email';
      input.placeholder = getString('lead.contact_placeholder_email') || '';
    } else {
      input.type = 'tel';
      input.autocomplete = 'tel';
      input.inputMode = 'tel';
      input.placeholder = getString('lead.contact_placeholder_phone') || '';
    }
  }

  function formatPhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
      const d = '7' + digits.slice(1);
      return '+' + d.slice(0, 1) + ' ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9, 11);
    }
    return raw.startsWith('+') ? raw : '+' + digits;
  }

  function validatePhone(v) {
    const digits = v.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15;
  }
  function validateEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }

  function showFieldError(id, msgKey) {
    const el = document.getElementById(id);
    if (!msgKey) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = getString('lead.' + msgKey) || ' ';
    el.hidden = false;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.submitting) return;

    const name = document.getElementById('lead-name').value.trim();
    const contact = document.getElementById('lead-contact').value.trim();
    const consent = document.getElementById('lead-consent').checked;
    const honeypot = document.getElementById('lead-website').value.trim();

    const nameInput = document.getElementById('lead-name');
    const contactInput = document.getElementById('lead-contact');
    nameInput.classList.remove('is-invalid');
    contactInput.classList.remove('is-invalid');
    showFieldError('err-name', null);
    showFieldError('err-contact', null);
    showFieldError('err-consent', null);
    showFieldError('err-network', null);

    let bad = false;
    if (!name) { showFieldError('err-name', 'error_name'); nameInput.classList.add('is-invalid'); bad = true; }
    if (!contact) {
      showFieldError('err-contact', state.contactType === 'email' ? 'error_email' : 'error_phone');
      contactInput.classList.add('is-invalid');
      bad = true;
    } else if (state.contactType === 'email' && !validateEmail(contact)) {
      showFieldError('err-contact', 'error_email');
      contactInput.classList.add('is-invalid');
      bad = true;
    } else if (state.contactType === 'phone' && !validatePhone(contact)) {
      showFieldError('err-contact', 'error_phone');
      contactInput.classList.add('is-invalid');
      bad = true;
    }
    if (!consent) { showFieldError('err-consent', 'error_consent'); bad = true; }
    if (honeypot) { return; } // silently drop bots
    if (bad) return;

    const submitBtn = document.getElementById('btn-submit');
    const originalLabel = submitBtn.textContent;
    state.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = getString('lead.submitting') || 'Отправляем…';

    try {
      const apiBase = (state.strings.api && state.strings.api.base_url) || '';
      const url = apiBase.replace(/\/$/, '') + '/api/lead';
      const ranking = state.ranking.length ? state.ranking : computeRanking();
      const payload = {
        name,
        contact_type: state.contactType,
        contact_value: contact,
        consent: true,
        source: state.source,
        tg_init_data: (state.tg && state.tg.initData) || null,
        result: {
          top: ranking[0] || null,
          ranking: ranking.slice(0, 4),
        },
        user_agent: navigator.userAgent,
      };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json().catch(() => ({}));
      if (!data || data.ok !== true) throw new Error('bad response');
      showScreen('outro');
    } catch (err) {
      showFieldError('err-network', 'error_network');
    } finally {
      state.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }

  // ---------- go ----------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
