// ── Answerly AI — New Quizzes (Canvas Quizzes.LTI) Content Script ─────────────
// Handles quiz-lti-iad-prod.instructure.com iframes embedded in Canvas pages.
//
// Architecture note:
//   This script is injected via manifest.json content_scripts (all_frames: true)
//   so it auto-runs inside the quiz-lti iframe. Because chrome.tabs.sendMessage
//   targets the main frame by default, this script uses chrome.storage.onChanged
//   to receive popup state changes instead of runtime messages.

// Runs in ANY frame, and decides what to do from the MARKUP it finds — not from
// which frame it is in.
//
// This used to bail out whenever it was in the main frame, on the assumption that
// New Quizzes always lived in the quiz-lti iframe and quizSolver.js always owned
// the main document. Instructure broke that assumption: "New Quizzes Canvas
// Native Integration" moves New Quizzes OUT of the iframe and renders it directly
// in the main Canvas page. It was switched on by default for everyone on
// 2026-07-01 and is enforced on 2026-08-15. Once an institution flipped over,
// this file refused to run on the only page that now contains New Quizzes, so
// nothing worked at all — while quizSolver.js sat on the same page hunting for
// Classic Quizzes markup that is no longer there.
//
// The old frame check did solve a real problem: with both engines live on one
// document, each one's DOM writes re-triggered the other's observer and the page
// ground to a halt. That is now handled by ownership instead — this engine only
// acts when New Quizzes markup is actually present (isNQPage()), and
// quizSolver.js stands down on exactly that condition.
if (window.__answerlyNQSolverLoaded) { /* already running — guard against double injection */ }
else {
window.__answerlyNQSolverLoaded = true;

(function () {
  'use strict';

  let solverActive            = false;
  let stealthHidden           = false;
  let screenshotStealthActive = false;
  let observer                = null;
  let currentCode             = null;
  // True once a real state read has landed, so a later blank read can be told
  // apart from a genuine "user turned everything off". Mirrors quizSolver.js.
  let stateReady              = false;
  const INJECTED    = 'answerly-nq-injected';

  // ── Stealth solve keybind (customizable) ─────────────────────────────────────
  // Mirrors quizSolver.js so the shortcut works on New Quizzes too. quizSolver's
  // handler looks up the question with Classic selectors that do not exist here,
  // so on a native New Quiz its keybind found nothing. This one keys off the New
  // Quizzes wrapper instead, and only acts on a New Quizzes page so the two
  // handlers never both fire for one press. Same as Classic: only in Quiz Stealth
  // (the invisible ? button), never a bare modifier, never while typing, and it
  // clears the done/opened marks so the key always forces a fresh (billed) solve.
  let stealthKeybind = { enabled: false, key: '' };
  let keybindMouseX  = -1, keybindMouseY = -1;
  const KEYBIND_BLOCKED = [
    'Shift','Control','Alt','Meta','AltGraph','CapsLock','Tab','Enter','Escape',
    'ContextMenu','OS','NumLock','ScrollLock','Dead','Unidentified','Process',
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',
  ];
  chrome.storage.local.get('answerlyStealthKeybind', (s) => {
    if (s.answerlyStealthKeybind) stealthKeybind = s.answerlyStealthKeybind;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (changes.answerlyStealthKeybind) {
      stealthKeybind = changes.answerlyStealthKeybind.newValue || { enabled: false, key: '' };
    }
  });
  document.addEventListener('mousemove', (e) => {
    keybindMouseX = e.clientX; keybindMouseY = e.clientY;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!stealthKeybind.enabled || !stealthKeybind.key) return;
    if (!stealthHidden) return;                 // only in Quiz Stealth
    if (!isNQPage()) return;                     // Classic pages are quizSolver's job
    if (KEYBIND_BLOCKED.includes(stealthKeybind.key)) return;
    if (e.repeat) return;
    if (e.metaKey || (e.ctrlKey && !e.altKey) || (e.altKey && !e.ctrlKey)) return;
    const want = stealthKeybind.key;
    const hit  = want.length === 1
      ? e.key.length === 1 && e.key.toLowerCase() === want.toLowerCase()
      : e.key === want;
    if (!hit) return;
    const t = e.target;
    if (t && (t.isContentEditable ||
        (t.matches && t.matches('textarea, input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], input:not([type])')))) return;

    let qEl = null;
    if (keybindMouseX >= 0) {
      const el = document.elementFromPoint(keybindMouseX, keybindMouseY);
      qEl = el && el.closest('[data-automation="sdk-item-wrapper"]');
    }
    if (!qEl) {
      if (keybindMouseX >= 0) return;            // mouse moved but not over a question
      const qs = findNQQuestions();
      if (qs.length !== 1) return;               // only the one-question-per-page case
      qEl = qs[0];
    }
    const trigger = qEl.querySelector(`.answerly-nq-btn.${INJECTED}:not(.answerly-nq-cam-btn)`);
    if (trigger) {
      e.preventDefault();
      delete trigger.dataset.done;               // force a fresh solve, so usage still counts
      delete trigger.dataset.opened;
      qEl.querySelectorAll('.answerly-nq-card').forEach(c => { delete c.dataset.loaded; });
      trigger.click();
    }
  }, true);

  // ── Maths recovery ──────────────────────────────────────────────────────────
  // Equations are rendered as pictures, not text: Canvas emits
  // <img class="equation_image" data-equation-content="\log_2 16 = x">, MathJax
  // keeps the TeX in an <annotation>. innerText sees neither, so a question read
  // as "Solve for x:" with the equation silently dropped — and the model was
  // asked to answer something it could not see. Mirrors quizSolver.js.
  function nqEquationLatex(img) {
    return (img.getAttribute('data-equation-content') ||
            img.getAttribute('title') ||
            img.getAttribute('alt') || '').replace(/^\s*LaTeX:\s*/i, '').trim();
  }

  function nqIsEquationImage(img) {
    return (img.classList && img.classList.contains('equation_image')) ||
           img.hasAttribute('data-equation-content') ||
           /^\s*LaTeX:/i.test(img.getAttribute('alt') || '');
  }

  /** innerText plus any equations it dropped, appended in document order. */
  function nqStemText(stemContent) {
    if (!stemContent) return '';
    // innerText is empty on a node that is not being rendered, which is what
    // nqStemWithoutSelectOptions() passes in, so fall back to textContent.
    const base = (stemContent.innerText || stemContent.textContent || '').trim();
    const eqs = [];
    stemContent.querySelectorAll('img').forEach(img => {
      if (!nqIsEquationImage(img)) return;
      const tex = nqEquationLatex(img);
      if (tex) eqs.push(tex);
    });
    stemContent.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(a => {
      const tex = (a.textContent || '').trim();
      if (tex) eqs.push(tex);
    });
    const uniq = eqs.filter((t, i, arr) => arr.indexOf(t) === i);
    return uniq.length ? (base ? base + '\n' : '') + uniq.join('\n') : base;
  }

  /**
   * The stem, with each inline <select> reduced to a numbered blank.
   *
   * A dropdown renders its whole option list as text, so the stem reached the
   * model as "Glycolysis occurs in the [ Select ] cytoplasm nucleus
   * mitochondrion and yields [ Select ] ATP NADH water" — every candidate as
   * prose, with the first of each list reading like the answer. Mirrors
   * stemWithoutSelectOptions() in quizSolver.js; the two engines share no
   * module, so this pair has to be kept in step.
   *
   * Each row still carries its own option list, which is where the model is
   * actually asked to choose. Returns null when the stem holds no select, so
   * every other question type keeps its existing text byte for byte.
   *
   * The clone is not rendered, so its text comes from textContent and any
   * screen-reader-only label on a select is included. That is accepted: those
   * labels name the blank they belong to, which helps rather than misleads,
   * and it only ever applies to stems that contain a dropdown.
   */
  function nqStemWithoutSelectOptions(stemContent) {
    if (!stemContent || !stemContent.querySelector || !stemContent.querySelector('select')) return null;
    try {
      const clone = stemContent.cloneNode(true);
      clone.querySelectorAll('select').forEach((sel, i) => {
        sel.replaceWith(document.createTextNode(` [blank ${i + 1}] `));
      });
      // Never inserted into the page: attaching it would trip the MutationObserver
      // into a re-injection pass on every extract.
      const out = nqStemText(clone);
      return out && out.trim() ? out : null;
    } catch { return null; }
  }

  // Structural maths markup whose meaning innerText cannot carry: a fraction bar
  // and an exponent are POSITION, and flattening throws the position away.
  // Mirrors quizSolver.js — the two engines share no module, so this is a
  // deliberate duplicate and the pair must be kept in step.
  const NQ_LOSSY_MATH_SEL = 'math, mfrac, msup, msub, msqrt, mroot, munderover, sup, sub, .frac, .fraction';
  const NQ_MATH_SYM_RE    = /[∫∑∏√∂∇≠≤≥±→∞]/;
  // Unicode Mathematical Alphanumeric Symbols — styled letters some instructors
  // paste in place of real markup (U+1D465 is the italic x these quizzes use).
  const NQ_MATH_ALNUM_RE  = /[\u{1D400}-\u{1D7FF}]/u;

  /**
   * True when this question is maths whose notation did NOT survive extraction.
   *
   * nqStemText() recovers LaTeX from Canvas equation images and MathJax
   * annotation nodes, and where it fires the model sees the real expression. A
   * quiz written with bare MathML, or with unicode italics and <sup>, leaves it
   * nothing to recover: innerText renders 6/(x^3+x^2-2x) as "6 x 3 + x 2 - 2 x",
   * losing the fraction and the exponents. The model then answers a different
   * question and is confidently wrong — a Classic partial-fractions quiz scored
   * 0/2 exactly this way before the same guard was added there.
   */
  // ── Image-dependent questions ──────────────────────────────────────────────
  // A question whose answer lives in a picture cannot be solved from its text.
  // Sending it anyway does not fail loudly: the model just picks an option, which
  // looks exactly like a normal answer and is right about a quarter of the time.
  // quizSolver.js has refused these for a long time; this engine did not, so on
  // New Quizzes every diagram question was answered blind — including in stealth,
  // where the wrong option was auto-selected with nothing shown to the student.
  const NQ_NEEDS_SCREENSHOT_RE = /refer to|see (the |figure|diagram|image|graph|chart|table|packet|trace|capture|exhibit)|based on (the |figure|diagram|image|above)|shown (in|below|above)|in the (figure|diagram|image|graph|chart|table|packet|capture)/i;

  function nqStemEl(qEl) {
    const stemContainer = qEl.querySelector('div[tabindex="-1"]');
    return (stemContainer
      ? stemContainer.querySelector('.user_content.enhanced')
      : qEl.querySelector('.user_content.enhanced')) || qEl;
  }

  function nqQuestionHasImage(qEl) {
    const stemContent = nqStemEl(qEl);
    if (!stemContent) return false;
    return [...stemContent.querySelectorAll('img')].some(img => {
      const src = img.getAttribute('src');
      if (src === '') return false;
      // An EQUATION image whose LaTeX came back is readable — treating it as an
      // opaque picture would skip every maths question and hand the student a
      // blank paper. One with no recoverable LaTeX is as opaque as a photo.
      if (nqIsEquationImage(img)) return !nqEquationLatex(img);
      return true;
    });
  }

  // The single gate, mirroring quizSolver.js's needsScreenshotFor().
  function nqNeedsScreenshotFor(qEl, questionText) {
    return nqQuestionHasImage(qEl)
        || NQ_NEEDS_SCREENSHOT_RE.test(questionText || '')
        || nqMathIsLossy(qEl);
  }

  function nqMathIsLossy(qEl) {
    try {
      const stemContainer = qEl.querySelector('div[tabindex="-1"]');
      const stemContent   = (stemContainer
        ? stemContainer.querySelector('.user_content.enhanced')
        : qEl.querySelector('.user_content.enhanced')) || qEl;
      // If any LaTeX was recoverable, the model sees the true expression.
      const hasTex =
        [...stemContent.querySelectorAll('img')].some(img => nqIsEquationImage(img) && nqEquationLatex(img)) ||
        [...stemContent.querySelectorAll('annotation[encoding="application/x-tex"]')]
          .some(a => (a.textContent || '').trim());
      if (hasTex) return false;
      const txt = stemContent.innerText || '';
      if (!NQ_MATH_SYM_RE.test(txt) && !NQ_MATH_ALNUM_RE.test(txt)) return false;  // not maths
      return !!stemContent.querySelector(NQ_LOSSY_MATH_SEL) || NQ_MATH_ALNUM_RE.test(txt);
    } catch { return false; }   // never let detection break solving
  }

  // A sleeping MV3 service worker rejects the first message with "Could not
  // establish connection / Receiving end does not exist". That request never
  // reached the backend, so retrying is safe and cannot double-bill. Without it
  // the first solve after an idle period silently did nothing.
  // Deliberately does NOT retry "message port closed", which can mean the
  // request WAS delivered and could therefore charge twice.
  // ── Quiz identity ─────────────────────────────────────────────────────────
  // The title of the quiz being solved, sent with every solve so the backend can
  // tell which quiz a set of solves belongs to. Without it, scores and solves
  // could not be joined: a reported score looked identical whether Answerly had
  // solved that quiz or the student had merely opened an old results page, which
  // made quizzes the extension never touched look like Answerly failures.
  // Matches extractTitle() in scoreReporter.js so the two sides agree.
  // Cached per URL path, not once per page session. A cache that never expired
  // was wrong the moment a student moved from one quiz to the next without a full
  // reload: every later solve kept the FIRST quiz's name, so the score for the
  // quiz they actually took came back reading "Answerly did not solve this".
  let quizTitleCache = null;
  let quizTitlePath  = null;
  function getQuizTitle() {
    const path = location.pathname;
    if (quizTitlePath !== path) quizTitleCache = null;   // different quiz — re-read
    if (quizTitleCache !== null) return quizTitleCache;
    let t = '';
    try {
      const el = document.querySelector('#quiz_title, .quiz-header h1, h1.quiz-header__title, #content h1, h1');
      t = el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      if (!t) {
        const crumbs = document.querySelectorAll('#breadcrumbs li a, nav[aria-label="breadcrumbs"] a');
        if (crumbs.length) {
          t = String(crumbs[crumbs.length - 1].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
      }
    } catch { t = ''; }
    // Only cache a real hit — the header can mount after the first question on
    // a SPA-rendered page, and caching '' would lock in the miss for the attempt.
    if (t) { quizTitleCache = t; quizTitlePath = path; }
    return t;
  }

  // ── Did the answer actually land? ─────────────────────────────────────────
  // The backend logs what the AI answered; only the page knows whether that
  // answer was successfully selected or typed in. Reporting it closes the blind
  // spot where the log looks perfect while nothing is being filled in.
  // Fire-and-forget — never blocks or fails a solve.
  function reportOutcome(resp, matched, detail) {
    try {
      const id = resp && resp.solveId;
      if (!id) return;
      chrome.runtime.sendMessage(
        { type: 'REPORT_OUTCOME', solveId: id, matched: !!matched, detail },
        () => void chrome.runtime.lastError
      );
    } catch { /* extension context invalidated */ }
  }


  // ── Cross-question context ───────────────────────────────────────────────────
  // Every question visible on the quiz, plus any seen earlier on a one-question-
  // at-a-time quiz, sent along with each solve. Quizzes answer each other: on a
  // real ASL quiz one question's choices said "31 schools in 13 African
  // countries" and the next question, solved alone, came back "13-17 schools".
  //
  // Remembered questions live in chrome.storage.local, never in the page's own
  // sessionStorage/localStorage: anything written there is readable by Canvas
  // and by proctoring scripts, and stealth users must leave no trace.
  const QUIZ_DIGEST_LIMIT  = 10000;  // characters sent (backend caps at the same)
  const QUIZ_DIGEST_MAX_Q  = 60;     // questions remembered per quiz
  const QUIZ_DIGEST_TTL_MS = 12 * 3600 * 1000;
  const QUIZ_DIGEST_STORE  = 'answerlyQuizDigests';
  const quizDigestKey = (() => {
    const m = location.pathname.match(/\/courses\/\d+\/(?:quizzes|assignments)\/\d+/);
    return location.host + (m ? m[0] : location.pathname);
  })();
  const quizDigestSeen = new Map();   // insertion order = order first seen
  let quizDigestCache = { at: 0, text: '' };
  let quizDigestSig   = '';        // what the page looked like at the last scan
  let quizDigestSaveTimer = null;

  try {
    chrome.storage.local.get(QUIZ_DIGEST_STORE, (s) => {
      if (chrome.runtime.lastError || !s) return;
      const entry = (s[QUIZ_DIGEST_STORE] || {})[quizDigestKey];
      if (!entry || !Array.isArray(entry.list) || Date.now() - entry.at > QUIZ_DIGEST_TTL_MS) return;
      // Earlier questions go first, keeping the list in quiz order.
      const current = [...quizDigestSeen.entries()];
      quizDigestSeen.clear();
      entry.list.forEach(e => { if (e && e.k) quizDigestSeen.set(e.k, e); });
      current.forEach(([k, v]) => quizDigestSeen.set(k, v));
      quizDigestCache.at = 0;
      quizDigestSig = '';
    });
  } catch { /* extension context gone — nothing to restore */ }

  function saveQuizDigest() {
    clearTimeout(quizDigestSaveTimer);
    quizDigestSaveTimer = setTimeout(() => {
      try {
        chrome.storage.local.get(QUIZ_DIGEST_STORE, (s) => {
          if (chrome.runtime.lastError) return;
          const all = (s && s[QUIZ_DIGEST_STORE]) || {};
          all[quizDigestKey] = { at: Date.now(), list: [...quizDigestSeen.values()].slice(-QUIZ_DIGEST_MAX_Q) };
          // Keep only recent quizzes so this never grows without bound.
          const keep = Object.entries(all)
            .filter(([, v]) => v && Date.now() - v.at < QUIZ_DIGEST_TTL_MS)
            .sort((a, b) => b[1].at - a[1].at).slice(0, 20);
          chrome.storage.local.set({ [QUIZ_DIGEST_STORE]: Object.fromEntries(keep) }, () => void chrome.runtime.lastError);
        });
      } catch { /* ignore */ }
    }, 1000);
  }

  // Called on every recovery tick as well as on each solve, so a question the
  // student only LOOKED at on a one-at-a-time quiz is still remembered. Re-reads
  // the questions only when the page changed, so a static 60-question page is
  // not re-parsed every two seconds.
  function getRelatedQuestions() {
    const qEls = findNQQuestions();
    const sig  = qEls.length + ':' + qEls.map(q => (q.textContent || '').length).join(',');
    if (sig === quizDigestSig && quizDigestCache.at) return quizDigestCache.text;
    quizDigestSig = sig;
    let grew = false;
    for (const qEl of qEls) {
      let d;
      try { d = extractNQData(qEl); } catch { continue; }
      const q = String((d && d.questionText) || '').replace(/\s+/g, ' ').trim();
      if (!q) continue;
      const k = q.slice(0, 200).toLowerCase();
      const o = ((d && d.options) || [])
        .map(x => String(x).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 10);
      if (!quizDigestSeen.has(k)) grew = true;
      quizDigestSeen.set(k, { k, q: q.slice(0, 300), o });
    }
    while (quizDigestSeen.size > QUIZ_DIGEST_MAX_Q) quizDigestSeen.delete(quizDigestSeen.keys().next().value);
    if (grew) saveQuizDigest();
    const list = [...quizDigestSeen.values()];
    // A single question has nothing to cross-reference.
    let text = list.length < 2 ? '' : list
      .map((e, i) => `Q${i + 1}. ${e.q}` + (e.o.length ? `\n   Choices: ${e.o.join(' | ')}` : ''))
      .join('\n');
    if (text.length > QUIZ_DIGEST_LIMIT) text = text.slice(0, QUIZ_DIGEST_LIMIT);
    quizDigestCache = { at: Date.now(), text };
    return text;
  }


  // ── "Upload your material" prompt ────────────────────────────────────────────
  // A quiz about one specific film, lecture or reading tests what THAT source
  // said, and general knowledge can only guess at it. Two real quizzes lost most
  // of their points exactly this way — a film quiz, and an ASL quiz asking for
  // strategies "as listed in the text" — with no notes uploaded, because the
  // students had no idea it mattered. Shown once per quiz, in normal mode only:
  // stealth must stay invisible, so it never appears there.
  const NOTES_NUDGE_RE = new RegExp([
    '\\b(film|video|documentary|movie|lecture|podcast)\\b',
    '\\b(listed|stated|described|discussed|mentioned|shown|explained|defined) in (the|your|this) (text|textbook|reading|article|chapter|lecture|video|film|book|notes)\\b',
    '\\baccording to (the|your|this) (text|textbook|reading|article|author|chapter|lecture|video|film|book|notes|professor|instructor)\\b',
    '\\bin (the|your) (textbook|reading|assigned reading)\\b',
  ].join('|'), 'i');
  // A weekly or chapter quiz is drawn from that week's assigned material even
  // when no question says so out loud. "Week 12 Quiz" cost one student ~33
  // points on two textbook definitions ("consultant", "How?") that every model
  // we tested answers from general knowledge instead - both flip to correct
  // once the chapter is uploaded. Title only: a question body that happens to
  // mention a chapter number is not the same signal.
  const NOTES_NUDGE_TITLE_RE = /\b(week|chapter|ch\.?|module|unit|lesson)\s*#?\s*\d{1,2}\b/i;
  const NOTES_NUDGE_STORE = 'answerlyNotesNudgeShown';
  let notesNudgeState = 'pending';   // 'pending' → 'checking' → 'done'
  let notesNudgeTries = 0;

  function notesNudgeSource(match) {
    const w = String(match).toLowerCase();
    if (/film|video|documentary|movie/.test(w)) return 'a specific film or video';
    if (/lecture|podcast|professor|instructor/.test(w)) return 'a specific lecture';
    return 'a specific reading or textbook';
  }

  function maybeShowNotesNudge() {
    if (notesNudgeState !== 'pending' || !solverActive || stealthHidden) return;
    if (!(isNQPage())) return;
    // Questions can render late, so keep looking for ~20s, then stop for good.
    if (++notesNudgeTries > 10) { notesNudgeState = 'done'; return; }
    try { getRelatedQuestions(); } catch {}
    const texts = [getQuizTitle(), ...[...quizDigestSeen.values()].map(e => e.q)];
    try { texts.push(getNQQuizContext()); } catch {}
    const m = texts.join('\n').match(NOTES_NUDGE_RE);
    let source = m ? notesNudgeSource(m[0]) : '';
    if (!source && NOTES_NUDGE_TITLE_RE.test(String(getQuizTitle() || ''))) source = 'one week or chapter of your course';
    if (!source) return;
    notesNudgeState = 'checking';
    try {
      chrome.storage.local.get(['answerlyContextFile', NOTES_NUDGE_STORE], (s) => {
        if (chrome.runtime.lastError || !s) { notesNudgeState = 'pending'; return; }
        notesNudgeState = 'done';
        if (s.answerlyContextFile && s.answerlyContextFile.context) return;  // already uploaded
        const shown = s[NOTES_NUDGE_STORE] || {};
        if (shown[quizDigestKey]) return;                                   // once per quiz
        if (!solverActive || stealthHidden) return;                         // mode changed meanwhile
        shown[quizDigestKey] = Date.now();
        const keep = Object.entries(shown).sort((a, b) => b[1] - a[1]).slice(0, 200);
        chrome.storage.local.set({ [NOTES_NUDGE_STORE]: Object.fromEntries(keep) }, () => void chrome.runtime.lastError);
        showNotesNudge(source);
      });
    } catch { notesNudgeState = 'done'; }
  }

  function showNotesNudge(source) {
    if (document.getElementById('answerly-notes-nudge')) return;
    const accent = (theme && theme.accentColor) || DEFAULT_THEME.accentColor;
    const box = document.createElement('div');
    box.id = 'answerly-notes-nudge';
    box.className = INJECTED;
    box.setAttribute('role', 'status');
    box.style.cssText = [
      'position:fixed', 'left:16px', 'bottom:16px', 'z-index:2147483646', 'max-width:320px',
      'background:#0f0f12', 'color:#f0f0f5', 'border:1px solid #2e2e3e', 'border-left:4px solid ' + accent,
      'border-radius:10px', 'padding:12px 34px 12px 14px', 'box-shadow:0 8px 28px rgba(0,0,0,.45)',
      "font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", 'text-align:left',
    ].map(r => r + ' !important').join(';');
    const title = document.createElement('div');
    title.textContent = 'Better answers for this quiz';
    title.style.cssText = 'font-weight:700 !important;margin-bottom:4px !important;color:' + accent + ' !important';
    const body = document.createElement('div');
    body.textContent = 'This quiz looks like it is based on ' + source + '. Answerly is more accurate on quizzes like this when you upload your notes, transcript or reading. Click the Answerly icon, then Upload notes.';
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.style.cssText = 'position:absolute !important;top:6px !important;right:8px !important;background:none !important;border:none !important;color:#8a8aa0 !important;font-size:18px !important;line-height:1 !important;cursor:pointer !important;padding:2px 4px !important';
    x.addEventListener('click', () => box.remove());
    box.append(title, body, x);
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 15000);
  }

  function sendSolve(msg, cb, attempt) {
    attempt = attempt || 1;
    // Attach the quiz's own description / shared stimulus on the FIRST send only
    // (retries reuse the same msg object, which already carries it). Purely
    // additive: with nothing to attach the request is unchanged.
    if (msg && (msg.type === 'SOLVE_QUESTION' || msg.type === 'SOLVE_MATCHING') &&
        !('quizContext' in msg)) {
      let qc = '';
      try { qc = getNQQuizContext(); } catch {}
      if (qc) msg.quizContext = qc;
    }
    // Cross-question context: the rest of the quiz, for consistency between
    // questions. Only for text solves; nothing is attached on a one-question page.
    if (msg && (msg.type === 'SOLVE_QUESTION' || msg.type === 'SOLVE_MATCHING') &&
        !('relatedQuestions' in msg)) {
      let rq = '';
      try { rq = getRelatedQuestions(); } catch {}
      if (rq) msg.relatedQuestions = rq;
    }
    // Quiz identity — attached to every solve type, including screenshots.
    if (msg && !('quizTitle' in msg)) {
      const qt = getQuizTitle();
      if (qt) msg.quizTitle = qt;
    }
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        const undelivered = err && /could not establish connection|receiving end does not exist/i
          .test(err.message || '');
        if (undelivered && attempt < 4) {
          setTimeout(() => sendSolve(msg, cb, attempt + 1), 300 * attempt);
          return;
        }
        cb(resp);
      });
    } catch {
      cb(undefined);
    }
  }

  const DEFAULT_THEME = {
    accentColor: '#7c5cfc',
    cardBg:      '#1a1a2e',
    cardBorder:  '#7c5cfc',
    answerColor: '#ffffff',
    hintColor:   '#c0c0d8',
    opacity:     100,
  };
  let theme = { ...DEFAULT_THEME };

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('answerly-nq-styles')) return;
    const s = document.createElement('style');
    s.id = 'answerly-nq-styles';
    s.textContent = `
      .answerly-nq-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important;
        height: 26px !important;
        border-radius: 50% !important;
        border: none !important;
        background: #7c5cfc !important;
        color: #fff !important;
        cursor: pointer !important;
        margin-left: 8px !important;
        vertical-align: middle !important;
        font-size: 13px !important;
        box-shadow: 0 2px 8px rgba(124,92,252,.5) !important;
        transition: transform .15s, box-shadow .15s, opacity .15s !important;
        flex-shrink: 0 !important;
        position: relative !important;
        z-index: 9999 !important;
        line-height: 1 !important;
      }
      .answerly-nq-btn:hover {
        transform: scale(1.12) !important;
        box-shadow: 0 3px 14px rgba(124,92,252,.75) !important;
      }
      .answerly-nq-btn:active { transform: scale(0.95) !important; }
      .answerly-nq-btn.answerly-invisible {
        opacity: 0 !important;
        box-shadow: none !important;
        background: transparent !important;
        pointer-events: all !important;
      }
      .answerly-nq-btn.answerly-invisible:hover {
        opacity: 0 !important;
        transform: none !important;
        box-shadow: none !important;
      }
      /* Ensure the header row never blocks button clicks */
      [data-automation="sdk-position-box-text"],
      [data-automation="sdk-interaction-type-name-div"] {
        pointer-events: none !important;
      }

      .answerly-nq-card {
        margin: 12px 0 !important;
        background: #1a1a2e !important;
        border: 1px solid #3a3a5c !important;
        border-radius: 10px !important;
        padding: 14px 16px !important;
        font-size: 13px !important;
        line-height: 1.55 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        animation: answerly-nq-in .2s ease !important;
        box-sizing: border-box !important;
      }
      @keyframes answerly-nq-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .answerly-nq-badge {
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: .8px !important;
        color: #7c5cfc !important;
        text-transform: uppercase !important;
        margin-bottom: 8px !important;
        display: flex !important;
        align-items: center !important;
        gap: 5px !important;
      }

      .answerly-nq-hint-row {
        color: #c0c0d8 !important;
        margin-bottom: 10px !important;
        font-size: 13px !important;
      }
      .answerly-nq-hint-lbl {
        color: #fff !important;
        font-weight: 700 !important;
        margin-right: 4px !important;
      }

      .answerly-nq-reveal {
        background: none !important;
        border: 1px solid #4a4a6a !important;
        color: #a090f0 !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        padding: 5px 12px !important;
        border-radius: 6px !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        transition: background .15s, border-color .15s !important;
      }
      .answerly-nq-reveal:hover {
        background: rgba(124,92,252,.15) !important;
        border-color: #7c5cfc !important;
        color: #fff !important;
      }

      .answerly-nq-answer-row {
        margin-top: 10px !important;
        padding: 10px 14px !important;
        background: #0f0f1e !important;
        border: 1px solid #7c5cfc !important;
        border-radius: 8px !important;
        animation: answerly-nq-in .15s ease !important;
      }
      .answerly-nq-answer-lbl {
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: .8px !important;
        color: #7c5cfc !important;
        text-transform: uppercase !important;
        display: block !important;
        margin-bottom: 4px !important;
      }
      .answerly-nq-answer-text {
        color: #ffffff !important;
        font-weight: 800 !important;
        font-size: 14px !important;
        line-height: 1.4 !important;
      }

      .answerly-nq-loading {
        color: #a090f0 !important;
        font-size: 12px !important;
        font-style: italic !important;
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
      }
      .answerly-nq-spinner {
        width: 12px !important;
        height: 12px !important;
        border: 2px solid #3a3a5c !important;
        border-top-color: #7c5cfc !important;
        border-radius: 50% !important;
        animation: answerly-nq-spin .65s linear infinite !important;
        flex-shrink: 0 !important;
      }
      @keyframes answerly-nq-spin { to { transform: rotate(360deg); } }
      .answerly-nq-error { color: #f05454 !important; font-size: 12px !important; }

      .answerly-nq-cam-tooltip {
        position: fixed !important;
        background: rgba(15,15,18,0.92) !important;
        color: #f0f0f5 !important;
        font-size: 10px !important;
        font-weight: 600 !important;
        padding: 3px 8px !important;
        border-radius: 5px !important;
        pointer-events: none !important;
        z-index: 2147483647 !important;
        border: 1px solid #2e2e3e !important;
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important;
        white-space: nowrap !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
        user-select: none !important;
      }
      #answerly-nq-stealth-overlay {
        position: fixed; top:0; left:0; width:100vw; height:100vh;
        z-index: 2147483646; cursor: none; user-select:none; -webkit-user-select:none;
      }
      #answerly-nq-stealth-overlay canvas { position:absolute; top:0; left:0; display:block; }
      #answerly-nq-stealth-hint {
        position:absolute; bottom:24px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,.75); color:#fff; padding:8px 18px;
        border-radius:20px; font-size:13px; font-family:sans-serif;
        pointer-events:none; white-space:nowrap;
        border:1px solid rgba(124,92,252,.4);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Find questions ─────────────────────────────────────────────────────────
  function findNQQuestions() {
    if (!isNQPage()) return [];
    return Array.from(document.querySelectorAll('[data-automation="sdk-item-wrapper"]'));
  }

  // Does THIS document contain New Quizzes? Checked live, never cached: with
  // native integration the page is a React app, so the markup appears after this
  // script has already loaded, and a one-shot check at startup would always miss.
  // This is also the ownership handshake with quizSolver.js, which stands down
  // whenever this returns true — exactly one engine ever touches a given page.
  function isNQPage() {
    return !!document.querySelector('[data-automation="sdk-item-wrapper"]');
  }

  // ── Quiz-level context ─────────────────────────────────────────────────────
  // The New Quizzes counterpart of quizSolver.js's extractQuizContext(). Without
  // it, a New Quizzes "identify the adverb" / "based on the passage" quiz sends
  // every question stripped of the instruction that says what is being asked.
  //
  // Deliberately keys off ONE fact we already rely on everywhere else: questions
  // live inside [data-automation="sdk-item-wrapper"]. So a Canvas content block
  // that is NOT inside a wrapper is, by construction, not a question — it is the
  // quiz description or a shared stimulus. No guessed class names, and if the
  // page has no such block nothing is attached and the request is byte-for-byte
  // what it was before. Failing to find context must never mean sending junk.
  const NQ_ADMIN = /time limit|attempts? allowed|this quiz was locked|once you (submit|start|begin)|you have \d+\s*(minute|hour|second)|no calculator|academic (integrity|honesty|dishonesty)|honor (code|pledge)|do not (refresh|close|navigate)|points? (possible|each)|due (date|at)|multiple attempts|save (your )?answers?\s+(often|frequently|periodically|regularly|as you go|before|after)|proctor/i;
  const NQ_CLAUSE = /((?:(?<=[.;!?])\s+)|(?:\s+[—–]\s+)|(?:\s+-\s+))/;
  function nqStripAdmin(line) {
    const pieces = line.split(NQ_CLAUSE);   // [seg, sep, seg, sep, ...]
    let out = '';
    let prevKept = -2;
    for (let i = 0; i < pieces.length; i += 2) {
      const seg = pieces[i];
      if (!seg || NQ_ADMIN.test(seg)) continue;   // drop segment + its separator
      // Reuse the original separator only when it genuinely joined this segment
      // to the last one we kept — otherwise it belonged to dropped text.
      const sep = out ? (prevKept === i - 2 ? (pieces[i - 1] || ' ') : ' ') : '';
      out += sep + seg;
      prevKept = i;
    }
    return out.trim();
  }

  // Only a SUCCESSFUL read is cached. New Quizzes is React: the description can
  // mount after the first question, so caching an empty result would lock in the
  // miss for the whole attempt.
  let nqContextCache = '';
  function getNQQuizContext() {
    if (nqContextCache) return nqContextCache;
    try { nqContextCache = extractNQQuizContext(); } catch { nqContextCache = ''; }
    return nqContextCache;
  }

  function extractNQQuizContext() {
    if (!isNQPage()) return '';
    const blocks = [];
    document.querySelectorAll('.user_content').forEach(el => {
      if (el.closest('[data-automation="sdk-item-wrapper"]')) return;  // it's a question
      if (el.closest('.answerly-nq-hint-area')) return;                // our own UI
      // Skip a block whose text is already covered by an ancestor we took.
      if (blocks.some(b => b.contains(el))) return;
      const t = (el.innerText || '').trim();
      if (t.length > 25) blocks.push(el);
    });

    let ctx = blocks.map(el => (el.innerText || '').trim()).join('\n\n')
      .split('\n')
      .map(line => nqStripAdmin(line.trim()))
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (ctx.length < 25) return '';
    if (ctx.length > 6000) ctx = ctx.slice(0, 6000).trim() + '…';
    return ctx;
  }

  // ── Extract question data ──────────────────────────────────────────────────
  function extractNQData(qEl) {
    // ── Question stem text ──────────────────────────────────────────────────
    // The stem is inside div[tabindex="-1"]. We take its first .user_content.enhanced
    // to avoid capturing text from the answer labels (which also use that class).
    const stemContainer = qEl.querySelector('div[tabindex="-1"]');
    const stemContent   = stemContainer
      ? stemContainer.querySelector('.user_content.enhanced')
      : qEl.querySelector('.user_content.enhanced');
    const questionText = nqStemWithoutSelectOptions(stemContent) || nqStemText(stemContent);

    // ── Question type ───────────────────────────────────────────────────────
    const typeEl       = qEl.querySelector('[data-automation="sdk-interaction-type-name-div"]');
    const questionType = typeEl ? typeEl.innerText.trim() : '';

    // ── Answer inputs ───────────────────────────────────────────────────────
    const radios     = Array.from(qEl.querySelectorAll('input[type="radio"]'));
    const checkboxes = Array.from(qEl.querySelectorAll('input[type="checkbox"]'));
    const inputs     = radios.length > 0 ? radios : checkboxes;

    const seen            = new Set();
    const options         = [];
    const inputOptionPairs = [];

    inputs.forEach(input => {
      const labelText = getNQLabelText(input, qEl);
      if (labelText && !seen.has(labelText)) {
        seen.add(labelText);
        options.push(labelText);
        inputOptionPairs.push({ input, labelText });
      }
    });

    // ── Text / fill-in-blank inputs ─────────────────────────────────────────
    const textInputEls = Array.from(
      qEl.querySelectorAll('input[type="text"], input[type="number"], textarea')
    ).filter(el => !el.disabled && (el.offsetWidth || el.offsetHeight));

    // ── Dropdowns (matching / inline select) ────────────────────────────────
    // Fail closed: on any error, behave exactly as the engine did before
    // dropdown support existed rather than losing the whole question.
    let dropdownRows = [];
    try { dropdownRows = nqDropdownRows(qEl); } catch { dropdownRows = []; }

    return { questionText, questionType, options, inputOptionPairs, textInputEls, dropdownRows };
  }

  // Screen-reader status text ("Not Selected" / "Selected") that Canvas hides
  // visually but innerText still reads. Same rules as quizSolver.js: strip only
  // a leading token, or a trailing one that follows punctuation or a newline.
  const NQ_A11Y_LEAD_RE  = /^(?:not\s+selected|selected)[\s,;:\-–—]+/i;
  const NQ_A11Y_TRAIL_RE = /(^|\n|[.,;:)\]!?])[\s,;:\-–—]*(?:not\s+selected|selected)\s*$/i;
  function nqStripA11yStatus(text) {
    let t = String(text || '').trim();
    if (!t) return t;
    t = t.replace(NQ_A11Y_LEAD_RE, '').trim();
    t = t.replace(NQ_A11Y_TRAIL_RE, '$1').replace(/[\s,;:\-–—]+$/, '').trim();
    if (/^(?:not\s+selected|selected)$/i.test(t)) return '';
    return t;
  }

  // ── Get label text for a radio/checkbox input ──────────────────────────────
  // New Quizzes wraps inputs inside <label> elements or uses label[for="id"].
  // Reads through nqStemText so an option rendered as an equation image yields
  // its LaTeX rather than an empty string — options are just as likely to be
  // maths pictures as the question stem is.
  function getNQLabelText(input, scope) {
    return nqStripA11yStatus(rawNQLabelText(input, scope));
  }
  function rawNQLabelText(input, scope) {
    // 1. Input is a descendant of <label>
    const wrappedLabel = input.closest('label');
    if (wrappedLabel) return nqStemText(wrappedLabel);
    // 2. Explicit label[for="inputId"]
    if (input.id) {
      const explicit = (scope || document).querySelector(`label[for="${CSS.escape(input.id)}"]`)
                    || document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (explicit) return nqStemText(explicit);
    }
    // 3. Next sibling element
    const sib = input.nextElementSibling;
    if (sib && sib.tagName !== 'INPUT') return nqStemText(sib);
    // 4. Parent container text (minus the input's value)
    const parent = input.parentElement;
    if (parent) return nqStemText(parent).replace(input.value || '', '').trim();
    return '';
  }

  // ── Normalize text for fuzzy matching ─────────────────────────────────────
  function normalizeText(s) {
    return s.trim().toLowerCase()
      .replace(/^[a-z]\.\s+/i, '')   // strip "a. "
      .replace(/^[a-z]\)\s+/i, '')   // strip "a) "
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Click a radio/checkbox input (React-compatible) ───────────────────────
  // New Quizzes uses React. We fire a real click event so React's delegated
  // event system picks it up at the root, and also dispatch change/input for
  // older React versions that listen to those.
  function clickNQInput(input) {
    input.click();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  // ── Auto-select the answer in a NQ question ────────────────────────────────
  // Finds the ONE option best matching a single answer string. Mirrors the
  // Classic engine's matchOptionIndex: exact → length-guarded includes (both
  // directions) → bare letter indicator. Returns -1 when nothing is a confident
  // match, so a vague part never sweeps in the wrong box.
  function matchNQOptionIndex(inputOptionPairs, ansStr) {
    const a = String(ansStr || '').trim();
    if (!a) return -1;
    const aNorm  = normalizeText(a);
    const labels = inputOptionPairs.map(p => normalizeText(p.labelText));
    for (let i = 0; i < labels.length; i++) if (labels[i] && labels[i] === aNorm) return i;
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i]; if (!L) continue;
      if ((aNorm.length >= 2 && L.includes(aNorm)) || (L.length >= 2 && aNorm.includes(L))) return i;
    }
    const ref = a.toLowerCase()
      .replace(/^(the\s+)?(correct\s+)?(answer|choice|option)\s*(is|:)?\s*/i, '')
      .replace(/[.)\]:]+$/, '').trim();
    const lm = ref.match(/^\(?([a-e])\)?$/i);
    if (lm) { const i = lm[1].toLowerCase().charCodeAt(0) - 97; if (inputOptionPairs[i]) return i; }
    return -1;
  }

  // `parts` is the backend's answerParts — the exact option strings it chose.
  // Preferring it is what stops an option that legitimately CONTAINS a comma
  // ("Short, terse") being split into fragments that match nothing.
  function autoSelectNQAnswer(qEl, answer, inputOptionPairs, parts) {
    if (!inputOptionPairs || inputOptionPairs.length === 0) return false;

    const answerNorm  = normalizeText(answer);
    const answerLower = answer.trim().toLowerCase();
    const usableParts = Array.isArray(parts) && parts.length > 0 &&
                        parts.every(p => typeof p === 'string' && p.trim());
    const targets     = answer.split(',').map(a => normalizeText(a)).filter(Boolean);
    const rawTargets  = answer.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);

    // ── Multi-select (checkboxes) ─────────────────────────────────────────
    const isCheckbox = inputOptionPairs[0]?.input.type === 'checkbox';
    if (isCheckbox) {
      // Match EACH chosen string to ONE box. Splitting only on separators that
      // cannot appear inside an option (newline / semicolon, and a comma not
      // inside brackets) keeps comma-bearing options whole when answerParts is
      // missing; with answerParts there is no splitting at all.
      const partList = (usableParts
        ? parts.map(p => String(p).trim())
        : answer.split(/[\n;]+|,(?![^)]*\))/).map(s => s.trim())).filter(Boolean);

      const chosen = new Set();
      for (const part of partList) {
        const i = matchNQOptionIndex(inputOptionPairs, part);
        if (i >= 0) chosen.add(i);
      }
      if (chosen.size > 0) {
        // Deliberately NOT capped below the option count: a select-all whose
        // options are all true must be able to tick every box. The old guard
        // (toCheck.length < inputOptionPairs.length) made that case select
        // nothing at all.
        let any = false;
        inputOptionPairs.forEach((p, i) => {
          if (chosen.has(i) && !p.input.checked) { clickNQInput(p.input); any = true; }
        });
        if (any || [...chosen].every(i => inputOptionPairs[i] && inputOptionPairs[i].input.checked)) return true;
      }
      return false;
    }

    // ── Single select (radios) ────────────────────────────────────────────
    const target    = targets[0]    || answerNorm;
    const targetRaw = rawTargets[0] || answerLower;

    // Pass 1: exact normalized match
    for (const { input, labelText } of inputOptionPairs) {
      if (normalizeText(labelText) === target) { clickNQInput(input); return true; }
    }
    // Pass 2: normalized includes
    for (const { input, labelText } of inputOptionPairs) {
      const lNorm = normalizeText(labelText);
      if (lNorm.includes(target) || target.includes(lNorm)) { clickNQInput(input); return true; }
    }
    // Pass 3: raw case-insensitive includes
    for (const { input, labelText } of inputOptionPairs) {
      const lLow = labelText.toLowerCase();
      if (lLow.includes(targetRaw) || targetRaw.includes(lLow)) { clickNQInput(input); return true; }
    }
    // Pass 4: first 25 chars of normalized
    for (const { input, labelText } of inputOptionPairs) {
      const lNorm = normalizeText(labelText);
      if (lNorm.startsWith(target.slice(0, 25)) || target.startsWith(lNorm.slice(0, 25))) {
        clickNQInput(input); return true;
      }
    }
    // Pass 5: letter fallback — AI returned "B", "c", etc.
    if (/^[a-e]$/.test(target)) {
      const idx = target.charCodeAt(0) - 97; // 'a'→0
      if (inputOptionPairs[idx]) { clickNQInput(inputOptionPairs[idx].input); return true; }
    }

    return false;
  }

  // ── Auto-fill a text/number input (React-compatible) ──────────────────────
  // Uses the native value setter so React's controlled component state updates.
  // Writes one value into one box. New Quizzes is React, so the value must go in
  // through the native property setter or React's synthetic guard swallows it.
  function setNQInputValue(el, val) {
    if (!el) return;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, String(val ?? ''));
    else el.value = String(val ?? '');
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  // Splits one answer string into exactly n pieces, stripping any letter/number
  // prefix the model echoed and any trailing "(working)". Returns null when the
  // count doesn't match, so the caller can fall back safely instead of guessing.
  // Mirrors splitForBlanks() in quizSolver.js — keep the two in step.
  function nqSplitForBlanks(answer, n) {
    const raw = String(answer || '');
    const tryParts = (parts) => {
      const cleaned = parts
        .map(x => x.replace(/^\s*(?:[a-zA-Z]|\d{1,2})[.)]\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim())
        .filter(Boolean);
      return cleaned.length === n ? cleaned : null;
    };
    return tryParts(raw.split(/\s*(?:[;\n]|(?=\b[a-z][.)]\s))\s*/).filter(Boolean))
        || tryParts(raw.split(/\s*[;\n]+\s*/))
        || tryParts(raw.split(/\s*,\s*/))
        || null;
  }

  // Fills text inputs. One box gets the whole answer. Several boxes get one value
  // each, in order — from `parts` when the backend supplied them, else split
  // heuristically. If nothing maps cleanly, fall back to filling only the first
  // box rather than scattering wrong values across all of them.
  function autoFillNQText(inputEls, answer, parts) {
    const els = Array.from(inputEls || []).filter(el => el && !el.disabled);
    if (!els.length) return false;

    if (els.length === 1) { setNQInputValue(els[0], answer); return true; }

    const values = (Array.isArray(parts) && parts.length === els.length) ? parts
                 : nqSplitForBlanks(answer, els.length);
    if (!values) { setNQInputValue(els[0], answer); return true; }

    els.forEach((el, i) => setNQInputValue(el, values[i]));
    return true;
  }

  // ── Dropdown / matching support ───────────────────────────────────────────
  // New Quizzes renders Matching and inline-dropdown questions with native
  // <select> elements. This is written to fail closed: if a question has no
  // usable <select>, nqDropdownRows() returns [] and every caller falls through
  // to the existing radio/checkbox/text paths untouched.
  function autoSelectNQDropdown(selectEl, answer) {
    const target = String(answer || '').trim().toLowerCase();
    if (!selectEl || !target) return false;

    const doSelect = (i) => {
      // React tracks <select> value the same way it tracks inputs.
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(selectEl, selectEl.options[i].value);
      else selectEl.selectedIndex = i;
      ['input', 'change'].forEach(t => selectEl.dispatchEvent(new Event(t, { bubbles: true })));
    };
    const usable = (i) => {
      const t = selectEl.options[i].text.trim().toLowerCase();
      return t && !t.startsWith('[') && !t.startsWith('(') ? t : null;
    };

    // Pass 1: exact match — most reliable, avoids "5" matching "15"
    for (let i = 0; i < selectEl.options.length; i++) {
      const t = usable(i); if (t && t === target) { doSelect(i); return true; }
    }
    // Pass 2: option contains the answer ("paris" → "Paris, France")
    for (let i = 0; i < selectEl.options.length; i++) {
      const t = usable(i); if (t && t.includes(target)) { doSelect(i); return true; }
    }
    // Pass 3: answer contains the option — only for substantial strings, so short
    // numbers can't match inside longer ones.
    for (let i = 0; i < selectEl.options.length; i++) {
      const t = usable(i); if (t && t.length >= 6 && target.includes(t)) { doSelect(i); return true; }
    }
    return false;
  }

  // Collects every visible <select> in a question along with its row label.
  function nqDropdownRows(qEl) {
    const rows = [];
    qEl.querySelectorAll('select').forEach(sel => {
      if (sel.disabled) return;
      if (!sel.offsetWidth && !sel.offsetHeight) return;   // hidden internal select

      const options = [];
      sel.querySelectorAll('option').forEach(opt => {
        const t = opt.textContent.trim();
        if (t && !t.startsWith('[') && !t.startsWith('(')) options.push(t);
      });
      if (!options.length) return;

      // Row label — the prompt this dropdown answers. Try the accessible name
      // first (New Quizzes labels its selects for screen readers), then the
      // table row or nearest container, minus the select's own text.
      let label = '';
      const clean = (s) => String(s || '')
        .replace(/\[\s*(?:Select|Choose|Answer)\s*\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      // innerText respects layout, so it drops visually-hidden screen-reader
      // text that would otherwise pollute the label. textContent is the fallback
      // for any element where innerText isn't populated.
      const elText = (el) => !el ? '' : (el.innerText != null ? el.innerText : el.textContent);

      // Never let a label heuristic throw — this runs inside extractNQData, and
      // an exception here would abort button injection for the whole page. A
      // missing label only costs some prompt quality; a throw costs everything.
      try {
        const labelledBy = sel.getAttribute('aria-labelledby');
        if (labelledBy) {
          label = clean(labelledBy.split(/\s+/)
            .map(id => elText(document.getElementById(id)))
            .join(' '));
        }
        if (!label) label = clean(sel.getAttribute('aria-label'));
        if (!label && sel.id && typeof CSS !== 'undefined' && CSS.escape) {
          label = clean(elText(document.querySelector(`label[for="${CSS.escape(sel.id)}"]`)));
        }
        if (!label) {
          const tr = sel.closest('tr');
          if (tr) {
            const cell = Array.from(tr.children).find(td => !td.contains(sel));
            label = clean(elText(cell));
          }
        }
        if (!label) {
          // A dropdown inside a sentence: its label is the words just before it,
          // stopping at the previous dropdown (then the words after it), as
          // quizSolver.js does. The ancestor fallback below took the WHOLE
          // sentence, every other dropdown's option list included — "The capital
          // of France is Berlin Paris Madrid and the capital of Japan is Seoul
          // Beijing Tokyo" — which went to the model as prose and was printed on
          // the student's answer card. If the select is wrapped on its own, look
          // beside the wrapper instead.
          const hasSelect = (n) => n.nodeType === 1 && (n.tagName === 'SELECT' || !!n.querySelector('select'));
          const beside = (start, back) => {
            let text = '';
            for (let n = start; n && !hasSelect(n); n = back ? n.previousSibling : n.nextSibling) {
              const t = n.nodeType === 3 ? n.textContent : n.nodeType === 1 ? elText(n) : '';
              text = back ? t + text : text + t;
              if (text.trim().length > 100) break;
            }
            return clean(back ? text.slice(-80) : text.slice(0, 80));
          };
          let anchor = sel;
          for (let hops = 0; hops < 3 && !label; hops++) {
            label = beside(anchor.previousSibling, true) || beside(anchor.nextSibling, false);
            const up = anchor.parentElement;
            if (!up || up.querySelectorAll('select').length !== 1) break;
            anchor = up;
          }
        }
        if (!label) {
          // Nearest ancestor that holds more than just this select.
          let node = sel.parentElement;
          for (let hops = 0; node && hops < 4; hops++, node = node.parentElement) {
            const text = clean(elText(node));
            if (text && text.length > 1) { label = text; break; }
          }
        }
      } catch { label = ''; }

      rows.push({ label, selectEl: sel, options });
    });
    return rows;
  }

  // A Matching question is 2+ dropdowns that all draw from one shared pool of
  // options. Those must be solved in ONE call so the model can distribute the
  // answers without repeating itself. Anything else is solved per-dropdown.
  function isNQMatching(rows) {
    if (rows.length < 2) return false;
    const first = JSON.stringify([...rows[0].options].sort());
    return rows.every(r => JSON.stringify([...r.options].sort()) === first);
  }

  // Solves every dropdown in a question.
  // Calls done(filledCount, results) where results is [{ label, answer }].
  function solveNQDropdowns(questionText, rows, done) {
    const baseQ = questionText.length > 800
      ? questionText.slice(0, 800).trim() + '...'
      : questionText.trim();
    let filled = 0;
    const results = [];

    if (isNQMatching(rows)) {
      sendSolve(
        { type: 'SOLVE_MATCHING', question: baseQ,
          rows: rows.map(r => ({ label: r.label, options: r.options })) },
        (resp) => {
          if (!chrome.runtime.lastError && resp && resp.answers) {
            // Backend returns numbered keys: {"1": "answer", "2": "answer", ...}
            rows.forEach((r, i) => {
              const a = resp.answers[String(i + 1)];
              if (a && autoSelectNQDropdown(r.selectEl, a)) filled++;
              results.push({ label: r.label, answer: a || '—' });
            });
            reportOutcome(resp, filled === rows.length,
              filled === rows.length ? undefined : `matching: ${filled}/${rows.length} dropdowns set`);
          }
          done(filled, results);
        }
      );
      return;
    }

    // Independent dropdowns — one call each, staggered so we never burst.
    let i = 0;
    const next = () => {
      if (i >= rows.length) return done(filled, results);
      const row = rows[i++];
      const q = row.label ? `${baseQ}\n\nFor: "${row.label}"` : baseQ;
      sendSolve(
        { type: 'SOLVE_QUESTION', question: q, options: row.options },
        (resp) => {
          const ok = !chrome.runtime.lastError && resp && !resp.error;
          const set = ok && autoSelectNQDropdown(row.selectEl, resp.answer);
          if (set) filled++;
          if (ok) reportOutcome(resp, set, set ? undefined : 'dropdown: no option matched');
          results.push({ label: row.label, answer: ok ? resp.answer : '—' });
          setTimeout(next, 400);
        }
      );
    };
    next();
  }

  // ── "Use the screenshot tool" toast ───────────────────────────────────────
  // Stealth mode shows no cards, so a question we can't auto-solve used to fail
  // completely silently — the student clicked and nothing happened. This says
  // why, in the same dim styling Classic uses (showScreenshotToast in
  // quizSolver.js — keep the two looks in step).
  //
  // Two looks, one component:
  //   normal  — full brightness, reads like any other notification
  //   stealth — dimmed and muted: no accent border, no drop shadow, lower
  //             contrast. Legible to the person using it, but it does not
  //             catch the eye of someone glancing at the screen.
  // Auto-dismisses after 5s in both; the X closes it immediately.
  function showNQScreenshotToast(opts = {}) {
    const dim = opts.dim !== undefined ? opts.dim : stealthHidden;
    document.getElementById('answerly-nq-shot-toast')?.remove();

    const accent = theme.accentColor || DEFAULT_THEME.accentColor;
    const box = document.createElement('div');
    box.id = 'answerly-nq-shot-toast';
    box.className = INJECTED;
    const css = {
      position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
      display: 'flex', alignItems: 'flex-start', gap: '10px',
      maxWidth: dim ? '290px' : '330px',
      padding: dim ? '10px 12px' : '13px 14px',
      // A coloured edge and a drop shadow are what make a panel catch
      // peripheral vision, so the dim variant drops both entirely.
      background: dim ? 'rgba(28,32,42,.82)' : '#1f2430',
      color: dim ? '#9aa3b2' : '#f2f4f8',
      border: dim ? '1px solid rgba(255,255,255,.10)' : '1px solid ' + accent,
      borderLeft: dim ? '1px solid rgba(255,255,255,.10)' : '4px solid ' + accent,
      borderRadius: '8px',
      boxShadow: dim ? 'none' : '0 6px 22px rgba(0,0,0,.35)',
      opacity: dim ? '.72' : '1',
      font: (dim ? '12px' : '13px') + '/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    };
    for (const k in css) box.style.setProperty(
      k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), css[k], 'important');

    const msg = document.createElement('div');
    msg.style.setProperty('flex', '1', 'important');
    // opts.label is the real question type read off the New Quizzes header
    // ("Categorization", "Ordering", "Hot Spot"), so the toast never mislabels
    // a drag-and-drop question as an essay.
    // opts.count is the Solve All case: N questions were skipped, so name the
    // number rather than a single question type.
    const what = opts.count
      ? (opts.count === 1 ? '1 question' : opts.count + ' questions')
      : (opts.label ? esc(opts.label) : 'This question');
    const them = (opts.count && opts.count > 1) ? 'them' : 'it';
    msg.innerHTML =
      '<div style="font-weight:' + (dim ? '600' : '700') + ';margin-bottom:3px">' +
      '📸 Screenshot needed</div>' +
      what + ' can’t be auto-answered — use the screenshot tool on ' + them + '.';

    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss');
    const restOpacity = dim ? '.5' : '.65';
    const xcss = {
      flex: 'none', width: '22px', height: '22px', padding: '0',
      marginTop: '-2px', cursor: 'pointer', background: 'transparent',
      border: 'none', color: dim ? '#9aa3b2' : '#f2f4f8',
      fontSize: '19px', lineHeight: '20px',
      opacity: restOpacity, borderRadius: '4px',
    };
    for (const k in xcss) x.style.setProperty(
      k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), xcss[k], 'important');
    x.addEventListener('mouseenter', () => x.style.setProperty('opacity', '1', 'important'));
    x.addEventListener('mouseleave', () => x.style.setProperty('opacity', restOpacity, 'important'));

    // Close immediately on X, and cancel the pending auto-dismiss so a later
    // timer can't remove a toast the user has already replaced.
    let timer = null;
    const close = () => { clearTimeout(timer); box.remove(); };
    x.addEventListener('click', close);

    box.appendChild(msg);
    box.appendChild(x);
    document.body.appendChild(box);
    timer = setTimeout(close, 5000);
  }

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Crop helper ─────────────────────────────────────────────────────────────
  // viewportWidth/viewportHeight are the PARENT frame's dimensions (passed back
  // with the postMessage region), NOT the iframe's dimensions.
  function cropNQStealthImage(dataUrl, x, y, w, h, viewportWidth, viewportHeight) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const vw     = viewportWidth  || img.naturalWidth;
        const vh     = viewportHeight || img.naturalHeight;
        const scaleX = img.naturalWidth  / vw;
        const scaleY = img.naturalHeight / vh;
        const out    = document.createElement('canvas');
        out.width    = Math.round(w * scaleX);
        out.height   = Math.round(h * scaleY);
        out.getContext('2d').drawImage(
          img, x * scaleX, y * scaleY, out.width, out.height,
          0, 0, out.width, out.height
        );
        resolve(out.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  // ── Stealth selection overlay (New Quizzes rendered in the main page) ───────
  function showNQStealthOverlay(fullDataUrl, onSelect, onCancel) {
    document.getElementById('answerly-nq-stealth-overlay')?.remove();
    injectStyles();

    const overlay = document.createElement('div');
    overlay.id = 'answerly-nq-stealth-overlay';

    // Device-resolution backing store so the capture (taken at devicePixelRatio)
    // renders 1:1; the context is scaled so all coordinates stay in CSS pixels.
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    overlay.appendChild(canvas);

    const hint = document.createElement('div');
    hint.id = 'answerly-nq-stealth-hint';
    hint.textContent = 'Drag to select area  •  Esc to cancel';
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const img = new Image();
    let startX = 0, startY = 0, curX = 0, curY = 0;
    let mouseX = 0, mouseY = 0, selecting = false, drawn = false;

    function drawCrosshair(x, y) {
      const size = 12, gap = 4;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
      ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x - gap, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + gap,  y); ctx.lineTo(x + size, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x, y - gap); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + gap);  ctx.lineTo(x, y + size); ctx.stroke();
      ctx.fillStyle = '#ff3b3b'; ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, W, H);
      // No dark overlay — keep the page at full brightness while selecting; the
      // selection is shown by the outline/handles below, not by dimming.
      if (drawn || selecting) {
        const x = Math.min(startX, curX), y = Math.min(startY, curY);
        const w = Math.abs(curX - startX),  h = Math.abs(curY - startY);
        if (w > 2 && h > 2) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.clearRect(x, y, w, h);
          if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, W, H);
          ctx.restore();
          ctx.strokeStyle = '#7c5cfc'; ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
          const hs = 7; ctx.fillStyle = '#7c5cfc';
          [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy]) => ctx.fillRect(hx-hs/2,hy-hs/2,hs,hs));
        }
      }
      drawCrosshair(mouseX, mouseY);
    }

    img.onload = () => draw();
    img.src = fullDataUrl;

    overlay.addEventListener('mousemove', (e) => {
      mouseX = e.clientX; mouseY = e.clientY;
      if (selecting) { curX = e.clientX; curY = e.clientY; drawn = true; }
      draw();
    });
    overlay.addEventListener('mousedown', (e) => {
      startX = e.clientX; startY = e.clientY; curX = e.clientX; curY = e.clientY;
      selecting = true; drawn = false; e.preventDefault();
    });
    overlay.addEventListener('mouseup', (e) => {
      if (!selecting) return;
      selecting = false;
      curX = e.clientX; curY = e.clientY;
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX),  h = Math.abs(curY - startY);
      overlay.remove(); removeEsc();
      if (w < 10 || h < 10) { onCancel(); return; }
      onSelect({ x, y, w, h });
    });

    function escHandler(e) { if (e.key === 'Escape') { overlay.remove(); removeEsc(); onCancel(); } }
    function removeEsc() { document.removeEventListener('keydown', escHandler); }
    document.addEventListener('keydown', escHandler);
  }

  // ── Camera capture flow ────────────────────────────────────────────────────
  // New Quizzes now renders in the main Canvas page, so the overlay is drawn
  // right here. The parent-frame relay below exists only for a quiz still
  // hosted in the quiz-lti iframe, where position:fixed is clipped to the
  // iframe; quizSolver.js accepts that relay from the quiz-lti origin only,
  // which is why the relay alone did nothing at all on a native New Quiz.
  function doCameraCapture(camBtn, qEl, questionText) {
    // A dropped callback must never leave this button locked for good.
    const watchdog = setTimeout(() => { camBtn.dataset.busy = ''; }, 90000);
    const done = () => { clearTimeout(watchdog); camBtn.dataset.busy = ''; };

    sendSolve({ type: 'CAPTURE_SCREENSHOT' }, (captResp) => {
      if (chrome.runtime.lastError || !captResp || captResp.error) { done(); return; }

      const onRegion = ({ x, y, w, h, viewportWidth, viewportHeight }) => {
        cropNQStealthImage(captResp.dataUrl, x, y, w, h, viewportWidth, viewportHeight)
          .then(solveCropped, done);
      };

      if (window.top === window.self) {
        showNQStealthOverlay(
          captResp.dataUrl,
          (r) => onRegion({ ...r, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }),
          done
        );
        return;
      }

      window.parent.postMessage({
        type:   'ANSWERLY_NQ_SHOW_OVERLAY',
        dataUrl: captResp.dataUrl,
      }, '*');
      function onParentMsg(e) {
        if (!e.data) return;
        if (e.data.type === 'ANSWERLY_NQ_REGION_SELECTED') {
          window.removeEventListener('message', onParentMsg);
          onRegion(e.data);
        } else if (e.data.type === 'ANSWERLY_NQ_REGION_CANCELLED') {
          window.removeEventListener('message', onParentMsg);
          done();
        }
      }
      window.addEventListener('message', onParentMsg);
    });

    function solveCropped(cropped) {
      sendSolve(
        { type: 'SOLVE_SCREENSHOT_STEALTH', image: cropped, questionText: questionText.slice(0, 200) },
        (r) => {
          done();
          if (chrome.runtime.lastError || !r || r.error) return;

          const answerLetter = (r.answer || '').toLowerCase().trim();
          let   answerText   = (r.answerText || '').trim();

          if (/^\s*\{.*"answer"\s*:/.test(answerText)) answerText = '';
          if (answerText && questionText) {
            const atN = answerText.toLowerCase().replace(/\s+/g,' ').trim();
            const qtN = questionText.toLowerCase().replace(/\s+/g,' ').trim();
            if (qtN.length > 20 && atN.slice(0,60) === qtN.slice(0,60)) answerText = '';
          }
          // Essay fallback, mirroring quizSolver.js. A screenshot of an essay
          // question comes back with nothing selectable; if the question has a
          // rich-text editor, solve it as text and write the answer into that
          // editor rather than dropping the solve on the floor.
          if (!answerText && !answerLetter) {
            const richIframes = Array.from(qEl.querySelectorAll('iframe')).filter(fr => {
              try { const d = fr.contentDocument || fr.contentWindow?.document; return !!(d?.body); }
              catch { return false; }
            });
            if (richIframes.length) {
              sendSolve(
                { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false },
                (r2) => {
                  if (!chrome.runtime.lastError && r2 && !r2.error && r2.answer) {
                    try {
                      const doc = richIframes[0].contentDocument || richIframes[0].contentWindow?.document;
                      if (doc?.body) {
                        doc.body.focus();
                        doc.body.innerText = r2.answer;
                        ['input', 'change'].forEach(t =>
                          doc.body.dispatchEvent(new Event(t, { bubbles: true })));
                        camBtn.dataset.opened = 'true';
                      }
                    } catch { /* cross-origin iframe */ }
                  }
                }
              );
            }
            return;
          }

          const { inputOptionPairs, textInputEls, dropdownRows } = extractNQData(qEl);
          const textParts = answerText
            ? answerText.split('|').map(p => p.trim()).filter(Boolean)
            : [];

          let matched = false;
          // Dropdowns and matching. The stealth prompt returns one answer per
          // dropdown, top to bottom, joined by " | ". This path never handled
          // <select> at all, so every dropdown and matching question came back
          // correctly answered and was then left blank (0/6 in testing, while
          // quizSolver.js fills the same questions). Mirrors that engine: one part
          // per dropdown when the counts agree, otherwise each part is tried
          // against the dropdowns still empty.
          if (dropdownRows.length > 0 && textParts.length > 0) {
            let set = 0;
            if (textParts.length === dropdownRows.length) {
              dropdownRows.forEach((r, i) => { if (autoSelectNQDropdown(r.selectEl, textParts[i])) set++; });
            } else {
              textParts.forEach(part => {
                const row = dropdownRows.find(r => r.selectEl.selectedIndex <= 0 &&
                  r.options.some(o => o.trim().toLowerCase() === part.toLowerCase()));
                if (row && autoSelectNQDropdown(row.selectEl, part)) set++;
              });
            }
            matched = set > 0;
          }
          if (!matched && textParts.length > 0) matched = autoSelectNQAnswer(qEl, textParts.join(', '), inputOptionPairs, textParts);
          if (!matched && answerLetter && /^[a-e](,\s*[a-e])*$/.test(answerLetter))
            matched = autoSelectNQAnswer(qEl, answerLetter, inputOptionPairs);
          // Every part, not just the first: with two or more blanks only box 1
          // was ever filled ("Au" typed, "Fe" dropped).
          if (!matched && textParts.length > 0 && textInputEls.length > 0)
            matched = autoFillNQText(textInputEls, textParts.join('; '), textParts);
          if (matched) {
            camBtn.dataset.opened = 'true';
            // Solve All skips a question only when its ? button is marked done;
            // without this it re-answered the question the camera just filled.
            const solveBtn = qEl.querySelector(`.answerly-nq-btn.${INJECTED}:not(.answerly-nq-cam-btn)`);
            if (solveBtn) solveBtn.dataset.opened = 'true';
          }
        }
      );
    }
  }

  // ── Question identity ──────────────────────────────────────────────────────
  // One-question-at-a-time quizzes (answer → Next → answer) can REUSE the same
  // sdk-item-wrapper node for the next question instead of replacing it. When
  // they do, our button survives but is bound to the previous question's text
  // and carries its stale dataset.opened, so Solve All skips the new question
  // and the camera sends the old stem. Both inject paths dedup on "does a button
  // already exist here?", which is blind to that swap. Stamp each button with a
  // signature of the question it was built for; when the wrapper's live content
  // no longer matches, the buttons are torn down and rebuilt for the new one.
  function nqStemSig(qEl) {
    const sc = qEl.querySelector('div[tabindex="-1"] .user_content.enhanced') ||
               qEl.querySelector('.user_content.enhanced');
    const stem = (sc ? (sc.innerText || sc.textContent || '') : '')
      .replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
    const pos = (qEl.querySelector('[data-automation="sdk-position-box-text"]')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    return pos + '|' + stem;
  }

  function nqClearInjected(qEl) {
    qEl.querySelectorAll(`.${INJECTED}, .answerly-nq-card`).forEach(el => el.remove());
  }

  // Returns true when this wrapper already carries buttons for the CURRENT
  // question (skip it); false when it has none or they belong to a previous
  // question — in the latter case the stale ones are removed first so the caller
  // re-injects fresh.
  function nqUpToDate(qEl, sig) {
    const existing = qEl.querySelector(`.answerly-nq-btn.${INJECTED}`);
    if (!existing) return false;
    if (existing.dataset.qsig === sig) return true;
    nqClearInjected(qEl);
    return false;
  }

  // ── Camera-only injection (screenshot stealth without quiz solver) ──────────
  function injectCameraOnlyButtons() {
    if (!screenshotStealthActive) return;
    injectStyles();
    const questions = findNQQuestions();
    questions.forEach(qEl => {
      const sig = nqStemSig(qEl);
      if (nqUpToDate(qEl, sig)) return;
      const stemContainer = qEl.querySelector('div[tabindex="-1"]');
      const stemContent   = stemContainer
        ? stemContainer.querySelector('.user_content.enhanced')
        : qEl.querySelector('.user_content.enhanced');
      const questionText = nqStemWithoutSelectOptions(stemContent) || nqStemText(stemContent);
      if (!questionText) return;

      const header = findNQHeader(qEl);
      const camBtn = document.createElement('button');
      camBtn.type      = 'button';
      camBtn.className = `answerly-nq-btn answerly-invisible answerly-nq-cam-btn answerly-nq-cam-only ${INJECTED}`;
      camBtn.title     = '';
      camBtn.dataset.qsig = sig;
      camBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
      header.appendChild(camBtn);

      camBtn.addEventListener('mouseenter', () => {
        document.getElementById('answerly-nq-stealth-tip')?.remove();
        const tip = document.createElement('div');
        tip.id = 'answerly-nq-stealth-tip';
        tip.className = 'answerly-nq-cam-tooltip';
        tip.textContent = '📸 Screenshot';
        document.body.appendChild(tip);
        const r = camBtn.getBoundingClientRect();
        tip.style.left = r.left + 'px';
        tip.style.top  = (r.top - 26) + 'px';
      });
      camBtn.addEventListener('mouseleave', () => {
        document.getElementById('answerly-nq-stealth-tip')?.remove();
      });
      camBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (camBtn.dataset.busy) return;
        camBtn.dataset.busy = 'true';
        doCameraCapture(camBtn, qEl, questionText);
      });
    });
  }

  // ── Find the header row for button injection ───────────────────────────────
  // The question header contains the position box ("Question 1") and type label.
  function findNQHeader(qEl) {
    const posBox  = qEl.querySelector('[data-automation="sdk-position-box-text"]');
    const typeBox = qEl.querySelector('[data-automation="sdk-interaction-type-name-div"]');
    // Prefer the common parent of posBox and typeBox if they share one level up
    if (posBox && typeBox && posBox.parentElement === typeBox.parentElement) {
      return posBox.parentElement;
    }
    return posBox?.parentElement || typeBox?.parentElement || qEl.firstElementChild || qEl;
  }

  // ── Inject buttons ─────────────────────────────────────────────────────────
  function injectButtons() {
    const questions = findNQQuestions();

    questions.forEach(qEl => {
      const sig = nqStemSig(qEl);
      if (nqUpToDate(qEl, sig)) return; // already built for THIS question

      const { questionText, questionType, options, inputOptionPairs, textInputEls, dropdownRows } = extractNQData(qEl);
      if (!questionText) return;

      const accent         = theme.accentColor || DEFAULT_THEME.accentColor;
      const hasChoices     = inputOptionPairs.length > 0;
      const hasDropdowns   = dropdownRows.length > 0;
      const isFillInBlank  = textInputEls.length > 0 && !hasChoices && !hasDropdowns;
      // Maths whose fractions and exponents did not survive extraction is not a
      // question we can answer, however ordinary its inputs look. Treated the
      // same way as an essay: routed to the screenshot tool, which reads the
      // rendered equation rather than a flattened string.
      const mathLossy      = nqMathIsLossy(qEl);
      // A picture question, or one that says "refer to the figure", cannot be
      // answered from its text either — same treatment as lossy maths.
      const needsShot      = nqNeedsScreenshotFor(qEl, questionText);
      const isFreeText     = (!hasChoices && !hasDropdowns && !isFillInBlank) || needsShot;
      const showCamBtn     = screenshotStealthActive;

      // Everything with no input we can drive lands in the isFreeText branch —
      // essays, but also the New Quizzes drag-and-drop types (Categorization,
      // Ordering, Hot Spot). Calling those "Essay question" was misleading, so
      // name the real type using the label New Quizzes already prints in the
      // question header. Falls back to neutral wording if that label is missing.
      // Kept to a bare noun phrase ("Categorization question") so it reads
      // correctly in both places it appears: the normal-mode card and the
      // stealth toast, which wrap it in different sentences.
      const unsupportedLabel = mathLossy
        ? 'Equation question'
        : (needsShot && (hasChoices || hasDropdowns || isFillInBlank)
            // It has inputs we could drive — the blocker is the picture, not the
            // question type, so say so rather than calling it an essay.
            ? 'Image-based question'
            : (/essay/i.test(questionType) || !questionType
                ? 'Essay question'
                : `${questionType} question`));

      const header = findNQHeader(qEl);

      // ── ? trigger button ──────────────────────────────────────────────────
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = `answerly-nq-btn ${INJECTED}`;
      btn.title     = 'Answerly AI — hint & answer';
      btn.dataset.qsig = sig;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      btn.style.setProperty('background',  accent, 'important');
      btn.style.setProperty('box-shadow', `0 2px 8px ${accent}88`, 'important');
      if (stealthHidden) btn.classList.add('answerly-invisible');
      header.appendChild(btn);

      if (stealthHidden) {
        // ── STEALTH / AUTO-SELECT MODE ───────────────────────────────────────
        // Hover tooltip — same dark label as the camera button
        btn.addEventListener('mouseenter', () => {
          document.getElementById('answerly-nq-stealth-tip')?.remove();
          const tip = document.createElement('div');
          tip.id          = 'answerly-nq-stealth-tip';
          tip.className   = 'answerly-nq-cam-tooltip';
          tip.textContent = '🤫 Auto-Select';
          document.body.appendChild(tip);
          const r = btn.getBoundingClientRect();
          tip.style.left = r.left + 'px';
          tip.style.top  = (r.top - 26) + 'px';
        });
        btn.addEventListener('mouseleave', () => {
          document.getElementById('answerly-nq-stealth-tip')?.remove();
        });

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (btn.dataset.done) return;
          btn.dataset.done = 'true';

          if (isFreeText) {
            // Nothing here can be auto-filled (essay, or a drag-and-drop type
            // like Categorization / Ordering / Hot Spot). Say so in the dim
            // toast instead of failing silently — a click that does nothing at
            // all reads as the extension being broken.
            showNQScreenshotToast({ label: unsupportedLabel });
            btn.dataset.done = '';   // allow another click
            return;
          }

          if (hasDropdowns) {
            solveNQDropdowns(questionText, dropdownRows, (filled) => {
              if (filled) btn.dataset.opened = 'true';
              else        btn.dataset.done   = '';   // allow retry
            });
            return;
          }

          if (isFillInBlank) {
            sendSolve(
              { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false,
                blankCount: textInputEls.length },
              (resp) => {
                if (!chrome.runtime.lastError && resp && !resp.error) {
                  const filled = autoFillNQText(textInputEls, resp.answer, resp.answerParts);
                  reportOutcome(resp, filled, filled ? undefined : 'fill-in-blank: no input filled');
                  btn.dataset.opened = 'true';
                } else {
                  btn.dataset.done = '';
                }
              }
            );
            return;
          }

          const isMultiSelect = inputOptionPairs[0]?.input.type === 'checkbox';
          sendSolve(
            { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect },
            (resp) => {
              if (!chrome.runtime.lastError && resp && !resp.error) {
                const matched = autoSelectNQAnswer(qEl, resp.answer, inputOptionPairs, resp.answerParts);
                reportOutcome(resp, matched, matched ? undefined : 'no option matched the answer');
                if (matched) btn.dataset.opened = 'true';
                else         btn.dataset.done   = ''; // allow retry
              } else {
                btn.dataset.done = '';
              }
            }
          );
        });

      } else {
        // ── NORMAL MODE: card with hint + answer ──────────────────────────────
        const card = document.createElement('div');
        card.className    = `answerly-nq-card ${INJECTED}`;
        card.style.display = 'none';
        card.style.setProperty('background',   theme.cardBg,          'important');
        card.style.setProperty('border-color', theme.cardBorder,       'important');
        card.style.setProperty('opacity',      theme.opacity / 100,    'important');
        card.innerHTML = `
          <div class="answerly-nq-badge" style="color:${accent}!important">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Answerly AI
          </div>
          <div class="answerly-nq-hint-area">
            ${isFreeText
              ? `<div class="answerly-nq-hint-row" style="color:#a090f0!important;">
                   📸 ${esc(unsupportedLabel)} — use the <strong style="color:#fff!important;">Screenshot Tool</strong> for AI assistance.
                 </div>`
              : `<div class="answerly-nq-loading"><div class="answerly-nq-spinner"></div>Thinking…</div>`
            }
          </div>`;

        // Insert card at the bottom of the question wrapper so it's always visible
        qEl.appendChild(card);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isOpen = card.style.display !== 'none';
          card.style.display = isOpen ? 'none' : 'block';

          if (!isOpen && !card.dataset.loaded && !isFreeText) {
            card.dataset.loaded = 'true';
            btn.dataset.opened  = 'true';

            if (hasDropdowns) {
              solveNQDropdowns(questionText, dropdownRows, (filled, results) => {
                if (!results.length) return renderNQError(card, 'Failed to solve — click to retry.');
                const parts = results.map(r => r.label ? `${r.label} → ${r.answer}` : r.answer);
                renderNQResult(card, '', parts.join('\n'), parts, []);
              });
            } else if (isFillInBlank) {
              sendSolve(
                { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false,
                  blankCount: textInputEls.length },
                (resp) => {
                  if (chrome.runtime.lastError || !resp) return renderNQError(card, 'Extension error — try reloading.');
                  if (resp.error) return renderNQError(card, resp.error, resp.limitReached);
                  renderNQResult(card, resp.hint, resp.answer, resp.answerParts, options);
                  reportOutcome(resp, autoFillNQText(textInputEls, resp.answer, resp.answerParts));
                }
              );
            } else {
              const isMultiSelect = inputOptionPairs[0]?.input.type === 'checkbox';
              fetchNQAnswer(card, questionText, options, isMultiSelect);
            }
          }
        });
      }

      // ── Camera button (screenshot stealth) ────────────────────────────────
      if (showCamBtn) {
        const camBtn = document.createElement('button');
        camBtn.type      = 'button';
        camBtn.className = `answerly-nq-btn answerly-invisible answerly-nq-cam-btn ${INJECTED}`;
        camBtn.title     = '';
        camBtn.dataset.qsig = sig;
        camBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
        header.insertBefore(camBtn, btn);

        camBtn.addEventListener('mouseenter', () => {
          document.getElementById('answerly-nq-stealth-tip')?.remove();
          const tip = document.createElement('div');
          tip.id = 'answerly-nq-stealth-tip';
          tip.className = 'answerly-nq-cam-tooltip';
          tip.textContent = '📸 Screenshot';
          document.body.appendChild(tip);
          const r = camBtn.getBoundingClientRect();
          tip.style.left = r.left + 'px';
          tip.style.top  = (r.top - 26) + 'px';
        });
        camBtn.addEventListener('mouseleave', () => {
          document.getElementById('answerly-nq-stealth-tip')?.remove();
        });
        camBtn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          if (camBtn.dataset.busy) return;
          camBtn.dataset.busy = 'true';
          doCameraCapture(camBtn, qEl, questionText);
        });
      }
    });
  }

  // ── API call ───────────────────────────────────────────────────────────────
  function fetchNQAnswer(card, questionText, options, isMultiSelect) {
    sendSolve(
      { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect: !!isMultiSelect },
      (resp) => {
        if (chrome.runtime.lastError || !resp) return renderNQError(card, 'Extension error — try reloading.');
        if (resp.error) return renderNQError(card, resp.error, resp.limitReached);
        renderNQResult(card, resp.hint, resp.answer, resp.answerParts, options);
      }
    );
  }

  function renderNQResult(card, hint, answer, answerParts, options) {
    const accent = theme.accentColor || DEFAULT_THEME.accentColor;
    const area   = card.querySelector('.answerly-nq-hint-area');
    area.innerHTML = `
      <div class="answerly-nq-hint-row" style="color:${theme.hintColor}!important">
        <span class="answerly-nq-hint-lbl" style="color:#fff!important">Hint: </span>${esc(hint)}
      </div>
      <button type="button" class="answerly-nq-reveal" data-open="false">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        Show Answer
      </button>`;

    area.querySelector('.answerly-nq-reveal').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const open = this.dataset.open === 'true';
      area.querySelector('.answerly-nq-answer-row')?.remove();

      if (open) {
        this.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg> Show Answer`;
        this.dataset.open = 'false';
      } else {
        // Build parts array — prefer server's answerParts, then match against options
        let parts;
        if (Array.isArray(answerParts) && answerParts.length > 0) {
          parts = answerParts;
        } else if (Array.isArray(options) && options.length > 0) {
          const ansLow = answer.toLowerCase();
          parts = options.filter(opt => ansLow.includes(opt.trim().toLowerCase()));
          if (!parts.length) parts = [answer];
        } else {
          parts = [answer];
        }

        let bodyHtml;
        if (parts.length > 1) {
          bodyHtml = parts.map((p, i) => `
            <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;${i < parts.length - 1 ? 'border-bottom:1px solid #2a2a4a;' : ''}">
              <span style="color:${accent};font-weight:900;flex-shrink:0;margin-top:1px;">✓</span>
              <span style="color:${theme.answerColor};font-weight:800;font-size:14px;line-height:1.4;">${esc(p)}</span>
            </div>`).join('');
        } else {
          bodyHtml = `<div class="answerly-nq-answer-text" style="color:${theme.answerColor}!important;font-weight:800!important;">${esc(parts[0] || answer)}</div>`;
        }

        const row = document.createElement('div');
        row.className = 'answerly-nq-answer-row';
        row.style.setProperty('border-color', theme.cardBorder, 'important');
        row.innerHTML = `<span class="answerly-nq-answer-lbl" style="color:${accent}!important">Answer</span>${bodyHtml}`;
        this.insertAdjacentElement('afterend', row);
        this.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(90deg)"><polyline points="9 18 15 12 9 6"/></svg> Hide Answer`;
        this.dataset.open = 'true';
      }
    });
  }

  function renderNQError(card, msg, limitReached) {
    const area = card.querySelector('.answerly-nq-hint-area');
    area.innerHTML = `<div class="answerly-nq-error">${esc(msg)}</div>` +
      (limitReached ? `<div class="answerly-nq-error" style="margin-top:5px!important;">Daily limit reached — resets at midnight UTC.</div>` : '');
  }

  // ── Solve All — direct API path (works in both normal + stealth mode) ────────
  // Bypasses the button-click UI so normal-mode cards are never shown and usage
  // is never burned on free-text/essay questions that can't be auto-selected.
  function _solveAllPass() {
    let delay = 0;
    let skippedImages = 0;   // picture / lossy-maths questions left for the screenshot tool
    findNQQuestions().forEach(qEl => {
      // Skip questions already answered by a previous pass
      const btn = qEl.querySelector(`.answerly-nq-btn.${INJECTED}:not(.answerly-nq-cam-btn)`);
      if (btn?.dataset.opened) return;

      const { questionText, options, inputOptionPairs, textInputEls, dropdownRows } = extractNQData(qEl);
      if (!questionText) return;

      const hasChoices    = inputOptionPairs.length > 0;
      const hasDropdowns  = dropdownRows.length > 0;
      const isFillInBlank = textInputEls.length > 0 && !hasChoices && !hasDropdowns;
      // Skip free-text / essay — no auto-select possible, don't burn usage
      if (!hasChoices && !hasDropdowns && !isFillInBlank) return;
      // Skip maths whose notation did not survive extraction, and questions
      // whose answer lives in a picture. The inputs look ordinary, so nothing
      // above catches either one, and answering them means guessing — which
      // reads as a normal answer and is wrong most of the time. Counted so the
      // caller can tell the student why some questions were left blank.
      if (nqNeedsScreenshotFor(qEl, questionText)) { skippedImages++; return; }
      // Skip already-filled text inputs
      if (isFillInBlank && textInputEls[0].value?.trim()) return;
      // Skip dropdown questions where every select already has a real choice
      if (hasDropdowns && dropdownRows.every(r => r.selectEl.selectedIndex > 0)) return;

      if (hasDropdowns) {
        setTimeout(() => {
          solveNQDropdowns(questionText, dropdownRows, (filled) => {
            if (filled && btn) btn.dataset.opened = 'true';
          });
        }, delay);
        // A matching question is one call; independent dropdowns are one each,
        // staggered internally — leave room for the whole set before the next Q.
        delay += isNQMatching(dropdownRows) ? 1600 : (dropdownRows.length * 1400);
        return;
      }

      setTimeout(() => {
        const isMultiSelect = hasChoices && inputOptionPairs[0]?.input.type === 'checkbox';
        sendSolve(
          { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect,
            blankCount: isFillInBlank ? textInputEls.length : undefined },
          (resp) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;
            const matched = isFillInBlank
              ? autoFillNQText(textInputEls, resp.answer, resp.answerParts)
              : autoSelectNQAnswer(qEl, resp.answer, inputOptionPairs, resp.answerParts);
            reportOutcome(resp, matched, matched ? undefined : (isFillInBlank ? 'solve-all: no input filled' : 'solve-all: no option matched'));
            if (matched && btn) btn.dataset.opened = 'true';
          }
        );
      }, delay);
      delay += 1200;
    });
    return { delay, skippedImages }; // time this pass takes, and what it refused
  }

  // The popup fires Solve All TWO ways so it reaches every frame: a runtime
  // message AND a storage write (popup.js). New Quizzes listens for both, so
  // without this guard one click ran solveAll() twice — and since each run does
  // a pass plus a retry, that was FOUR passes over every question. It doubled
  // the student's usage and let two passes race on the same question, where the
  // slower one could overwrite a correct answer with a different one.
  // Classic has had this guard (runSolveAll) all along; this mirrors it.
  let nqSolveAllRunning = false;

  function solveAll() {
    if (nqSolveAllRunning) return;  // repeated triggers never stack (= never double-bill)
    nqSolveAllRunning = true;
    injectStyles();
    injectButtons(); // ensure buttons exist so they can be marked done
    const { delay: firstPassDuration, skippedImages } = _solveAllPass();
    // Only the first pass reports skips. The retry re-walks the same questions
    // and would skip them again, popping a second toast ~8s later.
    if (skippedImages > 0) {
      try { chrome.storage.local.set({ answerlySkippedImages: { ts: Date.now(), count: skippedImages } }); } catch {}
      showNQScreenshotToast({ count: skippedImages });
    }
    // Retry pass — catches questions that failed to match on the first attempt
    const retryIn = Math.max(firstPassDuration + 6000, 8000);
    setTimeout(_solveAllPass, retryIn);
    // Release only after the retry has finished dispatching, so a second click
    // during the run can't start an overlapping set of passes.
    setTimeout(() => { nqSolveAllRunning = false; }, retryIn + 5000);
  }

  // ── Fill-in-blank stealth fill (no button click, direct API) ──────────────
  function stealthFillAll() {
    const questions = findNQQuestions();
    let delay = 0;
    questions.forEach(qEl => {
      const hasChoices = !!qEl.querySelector('input[type="radio"], input[type="checkbox"], select');
      if (hasChoices) return;

      const textInputs = Array.from(
        qEl.querySelectorAll('input[type="text"], input[type="number"], textarea')
      ).filter(el => !el.disabled && (el.offsetWidth || el.offsetHeight));
      if (!textInputs.length) return;
      if (textInputs[0].value && textInputs[0].value.trim()) return; // already filled

      const stemContainer = qEl.querySelector('div[tabindex="-1"]');
      const stemContent   = stemContainer
        ? stemContainer.querySelector('.user_content.enhanced')
        : qEl.querySelector('.user_content.enhanced');
      const qText = nqStemText(stemContent);
      if (!qText) return;

      setTimeout(() => {
        sendSolve(
          { type: 'SOLVE_QUESTION', question: qText, options: [], isMultiSelect: false,
            blankCount: textInputs.length },
          (resp) => {
            if (!chrome.runtime.lastError && resp && !resp.error) {
              autoFillNQText(textInputs, resp.answer, resp.answerParts);
            }
          }
        );
      }, delay);
      delay += 1200;
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  function removeAll() {
    document.querySelectorAll(`.${INJECTED}`).forEach(el => el.remove());
    observer?.disconnect();
    observer = null;
  }

  // Ignore batches that only describe our own injected nodes — reacting to those
  // re-enters injection and re-triggers the observer in a tight loop.
  function isOurNode(n) {
    if (n.nodeType !== 1) return false;
    if (n.id === 'answerly-nq-stealth-overlay') return true;
    const cl = n.classList;
    return !!cl && (cl.contains(INJECTED) || cl.contains('answerly-nq-card') ||
                    cl.contains('answerly-nq-btn') || cl.contains('answerly-nq-cam-tooltip'));
  }

  // Only our own ADDITIONS are safe to ignore — that is what stops the injection
  // loop. A REMOVAL must always trigger a re-check, including a removal of our
  // own nodes: when React drops an injected button, that batch is byte-identical
  // to one of our own teardowns, and calling it "ours" is what left the ? button
  // gone for good. Re-injection is idempotent, so reacting costs nothing.
  function isSelfMutation(records) {
    for (const r of records) {
      for (const n of r.removedNodes) if (n.nodeType === 1) return false;
      for (const n of r.addedNodes)   if (n.nodeType === 1 && !isOurNode(n)) return false;
    }
    return true;
  }

  function startObserver() {
    if (observer) return;
    if (!document.body) return;
    // Watch for New Quizzes React re-rendering new question wrappers
    let scheduled = false;
    observer = new MutationObserver((records) => {
      // Not our page — do no work at all. This is what keeps the two engines from
      // driving each other in a loop now that both can be live on one document.
      if (!isNQPage()) return;
      if (isSelfMutation(records)) return;
      if (scheduled) return;                 // coalesce bursts into one pass
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        if (solverActive) injectButtons();
        else if (screenshotStealthActive) injectCameraOnlyButtons();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function activate() {
    solverActive = true;
    injectStyles();
    const themeKey = currentCode ? 'answerlyTheme_' + currentCode : 'answerlyTheme';
    chrome.storage.local.get(themeKey, (t) => {
      if (t[themeKey]) theme = { ...DEFAULT_THEME, ...t[themeKey] };
      injectButtons();
      startObserver();
    });
  }

  function deactivate() {
    solverActive = false;
    removeAll();
    // If screenshot stealth is still on, keep camera buttons alive independently
    if (screenshotStealthActive) {
      injectCameraOnlyButtons();
      startObserver();
    }
  }

  // ── Storage-based state sync ───────────────────────────────────────────────
  // Primary mechanism for receiving popup toggle events in the quiz-lti iframe.
  // chrome.tabs.sendMessage targets the main frame — storage.onChanged reaches all frames.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.answerlyQuizActive !== undefined) {
      if (changes.answerlyQuizActive.newValue) activate();
      else deactivate();
    }

    if (changes.answerlyQuizStealthActive !== undefined) {
      stealthHidden = !!changes.answerlyQuizStealthActive.newValue;
      if (solverActive) { removeAll(); injectButtons(); startObserver(); }
    }

    // Either half of the screenshot pair can change on its own, and the stealth
    // flag alone does not mean the tool is on, so re-read both rather than
    // trusting the one key that fired.
    if (changes.answerlyScreenshotStealthActive !== undefined ||
        changes.answerlyScreenshotActive !== undefined) {
      chrome.storage.local.get(
        ['answerlyScreenshotActive', 'answerlyScreenshotStealthActive'],
        (s) => {
          if (chrome.runtime.lastError || !s) return;
          screenshotStealthActive = !!(s.answerlyScreenshotActive && s.answerlyScreenshotStealthActive);
          removeAll();
          if (solverActive) { injectButtons(); startObserver(); }
          else if (screenshotStealthActive) { injectStyles(); injectCameraOnlyButtons(); startObserver(); }
        }
      );
    }

    // Sign-in, sign-out or a code switch changes which answerlyTheme_<code> key
    // is ours. Without this the engine kept the old code and silently rendered
    // the previous user's colours until the page was reloaded.
    if (changes.answerlySession !== undefined) {
      // Buttons already on the page carry the OLD user's accent inline, and
      // injectButtons() deliberately skips a wrapper that already has a current
      // button — so without clearing first, the reloaded theme never repaints.
      removeAll();
      syncFromStorage();
      return;
    }

    // Solve All trigger — popup sets answerlyNQSolveAll to a timestamp.
    // _solveAllPass() (called inside solveAll) handles all question types including
    // fill-in-blank, so no separate stealthFillAll call is needed here.
    if (changes.answerlyNQSolveAll) {
      setTimeout(solveAll, 300);
    }

    // Theme changes
    const themeKey = currentCode ? 'answerlyTheme_' + currentCode : 'answerlyTheme';
    if (changes[themeKey] && solverActive) {
      theme = { ...DEFAULT_THEME, ...changes[themeKey].newValue };
      removeAll();
      injectStyles();
      injectButtons();
      startObserver();
    }
  });

  // ── Runtime message listener ───────────────────────────────────────────────
  // Background.js injects this script and may also forward messages to it.
  // This handles both manual injection (background.js executeScript + sendMessage)
  // and manifest-declared auto-injection.
  chrome.runtime.onMessage.addListener((msg) => {
    // Sent by background.js after a page navigation — storage is authoritative.
    if (msg.type === 'ANSWERLY_SYNC') { syncFromStorage(); return; }

    if (msg.type === 'QUIZ_SOLVER_ON') {
      if (msg.stealth !== undefined) stealthHidden = msg.stealth;
      activate();
    }
    if (msg.type === 'QUIZ_SOLVER_OFF') deactivate();

    if (msg.type === 'QUIZ_STEALTH_ON') {
      stealthHidden = true;
      if (solverActive) { removeAll(); injectButtons(); startObserver(); }
    }
    if (msg.type === 'QUIZ_STEALTH_OFF') {
      stealthHidden = false;
      if (solverActive) { removeAll(); injectButtons(); startObserver(); }
    }

    if (msg.type === 'SOLVE_ALL') {
      setTimeout(solveAll, 300);
    }

    if (msg.type === 'SS_STEALTH_ON') {
      screenshotStealthActive = true;
      removeAll();
      if (solverActive) { injectButtons(); startObserver(); }
      else              { injectCameraOnlyButtons(); startObserver(); }
    }
    if (msg.type === 'SS_STEALTH_OFF') {
      screenshotStealthActive = false;
      removeAll();
      if (solverActive) { injectButtons(); startObserver(); }
    }
  });

  // ── Initialize / re-sync from storage ─────────────────────────────────────
  // Because this script runs inside an iframe, the popup may have already
  // activated the solver before this frame loaded. Storage is authoritative,
  // so this also runs on ANSWERLY_SYNC after a page navigation.
  function syncFromStorage() {
    chrome.storage.local.get([
      'answerlyQuizActive', 'answerlyQuizStealthActive',
      'answerlyScreenshotActive', 'answerlyScreenshotStealthActive', 'answerlySession'
    ], (s) => {
      // A failed read (worker restart / invalidated context) comes back empty.
      // quizSolver.js has bailed out here for a long time; this engine did not,
      // so a blank read tore the buttons off a working page. Keep what is up.
      if (chrome.runtime.lastError || !s || typeof s !== 'object') return;
      if (stateReady && currentCode && !s.answerlySession) return;
      stateReady              = true;
      currentCode             = s.answerlySession?.code || null;
      stealthHidden           = !!s.answerlyQuizStealthActive;
      // A stealth flag is only meaningful while its PARENT tool is on. The
      // screenshot widget's own X button clears answerlyScreenshotActive but
      // leaves the stealth flag stranded `true`, which made camera buttons
      // show up on a fresh quiz with the toggle off. Classic gates on both.
      screenshotStealthActive = !!(s.answerlyScreenshotActive && s.answerlyScreenshotStealthActive);
      if (s.answerlyQuizActive) {
        activate(); // handles camera buttons too via injectButtons()
      } else if (screenshotStealthActive) {
        injectStyles();
        injectCameraOnlyButtons();
        startObserver();
      } else {
        deactivate();
      }
    });
  }

  // ── Recovery timer ─────────────────────────────────────────────────────────
  // quizSolver.js and screenshotTool.js have had one of these for a long time;
  // this engine had none, which is why a vanished button came back on Classic
  // within ~2s but stayed gone on New Quizzes until a reload. The observer can
  // still miss a removal (a coalesced batch, a detached subtree), and React
  // re-renders here constantly, so a timer is the only reliable backstop.
  //
  // Purely additive, per the state rules: injectButtons() and
  // injectCameraOnlyButtons() skip any wrapper that already carries a current
  // button, so this can never tear down a good one — it only fills gaps.
  let nqRecheckPending = false;
  setInterval(() => {
    if (!isNQPage()) return;
    if (solverActive)                 { injectStyles(); injectButtons(); startObserver(); try { getRelatedQuestions(); } catch {} maybeShowNotesNudge(); }
    else if (screenshotStealthActive) { injectStyles(); injectCameraOnlyButtons(); startObserver(); }
    else if (!nqRecheckPending) {
      // Nothing should be on the page. Re-verify against storage now and then so
      // one bad read can never leave it permanently bare.
      nqRecheckPending = true;
      setTimeout(() => { nqRecheckPending = false; syncFromStorage(); }, 3000);
    }
  }, 2000);

  syncFromStorage();

})();
} // end guard
