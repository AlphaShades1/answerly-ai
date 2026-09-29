// ── Answerly AI — Quiz Loader ────────────────────────────────────────────────
// Remembers the answers a student entered on one attempt and puts them back on
// the next one, so a retake does not mean re-entering everything by hand.
//
// Deliberately a SEPARATE content script rather than more code inside
// quizSolver.js / newQuizSolver.js. It has to run on both Canvas engines, and
// those two files are the most load-bearing in the extension; a bug in here can
// then only break this feature. It touches no solver state and shares no
// globals with them.
//
// What it stores is the option TEXT, never the letter or the input index.
// Canvas shuffles answer order between attempts, so a stored "B" would restore
// the wrong answer — the text survives shuffling.
//
// It only ever fills inputs that are EMPTY. An answer the student has already
// given on this attempt is never overwritten, so restoring can add information
// but can never take any away.
if (!window.__answerlyQuizMemoryLoaded) {
  window.__answerlyQuizMemoryLoaded = true;
(function () {
  'use strict';

  const STORE_KEY   = 'answerlyQuizMemory';
  const TOGGLE_KEY  = 'answerlyQuizLoaderActive';
  const MAX_QUIZZES = 40;                    // keep the store small and bounded
  const TTL_MS      = 1000 * 60 * 60 * 24 * 60;   // 60 days
  const SAVE_DEBOUNCE_MS = 700;

  let active = false;
  let memory = {};            // { quizKey: { ts, title, answers: { sig: {...} } } }
  let saveTimer = null;
  let restoredSigs = new Set();

  // ── Question discovery — both engines, keyed off markup only ───────────────
  const NQ_SEL      = '[data-automation="sdk-item-wrapper"]';
  const CLASSIC_SEL = 'div.question.display_question, div.display_question';

  function findQuestions() {
    const nq = document.querySelectorAll(NQ_SEL);
    if (nq.length) return Array.from(nq);
    return Array.from(document.querySelectorAll(CLASSIC_SEL));
  }

  // Which quiz this is. The pathname carries the course and the quiz/assignment
  // id, which stay the same across attempts; the title alone does not (two
  // courses can both have "Quiz 4").
  function quizKey() {
    const p = location.pathname;
    const m = p.match(/\/courses\/(\d+)\/(?:assignments|quizzes)\/(\d+)/);
    if (m) return 'c' + m[1] + '-q' + m[2];
    const t = quizTitle();
    return t ? 'title:' + t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  }

  function quizTitle() {
    try {
      const el = document.querySelector('#quiz_title, .quiz-header h1, h1.quiz-header__title, #content h1, h1');
      return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    } catch { return ''; }
  }

  // Stable per-question id: the stem text. Survives shuffled options and a
  // re-render, and differs between questions in the same quiz.
  function sigFor(qEl) {
    const stem =
      qEl.querySelector('div[tabindex="-1"] .user_content.enhanced') ||
      qEl.querySelector('.question_text.user_content') ||
      qEl.querySelector('.user_content.enhanced') ||
      qEl.querySelector('.question_text');
    const t = stem ? (stem.innerText || stem.textContent || '') : (qEl.innerText || '');
    return t.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
  }

  // The visible label for a choice input, which is what we store.
  function labelTextFor(input) {
    const lab = input.closest('label') ||
      (input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null);
    const scope = lab || input.parentElement;
    if (!scope) return '';
    const clone = scope.cloneNode(true);
    clone.querySelectorAll('input, .answerly-nq-btn, .answerly-btn, .answerly-nq-card').forEach(n => n.remove());
    return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // ── Reading the student's current answers ──────────────────────────────────
  function readAnswers(qEl) {
    const out = { choices: [], texts: [], selects: [] };
    qEl.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(i => {
      if (i.checked) { const t = labelTextFor(i); if (t) out.choices.push(t); }
    });
    qEl.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach(i => {
      const v = String(i.value || '').trim();
      if (v) out.texts.push(v);
    });
    qEl.querySelectorAll('select').forEach(s => {
      if (s.selectedIndex > 0) {
        const o = s.options[s.selectedIndex];
        out.selects.push(String(o && o.text || '').trim());
      }
    });
    const any = out.choices.length || out.texts.length || out.selects.length;
    return any ? out : null;
  }

  // ── Writing them back ──────────────────────────────────────────────────────
  // Canvas persists an answer when it sees the events a real interaction fires,
  // so setting .value or .checked alone would look filled in and save nothing.
  function fire(el, types) {
    types.forEach(t => { try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch {} });
  }

  function applyAnswers(qEl, saved) {
    let filled = 0;

    // Choices: only when NOTHING is selected for this question yet.
    const inputs = Array.from(qEl.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    if (saved.choices && saved.choices.length && inputs.length && !inputs.some(i => i.checked)) {
      const want = saved.choices.map(norm);
      inputs.forEach(i => {
        if (i.disabled) return;
        if (want.includes(norm(labelTextFor(i)))) {
          try { i.click(); } catch { i.checked = true; }
          if (!i.checked) { i.checked = true; fire(i, ['input', 'change', 'click']); }
          filled++;
        }
      });
    }

    // Text inputs, in order, skipping any the student has already typed into.
    const texts = Array.from(qEl.querySelectorAll('input[type="text"], input[type="number"], textarea'))
      .filter(i => !i.disabled);
    if (saved.texts && saved.texts.length) {
      texts.forEach((el, idx) => {
        if (String(el.value || '').trim()) return;
        const v = saved.texts[idx];
        if (v === undefined) return;
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(el), 'value')?.set;
        try { setter ? setter.call(el, v) : (el.value = v); } catch { el.value = v; }
        fire(el, ['input', 'change', 'blur']);
        filled++;
      });
    }

    // Dropdowns, in order, skipping any already chosen.
    const sels = Array.from(qEl.querySelectorAll('select')).filter(s => !s.disabled);
    if (saved.selects && saved.selects.length) {
      sels.forEach((s, idx) => {
        if (s.selectedIndex > 0) return;
        const want = norm(saved.selects[idx]);
        if (!want) return;
        for (let k = 0; k < s.options.length; k++) {
          if (norm(s.options[k].text) === want) { s.selectedIndex = k; fire(s, ['input', 'change']); filled++; break; }
        }
      });
    }
    return filled;
  }

  // ── Storage ────────────────────────────────────────────────────────────────
  function loadMemory(cb) {
    try {
      chrome.storage.local.get([STORE_KEY, TOGGLE_KEY], (s) => {
        if (chrome.runtime.lastError || !s) { cb && cb(); return; }
        memory = (s[STORE_KEY] && typeof s[STORE_KEY] === 'object') ? s[STORE_KEY] : {};
        active = !!s[TOGGLE_KEY];
        cb && cb();
      });
    } catch { cb && cb(); }
  }

  function persist() {
    // Oldest quizzes fall off first, and anything past the TTL goes regardless,
    // so this can never grow without bound in a student's browser.
    const now = Date.now();
    const entries = Object.entries(memory)
      .filter(([, v]) => v && v.ts && now - v.ts < TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, MAX_QUIZZES);
    memory = Object.fromEntries(entries);
    try { chrome.storage.local.set({ [STORE_KEY]: memory }, () => void chrome.runtime.lastError); } catch {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(captureNow, SAVE_DEBOUNCE_MS);
  }

  function captureNow() {
    if (!active) return;
    const key = quizKey();
    if (!key) return;
    const qs = findQuestions();
    if (!qs.length) return;
    const bucket = memory[key] || { ts: Date.now(), title: quizTitle(), answers: {} };
    let touched = 0;
    qs.forEach(qEl => {
      const sig = sigFor(qEl);
      if (!sig || sig.length < 10) return;
      const ans = readAnswers(qEl);
      if (!ans) return;
      bucket.answers[sig] = ans;
      touched++;
    });
    if (!touched) return;
    bucket.ts = Date.now();
    bucket.title = bucket.title || quizTitle();
    memory[key] = bucket;
    persist();
  }

  function restore() {
    if (!active) return;
    const key = quizKey();
    if (!key || !memory[key]) return;
    const saved = memory[key].answers || {};
    let filled = 0;
    findQuestions().forEach(qEl => {
      const sig = sigFor(qEl);
      if (!sig || !saved[sig]) return;
      if (restoredSigs.has(sig)) return;       // never fight the student twice
      const n = applyAnswers(qEl, saved[sig]);
      if (n) { restoredSigs.add(sig); filled += n; }
    });
    if (filled) console.log('[Answerly] Quiz Loader restored ' + filled + ' answer(s) from a previous attempt.');
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  document.addEventListener('change', (e) => {
    if (!active) return;
    const t = e.target;
    if (t && t.closest && t.closest(NQ_SEL + ', ' + CLASSIC_SEL)) scheduleSave();
  }, true);

  document.addEventListener('input', (e) => {
    if (!active) return;
    const t = e.target;
    if (t && t.closest && t.closest(NQ_SEL + ', ' + CLASSIC_SEL)) scheduleSave();
  }, true);

  // Capture once more on the way out — the last answer before Next or Submit is
  // the one most likely to be missed by a debounce.
  window.addEventListener('beforeunload', () => { try { captureNow(); } catch {} });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { try { captureNow(); } catch {} }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[TOGGLE_KEY]) {
      active = !!changes[TOGGLE_KEY].newValue;
      if (active) { restoredSigs = new Set(); loadMemory(restore); }
    }
    if (changes[STORE_KEY] && changes[STORE_KEY].newValue) memory = changes[STORE_KEY].newValue;
  });

  // Same reasoning as the solvers' recovery timer: New Quizzes re-renders
  // constantly and a one-shot pass at load would miss questions that mount
  // later, or a Next that swaps the question without a page load.
  setInterval(() => {
    if (!active) return;
    if (!findQuestions().length) return;
    restore();
    captureNow();
  }, 2500);

  loadMemory(() => { if (active) setTimeout(restore, 1200); });
})();
}
