// ── Answerly AI — Quiz Solver Content Script ─────────────────────────────────────
if (window.__answerlyQuizSolverLoaded) { /* already running */ } else {
window.__answerlyQuizSolverLoaded = true;

(function () {
  'use strict';

  let solverActive              = false;
  let stealthHidden             = false; // quiz stealth: hides ? button
  let screenshotStealthActive   = false; // screenshot stealth: shows camera button
  let observer                  = null;
  let currentCode               = null;
  const INJECTED                = 'answerly-injected';

  // ── Stealth solve keybind (customizable) ─────────────────────────────────────
  // When Quiz Stealth is on AND the user enabled a keybind in Customize, pressing
  // that key while hovering over a question triggers its answer — same as clicking
  // the invisible ? button. Config is read live from storage.
  let stealthKeybind = { enabled: false, key: '' };
  // -1 = "the mouse has not moved in this document yet". Starting at 0,0 meant
  // that after every page navigation the keybind aimed at the top-left corner
  // and silently did nothing until the user jiggled the mouse.
  let keybindMouseX  = -1, keybindMouseY = -1;
  // Keys that must never be bindable — a bare modifier would make EVERY press of
  // it fire a billed solve. Also repairs configs that already saved a bad key.
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
    if (!stealthHidden) return;                 // only active in Quiz Stealth mode
    if (KEYBIND_BLOCKED.includes(stealthKeybind.key)) return;
    if (e.repeat) return;                        // ignore auto-repeat from a held key
    // Never hijack a browser/OS shortcut (Ctrl+R, Cmd+F, Alt+Left …). AltGr
    // (ctrl+alt) is allowed through because it composes real characters.
    if (e.metaKey || (e.ctrlKey && !e.altKey) || (e.altKey && !e.ctrlKey)) return;
    // Case-insensitive for single characters, so CapsLock/Shift don't break it
    const want = stealthKeybind.key;
    const hit  = want.length === 1
      ? e.key.length === 1 && e.key.toLowerCase() === want.toLowerCase()
      : e.key === want;
    if (!hit) return;
    // Don't hijack the key while the user is typing. Deliberately does NOT block
    // radios/checkboxes (tagName is also "input") — clicking an option used to
    // kill the keybind for the rest of the question.
    const t = e.target;
    if (t && (t.isContentEditable ||
        (t.matches && t.matches('textarea, input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="password"], input[type="tel"], input[type="url"], input:not([type])')))) return;

    let qEl = null;
    if (keybindMouseX >= 0) {
      const el = document.elementFromPoint(keybindMouseX, keybindMouseY);
      qEl = el && el.closest('div.question.display_question, div[id^="question_"].question, .question_holder > .question, div[data-question-type], .quiz-question');
    }
    if (!qEl) {
      // Fallback ONLY when the mouse has never moved in this document AND the
      // page shows exactly one question (one-question-per-page quizzes). Kept
      // narrow because each trigger forces a fresh billed solve.
      if (keybindMouseX >= 0) return;
      const qs = findQuestions();
      if (qs.length !== 1) return;
      qEl = qs[0];
    }
    const trigger = qEl.querySelector('.answerly-btn:not(.answerly-cam-btn)');
    if (trigger) {
      e.preventDefault();
      // Clear the "already solved" markers so the key always triggers a fresh
      // solve — guarantees usage is counted even on a previously-solved question.
      delete trigger.dataset.done;
      delete trigger.dataset.opened;
      solvedQ.delete(qEl);
      clearInflight(qEl);
      qEl.querySelectorAll('.answerly-card').forEach(c => { delete c.dataset.loaded; });
      trigger.click();
    }
  }, true);

  const DEFAULT_THEME = {
    accentColor: '#7c5cfc',
    cardBg:      '#1a1a2e',
    cardBorder:  '#7c5cfc',
    answerColor: '#ffffff',
    hintColor:   '#c0c0d8',
    opacity:     100,
  };
  let theme = { ...DEFAULT_THEME };

  // ── Single source of truth ─────────────────────────────────────────────────
  // Storage is authoritative. Every entry point (bootstrap, storage.onChanged,
  // runtime messages) funnels through syncState(); render() is idempotent.
  // This is what makes state survive Canvas's one-question-per-page navigation:
  // a re-injected OR already-loaded document always re-reads the real state
  // instead of relying on a message that may never arrive.
  let stateReady      = false;
  let syncChain       = Promise.resolve();
  let pendingSolveAll = 0;

  function readState() {
    return new Promise(resolve => {
      chrome.storage.local.get([
        'answerlyQuizActive', 'answerlyQuizStealthActive',
        'answerlyScreenshotActive', 'answerlyScreenshotStealthActive', 'answerlySession'
      ], (s) => {
        // A failed read (worker restart / invalidated context) returns an empty
        // object. Treating that as "everything is off" would wipe the buttons off
        // a working page, so bail out and keep whatever is already rendered.
        if (chrome.runtime.lastError || !s || typeof s !== 'object') { resolve(null); return; }
        // Same defence for a read that "succeeds" but comes back blank: once we
        // have seen a real session, a result with no session at all is a racy or
        // half-torn-down read, never a genuine "user turned everything off".
        if (stateReady && currentCode && !s.answerlySession) { resolve(null); return; }
        currentCode = s.answerlySession?.code || null;
        const themeKey = currentCode ? 'answerlyTheme_' + currentCode : 'answerlyTheme';
        // Chained, not raced — nothing injects until the theme is resolved too,
        // so buttons are never built with the default theme or a stale mode.
        chrome.storage.local.get(themeKey, (t) => {
          theme = { ...DEFAULT_THEME, ...(t[themeKey] || {}) };
          // A stealth flag is only meaningful while its PARENT tool is on.
          // Both stealth flags can be stranded `true` in storage (e.g. the
          // screenshot widget's own X button clears answerlyScreenshotActive but
          // not its stealth flag), which is what made stealth buttons appear on
          // a fresh page even though the toggle was off.
          resolve({
            quizActive:  !!s.answerlyQuizActive,
            quizStealth: !!(s.answerlyQuizActive       && s.answerlyQuizStealthActive),
            ssStealth:   !!(s.answerlyScreenshotActive && s.answerlyScreenshotStealthActive),
          });
        });
      });
    });
  }

  // Idempotent: re-renders ONLY on an actual state transition (or force).
  function syncState(force) {
    syncChain = syncChain.then(readState).then(st => {
      if (!st) return;              // read failed — keep the current render
      const changed = !!force || !stateReady ||
        st.quizActive  !== solverActive ||
        st.quizStealth !== stealthHidden ||
        st.ssStealth   !== screenshotStealthActive;

      solverActive            = st.quizActive;
      stealthHidden           = st.quizStealth;   // BIDIRECTIONAL — never latches on
      screenshotStealthActive = st.ssStealth;
      stateReady              = true;

      if (changed) render();
      drainPendingSolveAll();
    }).catch(() => { /* extension context invalidated — ignore */ });
    return syncChain;
  }

  function render() {
    removeAll();                       // also disconnects + nulls the observer
    // New Quizzes owns this page — leave it entirely to newQuizSolver.js. The
    // removeAll() above also clears anything injected before React swapped the
    // page over to New Quizzes markup.
    if (isNewQuizzesPage()) return;
    if (!solverActive && !screenshotStealthActive) return;
    injectStyles();
    if (solverActive) injectButtons();
    else              injectCameraOnlyButtons();
    startObserver();
  }

  // ── Solve bookkeeping ──────────────────────────────────────────────────────
  // Keyed on the QUESTION element so it survives removeAll() (which only deletes
  // our own injected nodes, never Canvas's DOM). Deliberately NOT persisted —
  // a Next-click is a new document, therefore a new question.
  // Replaces the old dataset.opened flag, which was also set by merely VIEWING
  // a card and so permanently blocked Solve All on one-question-per-page quizzes.
  const solvedQ   = new WeakSet();
  const inflightQ = new Map();      // qEl -> dispatch timestamp

  // Locks a trigger button while its solve is in flight. The watchdog matters:
  // an MV3 service-worker teardown can drop the response callback, and without
  // it dataset.done stayed 'true' forever — the button looked alive but every
  // further click did nothing. That is the "works sometimes" stealth bug.
  function lockBtn(btn) {
    if (!btn) return;
    btn.dataset.done = 'true';
    // Last-resort release. Unconditional: previously this skipped buttons marked
    // solved, so after ONE successful solve the button was dead forever and only
    // a deactivate/activate cycle brought it back.
    setTimeout(() => { btn.dataset.done = ''; }, 90000);
  }

  // ── Quiz-level context ──────────────────────────────────────────────────────
  // Reads the quiz's description / instructions and any shared reading passages
  // ONCE per page, and hands that back so it can ride along with each solve as
  // reference material. This is what lets passage-based and "based on the
  // reading / chapter X" quizzes answer correctly — previously each question was
  // sent to the AI in isolation, with the shared context it referred to invisible.
  let quizContextCache = null;      // null = not computed yet; '' = computed, empty
  function getQuizContext() {
    if (quizContextCache === null) {
      try { quizContextCache = extractQuizContext(); } catch { quizContextCache = ''; }
    }
    return quizContextCache;
  }

  function extractQuizContext() {
    const parts = [];

    // 1. The quiz description / instructions block. This is the single most
    //    important thing to capture: on grammar/"identify the ___" quizzes each
    //    question is just a sentence + word options, and WITHOUT the instruction
    //    ("Find the adverb") the model has no idea what it is being asked and
    //    scores near random. So try the known Canvas containers first, then fall
    //    back to a structural heuristic so a class name we didn't predict can't
    //    make us miss it.
    const descSelectors = [
      '#quiz_instructions', '.quiz-instructions', '.quiz_description',
      '.description.user_content', '.description', '[data-region="quiz_description"]',
      '#quiz_show .user_content', '.quiz-header .user_content',
    ];
    let descEl = null;
    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest('.question') && (el.innerText || '').trim().length > 15) {
        descEl = el; break;
      }
    }
    // Heuristic fallback: the first substantial .user_content / .description block
    // that is NOT part of a question and sits ABOVE the first question — which is
    // exactly where Canvas renders the quiz instructions, whatever it classes it.
    if (!descEl) {
      const firstQ = document.querySelector('.question.display_question, .question_holder, .question');
      const blocks = document.querySelectorAll('.user_content, .description, [class*="instructions"]');
      for (const el of blocks) {
        if (el.closest('.question')) continue;
        if ((el.innerText || '').trim().length < 15) continue;
        const above = !firstQ ||
          (firstQ.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
        if (above) { descEl = el; break; }
      }
    }
    if (descEl) parts.push((descEl.innerText || '').trim());

    // 2. Shared reading passages: Canvas "text (no question)" items render as a
    //    question with a stem but no answers. Other questions refer back to these
    //    ("read the passage above"), so they are exactly the context to include.
    document.querySelectorAll('.question.text_only_question').forEach(q => {
      const te = q.querySelector('.question_text, .text');
      const t  = te ? (te.innerText || '').trim() : '';
      if (t && t.length > 20) parts.push(t);
    });

    // Drop purely administrative text (time limits, attempts, honor-code, etc.)
    // — it adds no answering value and only dilutes the real context.
    //
    // "save (your )?answers" is deliberately qualified: bare, it also matched
    // "Save your answers as fractions, not decimals" — a pure formatting rule —
    // and threw it away. It must look like advice about saving PROGRESS.
    const ADMIN = /time limit|attempts? allowed|this quiz was locked|once you (submit|start|begin)|you have \d+\s*(minute|hour|second)|no calculator|academic (integrity|honesty|dishonesty)|honor (code|pledge)|do not (refresh|close|navigate)|points? (possible|each)|due (date|at)|multiple attempts|save (your )?answers?\s+(often|frequently|periodically|regularly|as you go|before|after)|proctor/i;

    // Instructors routinely put admin and instruction in ONE sentence —
    // "Due at 11:59pm — express all answers in scientific notation." Filtering
    // whole lines threw the formatting rule out with the due date, so filter at
    // clause level instead. The separators are captured and re-emitted, so a
    // clause that is KEPT is rejoined byte-for-byte: "Last Name - First Name"
    // survives a split on " - " intact.
    const CLAUSE = /((?:(?<=[.;!?])\s+)|(?:\s+[—–]\s+)|(?:\s+-\s+))/;
    const stripAdmin = (line) => {
      const pieces = line.split(CLAUSE);   // [seg, sep, seg, sep, ...]
      let out = '';
      let prevKept = -2;
      for (let i = 0; i < pieces.length; i += 2) {
        const seg = pieces[i];
        if (!seg || ADMIN.test(seg)) continue;        // drop segment + its separator
        // Reuse the original separator only when it genuinely joined this segment
        // to the last one we kept. Otherwise it belonged to text we just dropped,
        // and re-emitting it strands a dangling " - " mid-sentence.
        const sep = out ? (prevKept === i - 2 ? (pieces[i - 1] || ' ') : ' ') : '';
        out += sep + seg;
        prevKept = i;
      }
      return out.trim();
    };

    let ctx = parts.join('\n\n')
      .split('\n')
      .map(line => stripAdmin(line.trim()))
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (ctx.length < 25) return '';                  // nothing worth sending
    if (ctx.length > 6000) ctx = ctx.slice(0, 6000).trim() + '…';
    return ctx;
  }

  // A sleeping MV3 service worker rejects the first message with "Could not
  // establish connection / Receiving end does not exist". That request never
  // reached the backend, so retrying is safe and cannot double-bill. Without it
  // the first click after an idle period silently did nothing — the single
  // biggest cause of "stealth works sometimes and sometimes it doesn't".
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

  // WHY a selection failed, not merely that it did. A bare "no option matched"
  // cannot tell a scrape that read no options at all from a page that
  // re-rendered before the answer came back — two different bugs with the same
  // symptom, and no way to pick between them after the fact.
  function selectFailDetail(qEl, options, resp) {
    try {
      const radios = qEl.querySelectorAll('input[type="radio"]').length;
      const cbs    = qEl.querySelectorAll('input[type="checkbox"]').length;
      const parts  = Array.isArray(resp && resp.answerParts) ? resp.answerParts.length : 0;
      return `no option matched | sent=${(options || []).length} radios=${radios} cbs=${cbs} parts=${parts}`;
    } catch { return 'no option matched'; }
  }

  function sendSolve(msg, cb, attempt) {
    attempt = attempt || 1;
    // Attach the quiz's own description / shared reading as extra context on the
    // FIRST send only (retries reuse the same msg object, which already has it).
    // Purely additive — if the quiz has nothing substantive, nothing is attached
    // and the request is byte-for-byte what it was before.
    if (msg && (msg.type === 'SOLVE_QUESTION' || msg.type === 'SOLVE_MATCHING') &&
        !('quizContext' in msg)) {
      const qc = getQuizContext();
      if (qc) msg.quizContext = qc;
    }
    // Quiz identity — attached to every solve type, including screenshots.
    if (msg && !('quizTitle' in msg)) {
      const qt = getQuizTitle();
      if (qt) msg.quizTitle = qt;
    }
    let settled = false;
    const finish = (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cb(resp);
    };
    // Safety net: if the worker dies mid-flight the response callback may never
    // fire at all. Without this the question stayed "in flight" and every later
    // click was ignored. Sized past the background's own 75s request timeout so
    // it only ever fires when the response is genuinely lost — and it does NOT
    // auto-retry, because that request may have reached the backend and billed.
    const timer = setTimeout(() => finish(undefined), 80000);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        const undelivered = err && /could not establish connection|receiving end does not exist/i
          .test(err.message || '');
        if (undelivered && attempt < 4) {
          clearTimeout(timer);
          settled = true;
          setTimeout(() => sendSolve(msg, cb, attempt + 1), 300 * attempt);
          return;
        }
        finish(resp);
      });
    } catch {
      finish(undefined);   // extension context gone — let the caller unlock
    }
  }

  // ── Service-worker heartbeat ───────────────────────────────────────────────
  // Keeps the background worker awake while a tool is active on this page, so a
  // click after a quiet period is never dropped waking it up.
  setInterval(() => {
    if (!stateReady) return;
    if (!solverActive && !screenshotStealthActive) return;
    try { chrome.runtime.sendMessage({ type: 'PING' }, () => void chrome.runtime.lastError); } catch {}
  }, 20000);

  // Release the click lock shortly after a solve completes, so a deliberate
  // re-click always works. The short cooldown still absorbs accidental
  // double-clicks on the invisible stealth button (which would cost usage).
  function unlockBtnSoon(btn, ms) {
    if (!btn) return;
    setTimeout(() => { btn.dataset.done = ''; }, ms || 2500);
  }

  // Decides whether a click should be ignored. Deliberately does NOT trust
  // btn.dataset.done on its own: that flag could be left set while nothing was
  // actually in flight, and the click then vanished with no answer and no error
  // — the "stealth works sometimes and sometimes it doesn't" bug. The only real
  // reasons to skip are: a request genuinely in flight, or a double-click.
  function shouldIgnoreClick(btn, qEl) {
    if (isBusy(qEl)) {                                  // real in-flight request
      return true;
    }
    const last = +(btn.dataset.lastClick || 0);
    if (Date.now() - last < 1200) return true;          // accidental double-click
    btn.dataset.lastClick = String(Date.now());
    btn.dataset.done = '';                              // clear any stale lock
    return false;
  }

  // Same idea for the invisible camera button: a `busy` flag left over from an
  // abandoned capture must never permanently swallow clicks. A capture is only
  // really in progress while its selection overlay is on screen.
  function shouldIgnoreCamClick(camBtn) {
    const overlayOpen = !!document.getElementById('answerly-stealth-overlay');
    const busyAt = +(camBtn.dataset.busyAt || 0);
    // Short window: while the overlay is open the capture is genuinely running,
    // so that check does the real work. This only guards the brief gap before
    // the overlay appears — a long window meant one abandoned capture left the
    // camera button dead for a minute and a half.
    const recentlyBusy = camBtn.dataset.busy && (Date.now() - busyAt < 8000);
    if (overlayOpen || recentlyBusy) return true;
    camBtn.dataset.busy   = '';                         // clear stale lock
    camBtn.dataset.busyAt = String(Date.now());
    return false;
  }

  function markSolved(qEl)    { if (qEl) solvedQ.add(qEl); }
  function markInflight(qEl)  { if (qEl) inflightQ.set(qEl, Date.now()); }
  function clearInflight(qEl) { inflightQ.delete(qEl); }
  function isBusy(qEl) {
    const t = inflightQ.get(qEl);
    if (!t) return false;
    // Self-healing: never wedge. Sized just past the background fetch timeout
    // (75s) so a slow cold-start solve is not treated as dead and re-billed.
    if (Date.now() - t > 90000) { inflightQ.delete(qEl); return false; }
    return true;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('answerly-styles')) return;
    const s = document.createElement('style');
    s.id = 'answerly-styles';
    s.textContent = `
      .answerly-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important; height: 26px !important;
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
        z-index: 2147483646 !important;
        line-height: 1 !important;
        pointer-events: all !important;
      }
      .answerly-btn:hover {
        transform: scale(1.12) !important;
        box-shadow: 0 3px 14px rgba(124,92,252,.75) !important;
      }
      .answerly-btn:active { transform: scale(0.95) !important; }

      /* Auto-select invisible mode */
      .answerly-btn.answerly-invisible {
        opacity: 0 !important;
        box-shadow: none !important;
        background: transparent !important;
        /* Without this an ancestor with pointer-events:none (some Canvas themes
           set it on question headers) makes the invisible button unclickable —
           the New Quizzes engine already had this rule, the classic one did not. */
        pointer-events: all !important;
      }
      /* Enlarged invisible hit area. The button is only 26px and completely
         invisible, so on a page you have not already seen it on, a click that is
         a few pixels off simply misses and nothing happens. This expands the
         clickable region to roughly 46x58px without changing layout or showing
         anything, so the target no longer has to be found pixel-perfectly. */
      .answerly-btn.answerly-invisible::after {
        content: '' !important;
        position: absolute !important;
        top: -16px !important;
        bottom: -16px !important;
        left: -10px !important;
        right: -10px !important;
        display: block !important;
        background: transparent !important;
        pointer-events: all !important;
      }
      .answerly-btn.answerly-invisible:hover {
        opacity: 0 !important;
        transform: none !important;
        box-shadow: none !important;
        pointer-events: all !important;
      }
      /* Camera stealth button — tooltip on hover reveals it without a visible cursor change */
      .answerly-cam-tooltip {
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

      /* Hint + Answer card */
      .answerly-card {
        margin: 10px 0 !important;
        background: #1a1a2e !important;
        border: 1px solid #3a3a5c !important;
        border-radius: 10px !important;
        padding: 14px 16px !important;
        font-size: 13px !important;
        line-height: 1.55 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
        animation: answerly-in .2s ease !important;
        box-sizing: border-box !important;
      }
      @keyframes answerly-in {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .answerly-badge {
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

      .answerly-hint-row {
        color: #c0c0d8 !important;
        margin-bottom: 10px !important;
        font-size: 13px !important;
      }
      .answerly-hint-lbl {
        color: #fff !important;
        font-weight: 700 !important;
        margin-right: 4px !important;
      }

      .answerly-reveal {
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
      .answerly-reveal:hover {
        background: rgba(124,92,252,.15) !important;
        border-color: #7c5cfc !important;
        color: #fff !important;
      }

      .answerly-answer-row {
        margin-top: 10px !important;
        padding: 10px 14px !important;
        background: #0f0f1e !important;
        border: 1px solid #7c5cfc !important;
        border-radius: 8px !important;
        animation: answerly-in .15s ease !important;
      }
      .answerly-answer-lbl {
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: .8px !important;
        color: #7c5cfc !important;
        text-transform: uppercase !important;
        display: block !important;
        margin-bottom: 4px !important;
      }
      .answerly-answer-text {
        color: #ffffff !important;
        font-weight: 800 !important;
        font-size: 14px !important;
        line-height: 1.4 !important;
      }

      .answerly-loading {
        color: #a090f0 !important;
        font-size: 12px !important;
        font-style: italic !important;
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
      }
      .answerly-spinner {
        width: 12px !important; height: 12px !important;
        border: 2px solid #3a3a5c !important;
        border-top-color: #7c5cfc !important;
        border-radius: 50% !important;
        animation: answerly-spin .65s linear infinite !important;
        flex-shrink: 0 !important;
      }
      @keyframes answerly-spin { to { transform: rotate(360deg); } }

.answerly-error { color: #f05454 !important; font-size: 12px !important; }

      /* ── Stealth camera region-selector overlay ── */
      #answerly-stealth-overlay {
        position: fixed; top:0; left:0; width:100vw; height:100vh;
        z-index: 2147483646; cursor: none; user-select:none; -webkit-user-select:none;
      }
      #answerly-stealth-overlay canvas { position:absolute; top:0; left:0; display:block; }
      #answerly-stealth-hint {
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
  // True when Instructure's "New Quizzes Canvas Native Integration" is rendering
  // the quiz directly in this page instead of inside the quiz-lti iframe. Default
  // for everyone since 2026-07-01, enforced 2026-08-15.
  function isNewQuizzesPage() {
    return !!document.querySelector('[data-automation="sdk-item-wrapper"]');
  }

  function findQuestions() {
    // Hand the page to newQuizSolver.js, which has the selectors for this markup.
    // Without this, the Classic selectors below match nothing on a New Quizzes
    // page, and anything this engine did manage to inject got wiped by React's
    // next re-render and re-added by the observer — the buttons "appearing and
    // disappearing".
    if (isNewQuizzesPage()) return [];
    const selectors = [
      'div.question.display_question',
      'div[id^="question_"].question',
      '.question_holder > .question',
      'div[data-question-type]',
      '.quiz-question',
    ];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length) return els;
    }
    return [];
  }

  // ── Maths recovery ──────────────────────────────────────────────────────────
  // Canvas does not render equations as text. Classic Quizzes emits
  //   <img class="equation_image" title="\log_2 16 = x"
  //        alt="LaTeX: \log_2 16 = x" data-equation-content="\log_2 16 = x">
  // and MathJax emits an <mjx-container> whose TeX lives in an <annotation>.
  // Either way the equation is PIXELS, and innerText returns nothing for it.
  //
  // That is how "Solve for x: log₂16 = x" reached the model as the bare string
  // "Solve for x:" — three different questions on one quiz sent byte-identical
  // prompts, and the model had no choice but to guess. Every symbol needed to
  // answer correctly was already in the DOM, one attribute away.
  function equationLatex(img) {
    let tex = img.getAttribute('data-equation-content') ||
              img.getAttribute('title') ||
              img.getAttribute('alt') || '';
    tex = tex.replace(/^\s*LaTeX:\s*/i, '').trim();   // Canvas prefixes the alt
    return tex;
  }

  function isEquationImage(img) {
    return (img.classList && img.classList.contains('equation_image')) ||
           img.hasAttribute('data-equation-content') ||
           /^\s*LaTeX:/i.test(img.getAttribute('alt') || '');
  }

  /** Every equation in `el`, in document order, as LaTeX. */
  function equationTexts(el) {
    if (!el) return [];
    const out = [];
    el.querySelectorAll('img').forEach(img => {
      if (!isEquationImage(img)) return;
      const tex = equationLatex(img);
      if (tex) out.push(tex);
    });
    // MathJax / MathML: the TeX source is kept in an annotation node.
    el.querySelectorAll('annotation[encoding="application/x-tex"]').forEach(a => {
      const tex = (a.textContent || '').trim();
      if (tex) out.push(tex);
    });
    return out.filter((t, i, arr) => arr.indexOf(t) === i);   // dedupe
  }

  /**
   * innerText plus any equations innerText dropped.
   *
   * Used for BOTH the question stem and the answer labels. Answer options are
   * every bit as likely to be equation images as the question is — "Which
   * expression equals 8?" with 2^3 and log_2 256 as choices renders all of them
   * as pictures. Those options came back as empty strings, were dropped by the
   * dedupe in extractData, and the model was handed a shorter list than the
   * student could see. Auto-select then had nothing to match against either.
   */
  function textWithMath(el, joiner) {
    if (!el) return '';
    // innerText is empty on a node that is not being rendered, which is exactly
    // what stemWithoutSelectOptions() hands over, so fall back to textContent.
    const base = (el.innerText || el.textContent || '').trim();
    const eqs = equationTexts(el);
    if (!eqs.length) return base;
    return base ? base + (joiner || ' ') + eqs.join(' ') : eqs.join(' ');
  }

  /**
   * The stem, with each inline <select> reduced to a numbered blank.
   *
   * A dropdown renders its whole option list as text, so innerText turned
   * "the Krebs cycle occurs in the ___" into "the Krebs cycle occurs in the
   * [ Select ] cytoplasm nucleus mitochondrial matrix ribosome lysosome". Every
   * candidate arrives as prose and the first one reads as the answer, so the
   * model is handed a sentence asserting something false before it has chosen
   * anything — on a four-blank question that is 400-odd characters of it.
   *
   * The options are not lost: each row still carries its own list, which is
   * where the model is actually asked to choose. Returns null when the stem has
   * no select, so every other question type keeps its existing text exactly.
   */
  function stemWithoutSelectOptions(textEl) {
    if (!textEl || !textEl.querySelector || !textEl.querySelector('select')) return null;
    try {
      const clone = textEl.cloneNode(true);
      clone.querySelectorAll('select').forEach((sel, i) => {
        sel.replaceWith(document.createTextNode(` [blank ${i + 1}] `));
      });
      // Deliberately never inserted into the page: attaching it would trip the
      // MutationObserver into a re-injection pass on every extract.
      const out = textWithMath(clone, '\n');
      return out && out.trim() ? out : null;
    } catch { return null; }
  }

  function extractData(qEl) {
    const textEl =
      qEl.querySelector('.question_text') ||
      qEl.querySelector('[data-question-text]') ||
      qEl.querySelector('.question-text');
    // innerText stays the base, untouched — appending rather than rebuilding the
    // string keeps every existing question behaving exactly as it did, and only
    // ADDS the maths that was previously dropped on the floor.
    const questionText = stemWithoutSelectOptions(textEl) || textWithMath(textEl, '\n');

    // Build the options list from the INPUTS themselves, using the very same
    // getOptionLabelText() that auto-select uses to identify them later.
    //
    // Previously this read `.answer_label` selectors instead. When those two
    // extractions disagreed even slightly (nested markup, extra whitespace, a
    // letter prefix) the AI's answer no longer matched any option, auto-select
    // silently did nothing, and stealth mode looked broken while normal mode
    // seemed fine — because normal mode just displays the answer on a card.
    // Sourcing both from one function also keeps index N of `options` aligned
    // with input N, which lets us select by index and skip text matching.
    const seen = new Set();
    const options = [];
    const inputEls = Array.from(qEl.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    inputEls.forEach(input => {
      const t = getOptionLabelText(input, qEl);
      if (t && !seen.has(t)) { seen.add(t); options.push(t); }
    });

    // Fallback for layouts with no real inputs (rendered choices, etc.)
    if (options.length === 0) {
      qEl.querySelectorAll(
        '.answer .answer_label, .answer_label, [data-answer-text], ' +
        '.answer .answer_text, .answer_text, .answer label'
      ).forEach(el => {
        const t = el.innerText.trim();
        if (t && !seen.has(t)) { seen.add(t); options.push(t); }
      });
    }

    // Detect dropdown (select) questions
    const dropdownRows = [];
    qEl.querySelectorAll('select').forEach(sel => {
      // Skip hidden selects Canvas may use internally
      if (!sel.offsetWidth && !sel.offsetHeight) return;
      const rowOptions = [];
      sel.querySelectorAll('option').forEach(opt => {
        const t = opt.textContent.trim();
        if (t && !t.startsWith('[') && !t.startsWith('(')) rowOptions.push(t);
      });
      if (!rowOptions.length) return;

      // Find a row label for this select — Canvas puts labels in many different places
      let rowLabel = '';

      function extractLabel(el) {
        return el ? el.innerText.replace(/\[\s*(?:Select|Choose|Answer)\s*\]/gi, '').trim().slice(0, 120) : '';
      }

      // 1. Canvas-specific class selectors — fastest, most reliable
      const matchContainer = sel.closest('.select_answer, .answer_group > div, .answer_row, [class*="match"]');
      if (!rowLabel && matchContainer) {
        const lbl = matchContainer.querySelector('.answer_match_left, [class*="match_left"], [class*="left_side"]');
        if (lbl) rowLabel = extractLabel(lbl);
      }

      // 2. Table row: find the TD that does NOT contain this select
      if (!rowLabel) {
        const tr = sel.closest('tr');
        if (tr) {
          for (const cell of tr.querySelectorAll('td, th')) {
            if (!cell.contains(sel)) { rowLabel = extractLabel(cell); if (rowLabel) break; }
          }
        }
      }

      // 3. Previous siblings of the select itself
      if (!rowLabel) {
        let node = sel.previousSibling;
        let before = '';
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) before = node.textContent + before;
          else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SELECT') break;
            before = node.innerText + before;
          }
          node = node.previousSibling;
          if (before.trim().length > 100) break;
        }
        rowLabel = before.replace(/\[\s*(?:Select|Choose|Answer)\s*\]/gi, '').trim().slice(-80);
      }

      // 4. Next siblings of the select (Canvas sometimes puts label AFTER the select)
      if (!rowLabel) {
        let node = sel.nextSibling;
        let after = '';
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) after += node.textContent;
          else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SELECT') break;
            after += node.innerText;
          }
          node = node.nextSibling;
          if (after.trim().length > 100) break;
        }
        rowLabel = after.replace(/\[\s*(?:Select|Choose|Answer)\s*\]/gi, '').trim().slice(0, 80);
      }

      // 5. Siblings of the select's parent element
      if (!rowLabel && sel.parentElement) {
        const parent = sel.parentElement;
        for (const sib of [...parent.parentElement?.children || []]) {
          if (sib === parent || sib.contains(sel)) continue;
          if (sib.querySelector('select')) continue; // skip other select containers
          const t = extractLabel(sib);
          if (t) { rowLabel = t; break; }
        }
      }

      // console.log('[Answerly] Dropdown row label:', JSON.stringify(rowLabel), '| options:', rowOptions);
      dropdownRows.push({ rowLabel, selectEl: sel, options: rowOptions });
      rowOptions.forEach(o => { if (!seen.has(o)) { seen.add(o); options.push(o); } });
    });

    const textInputEls = [];
    qEl.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach(el => {
      if (el.offsetWidth || el.offsetHeight) textInputEls.push(el);
    });

    return { questionText, options, dropdownRows, textInputEls };
  }

  // ── Auto-select a <select> dropdown ───────────────────────────────────────
  function autoSelectDropdown(selectEl, answer) {
    const target = answer.trim().toLowerCase();

    function doSelect(i) {
      selectEl.selectedIndex = i;
      ['change', 'input'].forEach(t => selectEl.dispatchEvent(new Event(t, { bubbles: true })));
    }

    // Pass 1: exact match (most reliable — avoids "5" matching "15")
    for (let i = 0; i < selectEl.options.length; i++) {
      const optText = selectEl.options[i].text.trim().toLowerCase();
      if (!optText || optText.startsWith('[')) continue;
      if (optText === target) { doSelect(i); return true; }
    }
    // Pass 2: option text contains the target (e.g. target="paris" matches "Paris, France")
    for (let i = 0; i < selectEl.options.length; i++) {
      const optText = selectEl.options[i].text.trim().toLowerCase();
      if (!optText || optText.startsWith('[')) continue;
      if (optText.includes(target)) { doSelect(i); return true; }
    }
    // Pass 3: target contains the option text — only for substantial strings (≥6 chars)
    // Prevents short numbers like "5" matching inside "15", "45", etc.
    for (let i = 0; i < selectEl.options.length; i++) {
      const optText = selectEl.options[i].text.trim().toLowerCase();
      if (!optText || optText.startsWith('[')) continue;
      if (optText.length >= 6 && target.includes(optText)) { doSelect(i); return true; }
    }
    return false;
  }

  // ── Auto-fill a text/number input or textarea ─────────────────────────────
  function setInputValue(el, value) {
    el.focus();
    el.value = value;
    ['input', 'change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    el.blur();
  }

  // Break one prose answer into N values when the backend didn't send parts.
  // Handles "a. 10.0 g; b. 224 L" and newline/semicolon lists; strips letter
  // or number prefixes and any trailing "(working)". Returns null if the
  // count doesn't match, so the caller can fall back safely.
  function splitForBlanks(answer, n) {
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

  // Fills text inputs. With one box the whole answer goes in it. With several,
  // one value per box in order — from `parts` when the backend supplied them,
  // else split heuristically. If nothing maps cleanly, fall back to the old
  // first-box behaviour rather than leaving everything empty.
  function autoFillTextInput(inputEls, answer, parts) {
    const els = Array.from(inputEls || []).filter(el => el && !el.disabled);
    if (!els.length) return false;

    if (els.length === 1) { setInputValue(els[0], answer); return true; }

    const values = (Array.isArray(parts) && parts.length === els.length) ? parts
                 : splitForBlanks(answer, els.length);
    if (!values) { setInputValue(els[0], answer); return true; }

    els.forEach((el, i) => setInputValue(el, values[i]));
    return true;
  }

  // ── Stealth region-selector overlay ───────────────────────────────────────
  // Shows a fullscreen overlay with the screenshot, lets user drag a region,
  // calls onSelect({x,y,w,h}) or onCancel().
  function showStealthSelectionOverlay(fullDataUrl, onSelect, onCancel) {
    // Remove any existing overlay first
    document.getElementById('answerly-stealth-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'answerly-stealth-overlay';

    const canvas = document.createElement('canvas');
    // Device-resolution backing store so the captured screenshot (returned at
    // devicePixelRatio) renders 1:1 rather than downscaled into a CSS-pixel
    // canvas — the downscale is what made the preview blurry on high-DPI screens.
    // CSS size stays in CSS px and the context is scaled, so selection/crop math
    // below is unchanged.
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    overlay.appendChild(canvas);

    const hint = document.createElement('div');
    hint.id = 'answerly-stealth-hint';
    hint.textContent = 'Drag to select area  •  Esc to cancel';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);   // draw in CSS-pixel coordinates at device resolution
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
      ctx.fillStyle = 'rgba(0,0,0,0.50)';
      ctx.fillRect(0, 0, W, H);

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

  // ── Crop helper for stealth camera ────────────────────────────────────────
  function cropStealthImage(dataUrl, x, y, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scaleX = img.naturalWidth  / window.innerWidth;
        const scaleY = img.naturalHeight / window.innerHeight;
        const sx = x * scaleX, sy = y * scaleY;
        const sw = w * scaleX, sh = h * scaleY;
        const out = document.createElement('canvas');
        out.width  = Math.round(sw);
        out.height = Math.round(sh);
        out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
        resolve(out.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  // ── Normalize answer text for matching ────────────────────────────────────
  // Strips letter prefixes like "a.", "b)", "d." so "d. a U.S. senator"
  // matches the same as "a U.S. senator"
  function normalizeText(s) {
    return s.trim().toLowerCase()
      .replace(/^[a-z]\.\s+/i, '')  // strip "a. "
      .replace(/^[a-z]\)\s+/i, '')  // strip "a) "
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Screen-reader status text on answer choices ─────────────────────────────
  // Canvas appends "Not Selected" / "Selected" to each choice for assistive
  // tech. It is visually hidden, but innerText reads it as part of the label,
  // so options reached the model as "d. protein. , Not Selected" and the
  // returned answer carried the junk with it. Only a LEADING or TRAILING status
  // token is removed, and a trailing one must follow punctuation or a newline —
  // "the candidate was selected" is real text and is left alone.
  const A11Y_LEAD_RE  = /^(?:not\s+selected|selected)[\s,;:\-–—]+/i;
  const A11Y_TRAIL_RE = /(^|\n|[.,;:)\]!?])[\s,;:\-–—]*(?:not\s+selected|selected)\s*$/i;
  function stripA11yStatus(text) {
    let t = String(text || '').trim();
    if (!t) return t;
    t = t.replace(A11Y_LEAD_RE, '').trim();
    t = t.replace(A11Y_TRAIL_RE, '$1').replace(/[\s,;:\-–—]+$/, '').trim();
    // A label that was ONLY the status token is not an option at all.
    if (/^(?:not\s+selected|selected)$/i.test(t)) return '';
    return t;
  }

  // ── Get the visible label text for any input element ─────────────────────
  // Works regardless of which wrapper class Canvas uses (.answer, .answer-option, etc.)
  // Every branch reads through textWithMath, so an option rendered as an
  // equation image yields its LaTeX instead of an empty string. Extraction and
  // auto-select both call this one function, so they cannot disagree about what
  // an option "says".
  function getOptionLabelText(input, scope) {
    return stripA11yStatus(rawOptionLabelText(input, scope));
  }
  function rawOptionLabelText(input, scope) {
    scope = scope || document;
    // 1. Explicit <label for="id">
    if (input.id) {
      const lbl = scope.querySelector(`label[for="${input.id}"]`) ||
                  document.querySelector(`label[for="${input.id}"]`);
      if (lbl) return textWithMath(lbl);
    }
    // 2. Input wrapped inside a <label>
    const wrappedLabel = input.closest('label');
    if (wrappedLabel) return textWithMath(wrappedLabel);
    // 3. Named answer element in parent container
    const container = input.closest('.answer, .answer-option, .answer_choice, [data-answer], li, tr');
    if (container) {
      const lbl = container.querySelector('.answer_label, .answer_text, label, span.answer-label');
      if (lbl) return textWithMath(lbl);
      // Fallback: full text of the container minus the input's own text
      return textWithMath(container).replace(input.value || '', '').trim();
    }
    // 4. Next sibling element
    const sib = input.nextElementSibling;
    if (sib) return textWithMath(sib);
    // 5. Last resort — the nearest ancestor that carries its own text. A quiz
    // whose choices sit in an unrecognised wrapper reached here with all four
    // strategies empty, so extractData sent ZERO options; the backend then read
    // a multiple-choice question as free text and returned an answer that could
    // never match a radio. Stop at any ancestor holding more than one input, so
    // this can only ever pick up ONE option's label, never the whole list.
    let node = input.parentElement;
    for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
      if (node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length > 1) break;
      const t = textWithMath(node).replace(input.value || '', '').trim();
      if (t && t.length <= 300) return t;
    }
    return '';
  }

  // ── Auto-select: click the matching radio/checkbox in Canvas ───────────────
  // Anchored on input elements — works regardless of Canvas wrapper class names.
  // `parts` (optional) is the backend's answerParts array — the exact option
  // strings it chose. Preferring it avoids splitting a joined answer on commas,
  // which mangled any answer that legitimately contains a comma and made
  // matching fail (silently, in stealth mode).
  // Finds the index of the single option whose label best matches ONE answer
  // string. Used per-selected-part by the checkbox path. Order mirrors the radio
  // passes: exact → length-guarded includes (both directions) → letter/number
  // indicator ("B", "Option B", "B)", "2", "(3)"). Returns -1 if nothing is a
  // confident match, so a vague part never sweeps in the wrong box.
  function matchOptionIndex(inputs, ansStr, qEl) {
    const a = String(ansStr || '').trim();
    if (!a) return -1;
    const aNorm  = normalizeText(a);
    const labels = inputs.map(inp => normalizeText(getOptionLabelText(inp, qEl)));
    for (let i = 0; i < labels.length; i++) if (labels[i] && labels[i] === aNorm) return i;
    for (let i = 0; i < labels.length; i++) {
      const L = labels[i]; if (!L) continue;
      if ((aNorm.length >= 2 && L.includes(aNorm)) || (L.length >= 2 && aNorm.includes(L))) return i;
    }
    const ref = a.toLowerCase()
      .replace(/^(the\s+)?(correct\s+)?(answer|choice|option)\s*(is|:)?\s*/i, '')
      .replace(/[.)\]:]+$/, '').trim();
    const lm = ref.match(/^\(?([a-e])\)?$/i);
    if (lm) { const i = lm[1].toLowerCase().charCodeAt(0) - 97; if (inputs[i]) return i; }
    const nm = ref.match(/^\(?([1-9])\)?$/);
    if (nm) { const i = parseInt(nm[1], 10) - 1; if (inputs[i]) return i; }
    return -1;
  }

  function autoSelectAnswer(qEl, answer, parts) {
    const answerNorm  = normalizeText(answer);
    const answerLower = answer.trim().toLowerCase();
    const usable      = Array.isArray(parts) && parts.length > 0 && parts.every(p => typeof p === 'string' && p.trim());
    const rawList     = usable ? parts.map(p => p.trim()) : answer.split(',').map(a => a.trim());
    const targets    = rawList.map(a => normalizeText(a)).filter(Boolean);
    const rawTargets = rawList.map(a => a.toLowerCase()).filter(Boolean);

    // ── Checkbox / select-all-that-apply ─────────────────────────────────────
    const checkboxes = Array.from(qEl.querySelectorAll('input[type="checkbox"]'));
    if (checkboxes.length > 0) {
      // The option strings the AI chose. Prefer answerParts; otherwise split the
      // answer on newlines / semicolons and on commas that are NOT inside
      // parentheses (so "Include Explicit, Measurable Outcomes" stays whole
      // enough — and even if a label's own comma splits it, both halves match
      // back to the same box).
      const partList = (usable ? parts.map(p => p.trim())
                               : answer.split(/[\n;]+|,(?![^)]*\))/).map(s => s.trim()))
                       .filter(Boolean);

      // Match EACH chosen string to ONE checkbox. Per-part matching is what fixes
      // the old bugs: it can legitimately select ALL boxes when the answer is
      // "all of the above" (the old code aborted in that case and picked nothing),
      // it survives paraphrased/short labels, and one vague part can only ever
      // pull in one box, never sweep the whole list.
      const chosen = new Set();
      for (const part of partList) {
        const i = matchOptionIndex(checkboxes, part, qEl);
        if (i >= 0) chosen.add(i);
      }

      if (chosen.size > 0) {
        let any = false;
        checkboxes.forEach((cb, i) => { if (chosen.has(i) && !cb.checked) { cb.click(); any = true; } });
        // Success if we ticked something, or the intended boxes were already ticked.
        if (any || [...chosen].every(i => checkboxes[i] && checkboxes[i].checked)) return true;
      }
      return false;
    }

    // ── Single answer — radio ─────────────────────────────────────────────────
    const radios  = Array.from(qEl.querySelectorAll('input[type="radio"]'));
    const target    = targets[0]    || answerNorm;
    const targetRaw = rawTargets[0] || answerLower;

    // Pass 0 — INDICATOR-ONLY, and it MUST run first. When the AI answers with
    // just an option reference — "B", "Option B", "B)", "The answer is C", "2",
    // "(3)" — the letter/number is authoritative. Running the fuzzy text passes
    // first was an active bug: a bare "B" fuzzy-matched "Ribosome" (which merely
    // contains the letter b) and picked the wrong option. This resolves the
    // indicator directly, but ONLY when the answer is essentially nothing but the
    // indicator, so a real prose answer can never be hijacked.
    {
      const ref = answerLower
        .replace(/^(the\s+)?(correct\s+)?(answer|choice|option)\s*(is|:)?\s*/i, '')
        .replace(/[.)\]:]+$/, '')
        .trim();
      // A bare "3" is ambiguous: it can POINT AT the third option, or it can BE
      // the answer — "what is the length of the path A→B→C→D" answers 3, and a
      // question about graph nodes answers D. The backend maps the model's
      // letter to the option's TEXT before sending, so by the time it arrives a
      // token that reads exactly like one of the options is the answer itself.
      // Treating it as a position is what made the answer 3 tick the option 2
      // on a four-choice question listed 5 / 4 / 2 / 3.
      const refNorm = normalizeText(ref);
      const isOwnOptionText = !!refNorm && radios.some(input =>
        normalizeText(getOptionLabelText(input, qEl)) === refNorm);
      let idx = -1;
      if (!isOwnOptionText) {
        const lm = ref.match(/^\(?([a-e])\)?$/i);
        if (lm) idx = lm[1].toLowerCase().charCodeAt(0) - 97;
        if (idx < 0) { const nm = ref.match(/^\(?([1-9])\)?$/); if (nm) idx = parseInt(nm[1], 10) - 1; }
      }
      if (idx >= 0 && radios[idx]) { radios[idx].click(); return true; }
    }

    // Pass 1: exact normalized match
    for (const input of radios) {
      const lbl = getOptionLabelText(input, qEl);
      if (normalizeText(lbl) === target) { input.click(); return true; }
    }
    // Pass 2: includes match (normalized). Guarded to targets of 2+ chars — a
    // 1-char target ("b") "includes"-matches any label containing that letter.
    for (const input of radios) {
      const lblNorm = normalizeText(getOptionLabelText(input, qEl));
      if (!lblNorm) continue;
      if ((target.length >= 2 && lblNorm.includes(target)) ||
          (lblNorm.length >= 2 && target.includes(lblNorm))) { input.click(); return true; }
    }
    // Pass 3: raw includes match (same 2-char guard)
    for (const input of radios) {
      const lblLow = getOptionLabelText(input, qEl).toLowerCase();
      if (!lblLow) continue;
      if ((targetRaw.length >= 2 && lblLow.includes(targetRaw)) ||
          (lblLow.length >= 2 && targetRaw.includes(lblLow))) { input.click(); return true; }
    }
    // Pass 4: first 25 chars
    for (const input of radios) {
      const lblNorm = normalizeText(getOptionLabelText(input, qEl));
      if (lblNorm.length < 2) continue;
      if (lblNorm.startsWith(target.slice(0, 25)) || target.startsWith(lblNorm.slice(0, 25))) {
        input.click(); return true;
      }
    }

    // Pass 5: bare-letter fallback (kept for the plain "b" case after text passes)
    if (/^[a-e]$/.test(target)) {
      const idx = target.charCodeAt(0) - 97; // 'a'→0, 'b'→1 …
      if (radios[idx]) { radios[idx].click(); return true; }
    }

    // Pass 6: fallback — single select dropdown
    const selects = qEl.querySelectorAll('select');
    if (selects.length === 1) return autoSelectDropdown(selects[0], answer);

    return false;
  }

  // ── Inject buttons ─────────────────────────────────────────────────────────
  function injectButtons() {
    const questions = findQuestions();

    questions.forEach(qEl => {
      // Must exclude the camera button: it also carries `answerly-btn` (for its
      // size/invisibility CSS), so a bare `.answerly-btn` test made the "?" button
      // impossible to inject whenever screenshot stealth had run first.
      if (qEl.querySelector('.answerly-btn:not(.answerly-cam-btn)')) return;

      const { questionText, options, dropdownRows, textInputEls } = extractData(qEl);
      if (!questionText) return;

      // Computed once, here, so every branch below (dropdown / stealth / normal)
      // decides identically — and identically to Solve All. The image test used
      // to live inside the dropdown branch alone, which is why the multiple
      // choice paths silently used a weaker check of their own and would answer
      // "based on the figure above" questions that Solve All declined.
      const needsScreenshot = needsScreenshotFor(qEl, questionText);

      // Free text = no answer options AND no radio/checkbox inputs found in the question
      const hasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
      const isFillInBlank = textInputEls.length > 0 && options.length === 0 && !hasChoices;
      const isFreeText = options.length === 0 && !hasChoices && !isFillInBlank;
      const accent = theme.accentColor || DEFAULT_THEME.accentColor;
      const effectiveAutoSelect = stealthHidden; // quiz stealth: ? button invisible + auto-select
      const showCamBtn          = screenshotStealthActive; // screenshot stealth: camera button

      const header =
        qEl.querySelector('.question_name') ||
        qEl.querySelector('.question-header') ||
        qEl.querySelector('.header') ||
        qEl.firstElementChild;
      if (!header) return;

      // ── Trigger button ────────────────────────────────────────────────────
      const btn = document.createElement('button');
      btn.type      = 'button';
      btn.className = `answerly-btn ${INJECTED}`;
      btn.title     = 'Answerly AI — hint & answer';
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

      // Apply accent color + auto-select invisible mode
      btn.style.setProperty('background', accent, 'important');
      btn.style.setProperty('box-shadow', `0 2px 8px ${accent}88`, 'important');
      if (effectiveAutoSelect) btn.classList.add('answerly-invisible');
      // Stamp the mode this button was BUILT for. Its click behaviour is frozen
      // in a closure at this moment, so a button created while stealth was off
      // keeps normal-mode behaviour forever — even after stealth is switched on.
      // That is the "I can see the button but clicking does nothing" case: a
      // normal-mode button sitting on a page the user is driving as stealth.
      // The reconciler below compares this stamp against the live mode and
      // rebuilds when they diverge.
      btn.dataset.mode = effectiveAutoSelect ? 'stealth' : 'normal';

      header.appendChild(btn);

      // ── Quiz stealth hover tooltip ──────────────────────────────────────────
      // When quiz stealth is on, invisible ? shows "🤫 Auto-Select" on hover
      if (effectiveAutoSelect) {
        btn.addEventListener('mouseenter', () => {
          document.getElementById('answerly-stealth-tip')?.remove();
          const tip = document.createElement('div');
          tip.id          = 'answerly-stealth-tip';
          tip.className   = 'answerly-cam-tooltip';
          tip.textContent = '🤫 Auto-Select';
          document.body.appendChild(tip);
          const r = btn.getBoundingClientRect();
          tip.style.left = r.left + 'px';
          tip.style.top  = (r.top - 26) + 'px';
        });
        btn.addEventListener('mouseleave', () => {
          document.getElementById('answerly-stealth-tip')?.remove();
        });
      }

      if (dropdownRows.length > 0) {
        // ── DROPDOWN QUESTION: solve all dropdowns, show answers in card ──────
        // The card is only ever the SOLVING card now. The screenshot-needed
        // variant it used to carry has moved to the toast, so every path
        // delivers that message the same way, in the same place.
        const card = document.createElement('div');
        card.className     = `answerly-card ${INJECTED}`;
        card.style.display = 'none';
        card.style.setProperty('background',   theme.cardBg,     'important');
        card.style.setProperty('border-color', theme.cardBorder, 'important');
        card.style.setProperty('opacity',      theme.opacity / 100, 'important');
        card.innerHTML =
          `<div class="answerly-badge" style="color:${accent}!important">
               <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
               Answerly AI
             </div>
             <div class="answerly-hint-area">
               <div class="answerly-loading"><div class="answerly-spinner"></div>Solving…</div>
             </div>`;

        const answersEl = qEl.querySelector('.answers') || qEl.querySelector('.answer_group') || qEl.querySelector('table');
        (answersEl || qEl).insertAdjacentElement('afterend', card);

        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (needsScreenshot) {
            recordSkippedImages(1);
            showScreenshotToast(1, { single: true });
            btn.dataset.opened = 'true';
            return;
          }
          if (shouldIgnoreClick(btn, qEl)) return;
          lockBtn(btn);
          btn.dataset.opened = 'true';
          markInflight(qEl);   // stops Solve All duplicating this in-flight request
          if (!effectiveAutoSelect) card.style.display = 'block';

          // Reset area to "Solving…" on every attempt (handles retries cleanly)
          const area = card.querySelector('.answerly-hint-area');
          if (area) area.innerHTML = '<div class="answerly-loading"><div class="answerly-spinner"></div>Solving…</div>';

          const baseQ = questionText.length > 800
            ? questionText.slice(0, 800).trim() + '...'
            : questionText.trim();
          const results = [];

          // Detect matching question: 2+ dropdowns all sharing the same options pool
          const isMatching = dropdownRows.length >= 2 &&
            dropdownRows.every(r =>
              JSON.stringify([...r.options].sort()) === JSON.stringify([...dropdownRows[0].options].sort())
            );

          if (isMatching) {
            // ── Send ALL rows in ONE call so AI can distribute answers correctly ──
            const rows = dropdownRows.map(r => ({
              label: r.rowLabel.replace(/→\s*$/, '').trim(),
              options: r.options,
              selectEl: r.selectEl,
            }));
            let matchingFailed = false;
            await new Promise(resolve => {
              sendSolve(
                { type: 'SOLVE_MATCHING', question: baseQ, rows: rows.map(r => ({ label: r.label, options: r.options })) },
                (resp) => {
                  if (!chrome.runtime.lastError && resp && resp.answers) {
                    // Backend returns numbered keys: {"1": "answer text", "2": "answer text", ...}
                    rows.forEach((r, i) => {
                      const answer = resp.answers[String(i + 1)];
                      if (answer) { autoSelectDropdown(r.selectEl, answer); results.push({ label: r.label, answer }); }
                      else results.push({ label: r.label, answer: '—' });
                    });
                  } else {
                    matchingFailed = true;
                  }
                  resolve();
                }
              );
            });
            if (matchingFailed) {
              btn.dataset.done = '';
              clearInflight(qEl);
              if (area && !effectiveAutoSelect) area.innerHTML = '<div class="answerly-error">Failed to solve — click to retry.</div>';
              return;
            }
            markSolved(qEl); clearInflight(qEl); unlockBtnSoon(btn);
          } else {
            // ── Non-matching: solve each dropdown separately ──────────────────
            let anySuccess = false;
            for (const { rowLabel, selectEl, options: rowOpts } of dropdownRows) {
              const cleanLabel = rowLabel.replace(/→\s*$/, '').trim();
              const q = cleanLabel ? `${baseQ}\n\nFor: "${cleanLabel}"` : baseQ;
              await new Promise(resolve => {
                sendSolve(
                  { type: 'SOLVE_QUESTION', question: q, options: rowOpts },
                  (resp) => {
                    if (!chrome.runtime.lastError && resp && !resp.error) {
                      autoSelectDropdown(selectEl, resp.answer);
                      results.push({ label: cleanLabel, answer: resp.answer });
                      anySuccess = true;
                    } else {
                      results.push({ label: cleanLabel, answer: '—' });
                    }
                    resolve();
                  }
                );
              });
              await new Promise(resolve => setTimeout(resolve, 400));
            }
            if (anySuccess) { markSolved(qEl); unlockBtnSoon(btn); }
            clearInflight(qEl);
            if (!anySuccess) {
              btn.dataset.done = '';
              if (area && !effectiveAutoSelect) area.innerHTML = '<div class="answerly-error">Failed to solve — click to retry.</div>';
              return;
            }
          }

          if (effectiveAutoSelect) { card.style.display = 'none'; return; }
          area.innerHTML = results.map((r, i) =>
            `<div style="padding:5px 0;border-bottom:1px solid #2a2a4a;font-size:12px;">
              <span style="color:#fff!important;font-weight:600;">${i + 1}. ${r.label ? esc(r.label) + ' →' : ''}</span>
              <span style="color:${theme.answerColor}!important;font-weight:700;"> ${esc(r.answer)}</span>
            </div>`
          ).join('');
        });

      } else if (effectiveAutoSelect) {
        // ── AUTO-SELECT MODE: invisible button, click silently selects answer ─

        // Image questions used to insert a card into the page here and reveal it
        // on click — a bright panel appearing mid-exam, which is precisely what
        // stealth exists to avoid. The dim toast says the same thing without
        // planting anything in the quiz body.
        //
        // Uses needsScreenshot (image OR a "see the figure above" phrase), the
        // same test as Solve All, so the two can't disagree about this question.
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (needsScreenshot) {
            recordSkippedImages(1);
            showScreenshotToast(1, { single: true });
            btn.dataset.opened = 'true';
            return;
          }
          if (shouldIgnoreClick(btn, qEl)) return;
          lockBtn(btn);
          const liveTextInputs = Array.from(
            qEl.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
          ).filter(el => el.type !== 'hidden' && !el.disabled);
          const liveHasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
          if (liveTextInputs.length > 0 && !liveHasChoices) {
            markInflight(qEl);
            sendSolve(
              { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false, blankCount: liveTextInputs.length },
              (resp) => {
                clearInflight(qEl);
                if (!chrome.runtime.lastError && resp && !resp.error) {
                  let filled = autoFillTextInput(liveTextInputs, resp.answer, resp.answerParts);
                  reportOutcome(resp, filled, filled ? undefined : 'fill-in-blank: no input filled');
                  // Also write into TinyMCE / rich-text iframes directly
                  for (const fr of qEl.querySelectorAll('iframe')) {
                    try {
                      const doc = fr.contentDocument || fr.contentWindow?.document;
                      if (doc?.body?.isContentEditable) {
                        doc.body.focus();
                        doc.body.innerText = resp.answer;
                        ['input', 'change'].forEach(t =>
                          doc.body.dispatchEvent(new Event(t, { bubbles: true }))
                        );
                        filled = true; break;
                      }
                    } catch { /* cross-origin iframe — skip */ }
                  }
                  if (filled) { btn.dataset.opened = 'true'; markSolved(qEl); unlockBtnSoon(btn); }
                  else btn.dataset.done = '';
                } else {
                  btn.dataset.done = '';
                }
              }
            );
            return;
          }
          if (isFreeText) { btn.dataset.done = ''; return; }
          const isMultiSelect = !!qEl.querySelector('input[type="checkbox"]');
          markInflight(qEl);
          sendSolve(
            { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect },
            (resp) => {
              clearInflight(qEl);
              if (!chrome.runtime.lastError && resp && !resp.error) {
                const matched = autoSelectAnswer(qEl, resp.answer, resp.answerParts);
                reportOutcome(resp, matched, matched ? undefined : selectFailDetail(qEl, options, resp));
                if (matched) {
                  btn.dataset.opened = 'true'; // only mark done after confirmed match
                  markSolved(qEl);
                  unlockBtnSoon(btn);          // a later deliberate click must work
                } else {
                  // Answer came back but didn't match any option — allow retry
                  btn.dataset.done = '';
                }
              } else {
                // Network/server error — allow retry
                btn.dataset.done = '';
                reportSolveOutcome('stealth', resp, chrome.runtime.lastError?.message);
              }
            }
          );
        });

      } else {
        // ── NORMAL MODE: card with hint + answer ───────────────────────────
        const card = document.createElement('div');
        card.className    = `answerly-card ${INJECTED}`;
        card.style.display = 'none';
        card.style.setProperty('background', theme.cardBg, 'important');
        card.style.setProperty('border-color', theme.cardBorder, 'important');
        card.style.setProperty('opacity', theme.opacity / 100, 'important');
        card.innerHTML = `
          <div class="answerly-badge" style="color:${accent}!important">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Answerly AI
          </div>
          <div class="answerly-hint-area">
            <div class="answerly-loading"><div class="answerly-spinner"></div>Thinking…</div>
          </div>`;

        const answers = qEl.querySelector('.answers') || qEl.querySelector('.answer_group');
        (answers || qEl).insertAdjacentElement('afterend', card);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Image question: the toast carries the message now, and the card is
          // never opened — so no empty "Thinking…" panel is left sitting on the
          // page under a question that is never going to be solved.
          if (needsScreenshot) {
            recordSkippedImages(1);
            showScreenshotToast(1, { single: true });
            btn.dataset.opened = 'true';
            return;
          }
          const isOpen = card.style.display !== 'none';
          card.style.display = isOpen ? 'none' : 'block';
          if (!isOpen && !card.dataset.loaded) {
            card.dataset.loaded = 'true';
            const liveTextInputs = Array.from(
              qEl.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
            ).filter(el => el.type !== 'hidden' && !el.disabled);
            const liveHasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
            if (liveTextInputs.length > 0 && !liveHasChoices) {
              sendSolve(
                { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false, blankCount: liveTextInputs.length },
                (resp) => {
                  if (chrome.runtime.lastError || !resp) return renderError(card, 'Extension error — try reloading.');
                  if (resp.error) return renderError(card, resp.error, resp.limitReached);
                  renderResult(card, resp.hint, resp.answer, resp.answerParts, []);
                  autoFillTextInput(liveTextInputs, resp.answer, resp.answerParts);
                  // Also write into TinyMCE / rich-text iframes directly
                  for (const fr of qEl.querySelectorAll('iframe')) {
                    try {
                      const doc = fr.contentDocument || fr.contentWindow?.document;
                      if (doc?.body?.isContentEditable) {
                        doc.body.focus();
                        doc.body.innerText = resp.answer;
                        ['input', 'change'].forEach(t =>
                          doc.body.dispatchEvent(new Event(t, { bubbles: true }))
                        );
                        break;
                      }
                    } catch { /* cross-origin iframe — skip */ }
                  }
                }
              );
            } else {
              const isMultiSelect = !!qEl.querySelector('input[type="checkbox"]');
              fetchAnswer(card, questionText, options, isMultiSelect);
            }
          }
          if (!isOpen) {
            card.dataset.loaded = 'true';
            btn.dataset.opened  = 'true';
          }
        });
      }

      // ── Camera Button — active whenever screenshot stealth is on ─────────────
      // Quiz stealth on  → button is invisible (hover shows "📸 Screenshot" tip)
      // Quiz stealth off → button is visible (sits left of the ? button)
      // Both work side-by-side; the ? button keeps its normal quiz-solver role.
      // Guard against a second capture trigger: injectButtons() can now run on a
      // question that already has a camera-only button, and two stacked invisible
      // 26px triggers would fire the region-selector overlay on a blind click.
      if (showCamBtn && !qEl.querySelector('.answerly-cam-btn')) {
        const camBtn = document.createElement('button');
        camBtn.type      = 'button';
        // Always invisible — stealth camera button never shows visually
        camBtn.className = `answerly-btn answerly-invisible answerly-cam-btn ${INJECTED}`;
        camBtn.title     = '';
        camBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
        header.insertBefore(camBtn, btn);

        camBtn.addEventListener('mouseenter', () => {
          document.getElementById('answerly-stealth-tip')?.remove();
          const tip = document.createElement('div');
          tip.id          = 'answerly-stealth-tip';
          tip.className   = 'answerly-cam-tooltip';
          tip.textContent = '📸 Screenshot';
          document.body.appendChild(tip);
          const r = camBtn.getBoundingClientRect();
          tip.style.left = r.left + 'px';
          tip.style.top  = (r.top - 26) + 'px';
        });
        camBtn.addEventListener('mouseleave', () => {
          document.getElementById('answerly-stealth-tip')?.remove();
        });

        camBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (shouldIgnoreCamClick(camBtn)) return;
          camBtn.dataset.busy = 'true';
          doCameraCapture(camBtn, qEl, questionText);
        });
      }
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  function fetchAnswer(card, questionText, options, isMultiSelect) {
    card.dataset.loaded = 'true';
    sendSolve(
      { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect: !!isMultiSelect },
      (resp) => {
        if (chrome.runtime.lastError || !resp) {
          return renderError(card, 'Extension error — try reloading.');
        }
        if (resp.error) return renderError(card, resp.error, resp.limitReached);
        renderResult(card, resp.hint, resp.answer, resp.answerParts, options);
      }
    );
  }

  function renderResult(card, hint, answer, answerParts, options) {
    const accent = theme.accentColor || DEFAULT_THEME.accentColor;
    const area = card.querySelector('.answerly-hint-area');
    area.innerHTML = `
      <div class="answerly-hint-row" style="color:${theme.hintColor}!important">
        <span class="answerly-hint-lbl" style="color:#fff!important">Hint: </span>${esc(hint)}
      </div>
      <button type="button" class="answerly-reveal" data-open="false">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        Show Answer
      </button>`;

    area.querySelector('.answerly-reveal').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const open = this.dataset.open === 'true';
      const existing = area.querySelector('.answerly-answer-row');
      if (open) {
        existing?.remove();
        this.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg> Show Answer`;
        this.dataset.open = 'false';
      } else {
        const row = document.createElement('div');
        row.className = 'answerly-answer-row';
        row.style.setProperty('border-color', theme.cardBorder, 'important');

        // Build the parts array — prefer server's clean answerParts array,
        // then fall back to matching the answer string against the known options list
        // (avoids any comma-splitting that would break options containing commas).
        let parts;
        if (Array.isArray(answerParts) && answerParts.length > 0) {
          parts = answerParts;
        } else if (Array.isArray(options) && options.length > 0) {
          const ansLow = answer.toLowerCase();
          parts = options.filter(opt => ansLow.includes(opt.trim().toLowerCase()));
          if (parts.length === 0) parts = [answer];
        } else {
          parts = [answer];
        }

        let answerBodyHtml;
        if (parts.length > 1) {
          // Multiple answers: each on its own bolded line with a divider
          answerBodyHtml = parts.map((p, i) => `
            <div style="
              display:flex; align-items:flex-start; gap:8px;
              padding:6px 0;
              ${i < parts.length - 1 ? 'border-bottom:1px solid #2a2a4a;' : ''}
            ">
              <span style="color:${accent};font-weight:900;flex-shrink:0;margin-top:1px;">✓</span>
              <span style="color:${theme.answerColor};font-weight:800;font-size:14px;line-height:1.4;">${esc(p)}</span>
            </div>`).join('');
        } else {
          // Single answer: bold, large
          answerBodyHtml = `<div class="answerly-answer-text" style="color:${theme.answerColor}!important;font-weight:800!important;">${esc(parts[0] || answer)}</div>`;
        }

        row.innerHTML = `<span class="answerly-answer-lbl" style="color:${accent}!important">Answer</span>${answerBodyHtml}`;
        this.insertAdjacentElement('afterend', row);
        this.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(90deg)"><polyline points="9 18 15 12 9 6"/></svg> Hide Answer`;
        this.dataset.open = 'true';
      }
    });
  }

  function renderError(card, msg, limitReached) {
    const limitHtml = limitReached
      ? `<div class="answerly-error" style="margin-top:6px!important;">Daily limit reached — resets at midnight UTC.</div>`
      : '';
    card.querySelector('.answerly-hint-area').innerHTML =
      `<div class="answerly-error">${esc(msg)}</div>${limitHtml}`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ── Solve All — entry point, queueing + re-entrancy ─────────────────────────
  // Previously SOLVE_ALL was silently DROPPED if it arrived before the async
  // bootstrap set solverActive — the "sometimes it works, sometimes it doesn't".
  // Now an early message is queued and drained once state is known.
  let solveAllRunning = false;

  function handleSolveAll() {
    if (!stateReady) {          // race with bootstrap — queue, never drop
      pendingSolveAll = Date.now();
      syncState();
      return;
    }
    if (!solverActive) return;  // genuinely off — do nothing
    runSolveAll();
  }

  function drainPendingSolveAll() {
    if (!pendingSolveAll) return;
    const age = Date.now() - pendingSolveAll;
    pendingSolveAll = 0;        // clear BEFORE running so it can never double-fire
    if (age > 15000) return;    // stale — the user has navigated on
    if (solverActive) runSolveAll();
  }

  function runSolveAll() {
    if (solveAllRunning) return; // repeated clicks never stack passes (= never double-bill)
    solveAllRunning = true;
    injectStyles();
    injectButtons();
    // solveAllDirect staggers requests ~1200ms apart; a flat 8s retry used to
    // fire BEFORE the first pass finished dispatching on quizzes with 7+
    // questions, double-billing every one of them. Scale the retry to the pass.
    const { delay: firstPassDuration, skippedImages } = solveAllDirect();
    // Only the first pass reports skips. The retry re-walks the same questions
    // and would skip them again, popping a second toast ~8s later.
    if (skippedImages > 0) {
      recordSkippedImages(skippedImages);   // popup keeps it after the toast goes
      showScreenshotToast(skippedImages);   // dim in stealth, full in normal
    }
    const retryIn = Math.max((firstPassDuration || 0) + 6000, 8000);
    setTimeout(solveAllDirect, retryIn);
    setTimeout(() => { solveAllRunning = false; }, retryIn + 5000);
  }

  // ── Image-dependent question detection ──────────────────────────────────────
  // A question whose answer lives in a picture cannot be solved from its text.
  // Sending it anyway doesn't fail loudly — the model just picks one of the
  // options at random, which looks like a normal answer and is right ~25% of the
  // time. That silent guessing is what produced a 50% midterm.
  //
  // Both the "?" button and Solve All must agree on what counts as
  // image-dependent, so the test lives here once. It previously existed only
  // inside injectButtons(), which is why Solve All guessed on questions the
  // "?" button refused.
  const NEEDS_SCREENSHOT_RE = /refer to|see (the |figure|diagram|image|graph|chart|table|packet|trace|capture|exhibit)|based on (the |figure|diagram|image|above)|shown (in|below|above)|in the (figure|diagram|image|graph|chart|table|packet|capture)/i;

  function questionHasImage(qEl) {
    // Only inside the question text — ignore decorative icons in headers/labels.
    const qTextEl = qEl.querySelector('.question_text, [data-question-text], .question-text, .formattedHtml');
    if (!qTextEl) return false;
    // An EQUATION image does not count. Its content is recoverable as LaTeX by
    // extractData, so the model can read it perfectly well — treating it as an
    // unreadable picture would skip every maths question on the quiz and hand
    // the student a blank paper instead of an answer.
    return [...qTextEl.querySelectorAll('img')].some(img => {
      const src = img.getAttribute('src');
      if (src === '') return false;
      // An equation image only counts as READABLE if its LaTeX actually came
      // back. A maths image with no title/alt/data-equation-content is just as
      // opaque as a photograph, and must route to the screenshot tool rather
      // than be dropped on the floor as "handled".
      if (isEquationImage(img)) return !equationLatex(img);
      return true;
    });
  }

  // Structural maths markup whose meaning innerText cannot carry: a fraction bar
  // and an exponent are POSITION, and flattening throws the position away.
  const LOSSY_MATH_SEL = 'math, mfrac, msup, msub, msqrt, mroot, munderover, sup, sub, .frac, .fraction';
  const MATH_SYM_RE   = /[∫∑∏√∂∇≠≤≥±→∞]/;
  // Unicode Mathematical Alphanumeric Symbols — styled letters some instructors
  // paste in place of real markup (U+1D465 is the italic x these quizzes use).
  const MATH_ALNUM_RE = /[\u{1D400}-\u{1D7FF}]/u;

  /**
   * True when this question is maths whose notation did NOT survive extraction.
   *
   * equationTexts() recovers LaTeX from Canvas equation images and from MathJax
   * annotation nodes, and when it does the model sees the real expression. But a
   * quiz written with bare MathML, or with unicode italics and <sup> tags, gives
   * it nothing to recover: innerText renders 6/(x^3+x^2-2x) as "6 x 3 + x 2 - 2 x".
   * The fraction and the exponents are simply gone.
   *
   * That is not a hard question, it is an ambiguous one, and the model answers it
   * by guessing which reading was intended — how a partial-fractions quiz came
   * back 0/2 with confident, well-formed, wrong answers. Refusing sends the
   * student to the screenshot tool, which reads the rendered equation instead.
   */
  function mathIsLossy(qEl) {
    try {
      const textEl = qEl.querySelector('.question_text, [data-question-text], .question-text') || qEl;
      // LaTeX was recovered, so the model sees the true expression. Answer it.
      if (equationTexts(textEl).length) return false;
      const txt = textEl.innerText || '';
      if (!MATH_SYM_RE.test(txt) && !MATH_ALNUM_RE.test(txt)) return false;  // not maths
      // Maths, with nothing recovered. Lossy if structure innerText drops is
      // present, or if styled unicode letters are standing in for notation.
      return !!textEl.querySelector(LOSSY_MATH_SEL) || MATH_ALNUM_RE.test(txt);
    } catch { return false; }   // never let detection break solving
  }

  function needsScreenshotFor(qEl, questionText) {
    return questionHasImage(qEl)
        || NEEDS_SCREENSHOT_RE.test(questionText || '')
        || mathIsLossy(qEl);
  }

  // ── "Use the screenshot tool" toast ─────────────────────────────────────────
  // Solve All now skips image questions instead of guessing. Skipping silently
  // would leave them blank with no explanation, so say so. Auto-dismisses after
  // 5s; the X closes it immediately.
  //
  // Deliberately NOT shown in quiz stealth mode — a banner appearing on screen
  // would defeat the entire point of stealth.
  // The toast is transient — 5 seconds, or gone the moment the X is clicked.
  // This record is what survives it, so a student who looked away, or who wants
  // to check afterwards which questions were left blank, can still find out
  // from the popup.
  function recordSkippedImages(count) {
    try {
      chrome.storage.local.set({ answerlySkippedImages: { ts: Date.now(), count } });
    } catch { /* context invalidated */ }
  }

  // Two looks, one component:
  //   normal  — full brightness, reads like any other notification
  //   stealth — dimmed and muted: no accent border, no drop shadow, lower
  //             contrast. Legible to the person using it, but it does not
  //             catch the eye of someone glancing at the screen.
  // Auto-dismisses after 5s in both; the X closes it immediately.
  function showScreenshotToast(count, opts = {}) {
    const dim = opts.dim !== undefined ? opts.dim : stealthHidden;
    document.getElementById('answerly-shot-toast')?.remove();

    const accent = theme.accentColor || DEFAULT_THEME.accentColor;
    const box = document.createElement('div');
    box.id = 'answerly-shot-toast';
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
    // `single` = the "?" button declined one specific question the student just
    // clicked; the plural wording is for a Solve All pass over the whole page.
    // Wording stays true for both reasons a question gets routed here: its answer
    // lives in a picture, or it is maths whose fractions and exponents did not
    // survive being read as text. Saying "uses an image" would be wrong for the
    // second, and a student who sees a plainly-visible equation described as an
    // image reasonably concludes the extension is broken.
    const body = opts.single
      ? 'This question needs the screenshot tool — the text alone does not capture it, so it was skipped.'
      : (count === 1
          ? '1 question needs the screenshot tool, so it was skipped.'
          : count + ' questions need the screenshot tool, so they were skipped.') +
        ' Use it on ' + (count === 1 ? 'it' : 'them') + ' — ' +
        'answering from the text alone would just be a guess.';
    msg.innerHTML =
      '<div style="font-weight:' + (dim ? '600' : '700') + ';margin-bottom:3px">' +
      '📸 Screenshot needed</div>' + body;

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

  // ── Solve All — direct API path (works in both normal + stealth mode) ────────
  // Bypasses button-click so normal-mode cards never appear and usage is never
  // burned on free-text/essay questions that can't be auto-filled.
  //
  // Returns { delay, skippedImages } — runSolveAll uses delay to scale its retry
  // and skippedImages to decide whether to surface the screenshot toast.
  function solveAllDirect() {
    let delay = 0;
    let skippedImages = 0;
    findQuestions().forEach(qEl => {
      const btn = qEl.querySelector(`.answerly-btn.${INJECTED}:not(.answerly-cam-btn)`);
      // Skip if genuinely answered, or if a request for it is still in flight.
      // Tracked per question element (not on the button's dataset) so it survives
      // a re-render and can't be set by merely VIEWING a card.
      if (solvedQ.has(qEl) || isBusy(qEl)) return;

      const { questionText, options, dropdownRows, textInputEls } = extractData(qEl);
      if (!questionText) return;

      const hasChoices    = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
      const hasDropdown   = dropdownRows.length > 0;
      const isFillInBlank = textInputEls.length > 0 && !hasChoices && !hasDropdown;
      // Skip free-text essay questions — can't auto-select, don't burn usage
      if (!hasChoices && !hasDropdown && !isFillInBlank) return;
      // Skip already-filled text inputs
      if (isFillInBlank && textInputEls[0].value?.trim()) return;
      // Skip image-dependent questions. The "?" button already refuses these and
      // points at the screenshot tool; Solve All used to send them anyway with
      // the image stripped out, so the model answered from the text alone and
      // guessed. Counted so the caller can explain the blanks.
      if (needsScreenshotFor(qEl, questionText)) { skippedImages++; return; }

      setTimeout(() => {
        if (hasDropdown) {
          const isMatching = dropdownRows.length >= 2 &&
            dropdownRows.every(r => JSON.stringify([...r.options].sort()) ===
                                     JSON.stringify([...dropdownRows[0].options].sort()));
          if (isMatching) {
            const rows = dropdownRows.map(r => ({
              label:    r.rowLabel.replace(/→\s*$/, '').trim(),
              options:  r.options,
              selectEl: r.selectEl,
            }));
            markInflight(qEl);
            sendSolve(
              { type: 'SOLVE_MATCHING', question: questionText,
                rows: rows.map(r => ({ label: r.label, options: r.options })) },
              (resp) => {
                clearInflight(qEl);
                if (chrome.runtime.lastError || !resp || !resp.answers) {
                  reportSolveOutcome('matching', resp, chrome.runtime.lastError?.message);
                  return;
                }
                let anyFilled = false;
                rows.forEach((r, i) => {
                  const ans = resp.answers[String(i + 1)];
                  if (ans && autoSelectDropdown(r.selectEl, ans)) anyFilled = true;
                });
                if (anyFilled) { markSolved(qEl); if (btn) btn.dataset.opened = 'true'; }
              }
            );
          } else {
            // Independent dropdowns — solve each row separately
            markInflight(qEl);
            let rowsLeft = dropdownRows.length;
            dropdownRows.forEach(({ rowLabel, selectEl, options: rowOpts }, i) => {
              setTimeout(() => {
                const cleanLabel = rowLabel.replace(/→\s*$/, '').trim();
                const q = cleanLabel ? `${questionText}\n\nFor: "${cleanLabel}"` : questionText;
                sendSolve(
                  { type: 'SOLVE_QUESTION', question: q, options: rowOpts },
                  (resp) => {
                    if (--rowsLeft <= 0) clearInflight(qEl);
                    if (!chrome.runtime.lastError && resp && !resp.error) {
                      if (autoSelectDropdown(selectEl, resp.answer)) {
                        markSolved(qEl); if (btn) btn.dataset.opened = 'true';
                      }
                    } else {
                      reportSolveOutcome('dropdown', resp, chrome.runtime.lastError?.message);
                    }
                  }
                );
              }, i * 600);
            });
          }
        } else if (isFillInBlank) {
          markInflight(qEl);
          sendSolve(
            { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false, blankCount: textInputEls.length },
            (resp) => {
              clearInflight(qEl);
              if (!chrome.runtime.lastError && resp && !resp.error) {
                const filled = autoFillTextInput(textInputEls, resp.answer, resp.answerParts);
                reportOutcome(resp, filled, filled ? undefined : 'solve-all: no input filled');
                if (filled) {
                  markSolved(qEl); if (btn) btn.dataset.opened = 'true';
                }
              } else {
                reportSolveOutcome('fill-blank', resp, chrome.runtime.lastError?.message);
              }
            }
          );
        } else {
          const isMultiSelect = !!qEl.querySelector('input[type="checkbox"]');
          markInflight(qEl);
          sendSolve(
            { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect },
            (resp) => {
              clearInflight(qEl);
              if (!chrome.runtime.lastError && resp && !resp.error) {
                const matched = autoSelectAnswer(qEl, resp.answer, resp.answerParts);
                reportOutcome(resp, matched, matched ? undefined : 'solve-all: ' + selectFailDetail(qEl, options, resp));
                if (matched) {
                  markSolved(qEl); if (btn) btn.dataset.opened = 'true';
                }
              } else {
                reportSolveOutcome('choice', resp, chrome.runtime.lastError?.message);
              }
            }
          );
        }
      }, delay);
      delay += 1200;
    });
    return { delay, skippedImages };
  }

  // Records WHY a solve failed so the popup can tell "not logged in" / "daily
  // limit reached" / "network error" apart from "nothing happened".
  // Storage-only — never renders anything on the page (would break stealth).
  function reportSolveOutcome(stage, resp, lastErrMsg) {
    const err = lastErrMsg || resp?.error;
    if (!err) return;
    recordSolveStatus(resp?.limitReached ? 'limit' : 'error', err);
  }

  // Records the outcome of the most recent solve so the popup can show WHY
  // nothing happened. Stealth mode is silent by design, so without this a failed
  // solve and a blocked click look identical to the user — which is exactly what
  // made this so hard to pin down.
  function recordSolveStatus(kind, detail) {
    try {
      chrome.storage.local.set({ answerlyLastSolve: {
        ts: Date.now(), kind, detail: String(detail || '').slice(0, 200),
      }});
    } catch { /* context invalidated */ }
  }

  // ── Directly fill all fill-in-blank questions (stealth mode) ─────────────
  function stealthFillAll() {
    const questions = findQuestions();
    let delay = 0;
    questions.forEach(qEl => {
      const hasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
      const hasDropdown = !!qEl.querySelector('select');
      if (hasChoices || hasDropdown) return;

      const textInputs = Array.from(qEl.querySelectorAll('input, textarea')).filter(el => {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return !['hidden','submit','button','checkbox','radio','file','image','reset'].includes(t) && !el.disabled;
      });
      if (!textInputs.length) return;
      if (textInputs[0].value && textInputs[0].value.trim()) return; // already answered

      const textEl = qEl.querySelector('.question_text, [data-question-text], .question-text, .formattedHtml');
      const qText = textEl ? textEl.innerText.trim() : '';
      if (!qText) return;
      // Same rule as Solve All: a blank whose answer is only in a figure can't be
      // filled from the text. Silent here by necessity — stealth shows no toast —
      // but leaving it empty beats typing in a confident wrong answer.
      if (needsScreenshotFor(qEl, qText)) return;

      setTimeout(() => {
        sendSolve(
          { type: 'SOLVE_QUESTION', question: qText, options: [], isMultiSelect: false, blankCount: textInputs.length },
          (resp) => {
            if (!chrome.runtime.lastError && resp && !resp.error) {
              autoFillTextInput(textInputs, resp.answer, resp.answerParts);
              // Also write directly into TinyMCE / rich-text iframes
              for (const fr of qEl.querySelectorAll('iframe')) {
                try {
                  const doc = fr.contentDocument || fr.contentWindow?.document;
                  if (doc?.body?.isContentEditable) {
                    doc.body.focus();
                    doc.body.innerText = resp.answer;
                    ['input', 'change'].forEach(t =>
                      doc.body.dispatchEvent(new Event(t, { bubbles: true }))
                    );
                    break;
                  }
                } catch { /* cross-origin iframe — skip */ }
              }
            }
          }
        );
      }, delay);
      delay += 1200;
    });
  }

  // ── Shared camera capture flow ─────────────────────────────────────────────
  // Shared by both injectButtons() (quiz solver active) and
  // injectCameraOnlyButtons() (screenshot stealth standalone).
  function doCameraCapture(triggerBtn, qEl, questionText) {
    // Watchdog: any dropped callback (MV3 worker teardown, a rejected crop, a
    // backend timeout) used to leave dataset.busy set forever, permanently
    // killing that camera button. Always release the lock.
    const releaseBusy = () => { triggerBtn.dataset.busy = ''; };
    const watchdog = setTimeout(releaseBusy, 90000);
    const done = () => { clearTimeout(watchdog); releaseBusy(); };

    sendSolve({ type: 'CAPTURE_SCREENSHOT' }, (captResp) => {
      if (chrome.runtime.lastError || !captResp || captResp.error) {
        done(); return;
      }
      showStealthSelectionOverlay(captResp.dataUrl, (region) => {
        cropStealthImage(captResp.dataUrl, region.x, region.y, region.w, region.h).catch(() => {
          done(); return null;
        }).then(croppedDataUrl => {
          if (!croppedDataUrl) { done(); return; }
          sendSolve(
            { type: 'SOLVE_SCREENSHOT_STEALTH', image: croppedDataUrl, questionText: questionText.slice(0, 200) },
            (r) => {
              if (chrome.runtime.lastError || !r || r.error) {
                done(); return;
              }
              const answerLetter = (r.answer || '').toLowerCase().trim();
              let   answerText   = (r.answerText || '').trim();

              // Guard 1: discard raw JSON strings from undeployed/old backend
              // e.g. {"answer": "", "answerText": ""} should never be written to an editor
              if (/^\s*\{.*"answer"\s*:/.test(answerText)) answerText = '';

              // Guard 2: discard if AI returned the question text verbatim as the answer
              if (answerText && questionText) {
                const atNorm = answerText.toLowerCase().replace(/\s+/g, ' ').trim();
                const qtNorm = questionText.toLowerCase().replace(/\s+/g, ' ').trim();
                if (qtNorm.length > 20 && atNorm.slice(0, 60) === qtNorm.slice(0, 60)) answerText = '';
              }

              // Essay fallback: if screenshot gave nothing useful AND there's a TinyMCE iframe,
              // fall back to the text-based solver — this always produces a proper written answer
              if (!answerText && !answerLetter) {
                const richIframes = Array.from(qEl.querySelectorAll('iframe')).filter(fr => {
                  try { const d = fr.contentDocument || fr.contentWindow?.document; return !!(d?.body); }
                  catch { return false; }
                });
                if (richIframes.length) {
                  sendSolve(
                    { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false },
                    (resp) => {
                      done();
                      if (!chrome.runtime.lastError && resp && !resp.error && resp.answer) {
                        try {
                          const doc = richIframes[0].contentDocument || richIframes[0].contentWindow?.document;
                          if (doc?.body) {
                            doc.body.focus();
                            doc.body.innerText = resp.answer;
                            ['input', 'change'].forEach(t =>
                              doc.body.dispatchEvent(new Event(t, { bubbles: true }))
                            );
                            triggerBtn.dataset.opened = 'true';
                          }
                        } catch { /* cross-origin iframe */ }
                      }
                    }
                  );
                  return; // busy cleared inside callback above
                }
                done();
                return;
              }

              // ── Normal fill path ──────────────────────────────────────────
              done();
              const textParts = answerText
                ? answerText.split('|').map(p => p.trim()).filter(Boolean)
                : [];
              const selects = Array.from(qEl.querySelectorAll('select'));
              let matched   = false;
              if (textParts.length > 0) matched = autoSelectAnswer(qEl, textParts.join(", "), textParts);
              if (!matched && answerLetter && /^[a-e](,\s*[a-e])*$/.test(answerLetter))
                matched = autoSelectAnswer(qEl, answerLetter);
              if (selects.length > 0 && textParts.length > 0) {
                let anyDropdown = false;
                if (textParts.length === selects.length) {
                  selects.forEach((sel, i) => { if (autoSelectDropdown(sel, textParts[i])) anyDropdown = true; });
                } else {
                  textParts.forEach(part => { selects.forEach(sel => { if (autoSelectDropdown(sel, part)) anyDropdown = true; }); });
                }
                if (anyDropdown) matched = true;
              }
              if (!matched && textParts.length > 0) {
                const inputs = Array.from(
                  qEl.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
                ).filter(el => el.type !== 'hidden' && !el.disabled && (el.offsetWidth || el.offsetHeight));
                if (inputs.length) matched = autoFillTextInput(inputs, textParts.join('; '), textParts);
              }
              if (!matched && textParts.length > 0) {
                for (const iframe of qEl.querySelectorAll('iframe')) {
                  try {
                    const doc      = iframe.contentDocument || iframe.contentWindow?.document;
                    const editable = doc?.body;
                    if (editable) {
                      editable.focus();
                      editable.innerText = textParts[0];
                      ['input', 'change'].forEach(t =>
                        editable.dispatchEvent(new Event(t, { bubbles: true }))
                      );
                      matched = true; break;
                    }
                  } catch { /* cross-origin iframe — skip */ }
                }
              }
              // Mark the question solved so Solve All leaves it alone. Without
              // this the camera's answer was invisible to solveAllDirect(), which
              // re-solved the same question from its text and overwrote a correct
              // vision answer with a guess — including on its own automatic second
              // pass, so it happened with no further click from the student.
              if (matched) { triggerBtn.dataset.opened = 'true'; markSolved(qEl); }
            }
          );
        });
      }, () => { done(); });
    });
  }

  // ── Camera-only injection (screenshot stealth without quiz solver) ──────────
  // Injects an invisible camera button on every question so screenshot stealth
  // works regardless of whether the quiz solver is active.
  function injectCameraOnlyButtons() {
    if (!screenshotStealthActive) return;
    injectStyles();
    const questions = findQuestions();
    questions.forEach(qEl => {
      if (qEl.querySelector('.answerly-cam-only')) return; // already injected
      const textEl = qEl.querySelector('.question_text, [data-question-text], .question-text, .formattedHtml');
      const questionText = textEl ? textEl.innerText.trim() : '';
      if (!questionText) return;
      const header =
        qEl.querySelector('.question_name') ||
        qEl.querySelector('.question-header') ||
        qEl.querySelector('.header') ||
        qEl.firstElementChild;
      if (!header) return;

      const camBtn = document.createElement('button');
      camBtn.type      = 'button';
      camBtn.className = `answerly-btn answerly-invisible answerly-cam-btn answerly-cam-only ${INJECTED}`;
      camBtn.title     = '';
      camBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
      header.appendChild(camBtn);

      camBtn.addEventListener('mouseenter', () => {
        document.getElementById('answerly-stealth-tip')?.remove();
        const tip = document.createElement('div');
        tip.id          = 'answerly-stealth-tip';
        tip.className   = 'answerly-cam-tooltip';
        tip.textContent = '📸 Screenshot';
        document.body.appendChild(tip);
        const r = camBtn.getBoundingClientRect();
        tip.style.left = r.left + 'px';
        tip.style.top  = (r.top - 26) + 'px';
      });
      camBtn.addEventListener('mouseleave', () => {
        document.getElementById('answerly-stealth-tip')?.remove();
      });

      camBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (shouldIgnoreCamClick(camBtn)) return;
        camBtn.dataset.busy = 'true';
        doCameraCapture(camBtn, qEl, questionText);
      });
    });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  function removeAll() {
    document.querySelectorAll(`.${INJECTED}`).forEach(el => el.remove());
    observer?.disconnect();
    observer = null;
  }

  // True when a mutation batch only describes nodes we injected ourselves.
  // Reacting to those re-enters injection and re-triggers the observer, which is
  // how the page ended up scanning in a tight loop and starving itself of CPU.
  function isSelfMutation(records) {
    for (const r of records) {
      const nodes = [...r.addedNodes, ...r.removedNodes];
      for (const n of nodes) {
        if (n.nodeType !== 1) continue;
        const cl = n.classList;
        if (!cl) return false;
        if (!(cl.contains(INJECTED) || cl.contains('answerly-card') ||
              cl.contains('answerly-btn') || cl.contains('answerly-cam-tooltip') ||
              n.id === 'answerly-stealth-tip' || n.id === 'answerly-stealth-overlay')) {
          return false;
        }
      }
    }
    return true;
  }

  function startObserver() {
    if (observer) return;
    if (!document.body) return;   // nothing to observe yet — render() retries on sync
    let scheduled = false;
    observer = new MutationObserver((records) => {
      if (isSelfMutation(records)) return;   // never react to our own DOM writes
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

  // Both are now thin aliases over the reconciler: storage is authoritative, so
  // there is no separate "activate" state to get out of sync with it.
  function activate()   { syncState(true); }
  function deactivate() { syncState(true); }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      // These messages carry no information storage doesn't already have — the
      // popup always writes storage BEFORE sending — so every one of them just
      // triggers a re-read. A message that lands on an already-loaded document
      // now REPAIRS stale state instead of being ignored.
      case 'ANSWERLY_SYNC':
      case 'QUIZ_SOLVER_ON':  case 'QUIZ_SOLVER_OFF':
      case 'QUIZ_STEALTH_ON': case 'QUIZ_STEALTH_OFF':
      case 'SS_STEALTH_ON':   case 'SS_STEALTH_OFF':
        syncState();
        return;
      case 'SOLVE_ALL':
        handleSolveAll();
        return;
    }
  });

  // React to state written by the popup/customize page — including in tabs that
  // were not focused when the toggle happened (messages only reach the active tab).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.answerlyQuizActive !== undefined ||
        changes.answerlyQuizStealthActive !== undefined ||
        changes.answerlyScreenshotActive !== undefined ||
        changes.answerlyScreenshotStealthActive !== undefined ||
        changes.answerlySession !== undefined) {
      syncState();
      return;
    }

    const themeKey = currentCode ? 'answerlyTheme_' + currentCode : 'answerlyTheme';
    if (changes[themeKey]) {
      theme = { ...DEFAULT_THEME, ...changes[themeKey].newValue };
      render();                        // live theme update
    }
  });

  // Bootstrap — storage is the single source of truth.
  // Wait for document.body: background injection can run before it exists, and
  // rendering into a missing body silently produced "no buttons until I re-toggle".
  (function boot() {
    if (document.body) { syncState(true); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => syncState(true), { once: true });
    } else {
      setTimeout(boot, 50);
    }
  })();

  // Safety net: Canvas can render or replace question DOM after we first run.
  // Re-assert the correct buttons periodically while a tool is active, so a
  // missed mutation can never leave the page with nothing on it.
  // Rebuild any button whose baked-in behaviour no longer matches the live mode.
  // Without this, a button built in one mode kept that mode's click handler for
  // the life of the page, so clicking a "stealth" question could run normal-mode
  // logic (or nothing useful) — and only a manual off/on toggle, which destroys
  // and recreates the buttons, put it right.
  function repairStaleModeButtons() {
    if (!solverActive) return false;
    const want = stealthHidden ? 'stealth' : 'normal';
    const stale = document.querySelector(
      `.answerly-btn.${INJECTED}:not(.answerly-cam-btn):not([data-mode="${want}"])`
    );
    if (!stale) return false;
    render();          // tear down and re-inject with the correct handlers
    return true;
  }

  let recheckPending = false;
  setInterval(() => {
    if (!stateReady) return;
    if (repairStaleModeButtons()) return;
    if (solverActive)                 { injectStyles(); injectButtons(); startObserver(); }
    else if (screenshotStealthActive) { injectStyles(); injectCameraOnlyButtons(); startObserver(); }
    else {
      // Nothing is supposed to be on the page. Re-verify against storage every
      // so often so a single bad read can never leave the page permanently bare.
      if (!recheckPending) {
        recheckPending = true;
        setTimeout(() => { recheckPending = false; syncState(true); }, 3000);
      }
    }
  }, 2000);

  // ── New Quizzes iframe overlay relay ──────────────────────────────────────
  // newQuizSolver.js runs inside the quiz-lti cross-origin iframe where
  // `position:fixed` is clipped to iframe bounds, making the overlay tiny.
  // Solution: the iframe posts the captured dataUrl here; the parent page shows
  // the full-screen overlay, then posts the selected region coordinates back.
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'ANSWERLY_NQ_SHOW_OVERLAY') return;
    // Only accept messages from the known quiz-lti origin
    if (e.origin && !e.origin.includes('quiz-lti-iad-prod.instructure.com')) return;
    const dataUrl = e.data.dataUrl;
    if (!dataUrl) return;
    injectStyles(); // ensure overlay CSS is present
    showStealthSelectionOverlay(
      dataUrl,
      (region) => {
        e.source.postMessage({
          type:          'ANSWERLY_NQ_REGION_SELECTED',
          x:             region.x,
          y:             region.y,
          w:             region.w,
          h:             region.h,
          viewportWidth:  window.innerWidth,
          viewportHeight: window.innerHeight,
        }, '*');
      },
      () => {
        e.source.postMessage({ type: 'ANSWERLY_NQ_REGION_CANCELLED' }, '*');
      }
    );
  });

})();
} // end guard
