// ── Answerly AI — Quiz Solver Content Script ─────────────────────────────────────
if (window.__answerlyQuizSolverLoaded) { /* already running */ } else {
window.__answerlyQuizSolverLoaded = true;

(function () {
  'use strict';

  let solverActive  = false;
  let stealthHidden = false;
  let observer      = null;
  let currentCode   = null;
  const INJECTED    = 'answerly-injected';

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
        z-index: 9999 !important;
        line-height: 1 !important;
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
      }
      .answerly-btn.answerly-invisible:hover {
        opacity: 0 !important;
        transform: none !important;
        box-shadow: none !important;
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
    `;
    document.head.appendChild(s);
  }

  // ── Find questions ─────────────────────────────────────────────────────────
  function findQuestions() {
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

  function extractData(qEl) {
    const textEl =
      qEl.querySelector('.question_text') ||
      qEl.querySelector('[data-question-text]') ||
      qEl.querySelector('.question-text');
    const questionText = textEl ? textEl.innerText.trim() : '';

    const labelEls = qEl.querySelectorAll('.answer .answer_label, .answer_label, [data-answer-text]');
    const seen = new Set();
    const options = [];
    labelEls.forEach(el => {
      const t = el.innerText.trim();
      if (t && !seen.has(t)) { seen.add(t); options.push(t); }
    });

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

      // Find a row label: table cell OR text immediately before the select
      let rowLabel = '';
      const row = sel.closest('tr');
      if (row) {
        const firstCell = row.querySelector('td:first-child, th:first-child');
        if (firstCell) rowLabel = firstCell.innerText.trim();
      } else {
        // Inline dropdown: only grab text between this select and the previous one
        let node = sel.previousSibling;
        let before = '';
        while (node) {
          if (node.nodeType === Node.TEXT_NODE) {
            before = node.textContent + before;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'SELECT') break; // stop at previous dropdown
            before = node.innerText + before;
          }
          node = node.previousSibling;
          if (before.trim().length > 60) break;
        }
        rowLabel = before.replace(/\[\s*(?:Select|Choose)\s*\]/gi, '').trim().slice(-60);
      }

      dropdownRows.push({ rowLabel, selectEl: sel, options: rowOptions });
      rowOptions.forEach(o => { if (!seen.has(o)) { seen.add(o); options.push(o); } });
    });

    return { questionText, options, dropdownRows };
  }

  // ── Auto-select a <select> dropdown ───────────────────────────────────────
  function autoSelectDropdown(selectEl, answer) {
    const target = answer.trim().toLowerCase();
    for (let i = 0; i < selectEl.options.length; i++) {
      const opt     = selectEl.options[i];
      const optText = opt.text.trim().toLowerCase();
      if (!optText || optText.startsWith('[')) continue;
      if (optText === target || optText.includes(target) || target.includes(optText)) {
        selectEl.selectedIndex = i;
        ['change', 'input'].forEach(t => selectEl.dispatchEvent(new Event(t, { bubbles: true })));
        return true;
      }
    }
    return false;
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

  // ── Auto-select: click the matching radio/checkbox in Canvas ───────────────
  function autoSelectAnswer(qEl, answer) {
    const answerDivs = qEl.querySelectorAll('.answer');
    const targets = answer.split(',').map(a => normalizeText(a)).filter(Boolean);
    const rawTargets = answer.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);

    // Multiple answers (checkboxes) — click all matches
    if (targets.length > 1) {
      let matched = false;
      for (const div of answerDivs) {
        const label = div.querySelector('.answer_label, label');
        if (!label) continue;
        const labelText    = label.innerText.trim().toLowerCase();
        const labelNorm    = normalizeText(labelText);
        for (let i = 0; i < targets.length; i++) {
          const t    = targets[i];
          const tRaw = rawTargets[i];
          if (labelNorm === t || labelNorm.includes(t) || t.includes(labelNorm) ||
              labelText.includes(tRaw) || tRaw.includes(labelText)) {
            const input = div.querySelector('input[type="checkbox"]');
            if (input && !input.checked) { input.click(); matched = true; }
            break;
          }
        }
      }
      return matched;
    }

    // Single answer — radio or checkbox
    const target    = targets[0]    || normalizeText(answer);
    const targetRaw = rawTargets[0] || answer.trim().toLowerCase();

    // Pass 1: exact normalized match
    for (const div of answerDivs) {
      const label = div.querySelector('.answer_label, label');
      if (!label) continue;
      const labelNorm = normalizeText(label.innerText);
      if (labelNorm === target) {
        const input = div.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) { input.click(); return true; }
      }
    }

    // Pass 2: includes match (normalized)
    for (const div of answerDivs) {
      const label = div.querySelector('.answer_label, label');
      if (!label) continue;
      const labelNorm = normalizeText(label.innerText);
      if (labelNorm.includes(target) || target.includes(labelNorm)) {
        const input = div.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) { input.click(); return true; }
      }
    }

    // Pass 3: raw includes match (original strings)
    for (const div of answerDivs) {
      const label = div.querySelector('.answer_label, label');
      if (!label) continue;
      const labelText = label.innerText.trim().toLowerCase();
      if (labelText.includes(targetRaw) || targetRaw.includes(labelText)) {
        const input = div.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) { input.click(); return true; }
      }
    }

    // Pass 4: partial match on first 25 chars of normalized text
    for (const div of answerDivs) {
      const label = div.querySelector('.answer_label, label');
      if (!label) continue;
      const labelNorm = normalizeText(label.innerText);
      if (labelNorm.startsWith(target.slice(0, 25)) || target.startsWith(labelNorm.slice(0, 25))) {
        const input = div.querySelector('input[type="radio"], input[type="checkbox"]');
        if (input) { input.click(); return true; }
      }
    }

    // Pass 5: fallback — single select dropdown
    const selects = qEl.querySelectorAll('select');
    if (selects.length === 1) return autoSelectDropdown(selects[0], answer);

    return false;
  }

  // ── Inject buttons ─────────────────────────────────────────────────────────
  function injectButtons() {
    const questions = findQuestions();
    console.log('[Answerly AI] Found', questions.length, 'question(s)');

    questions.forEach(qEl => {
      if (qEl.querySelector('.answerly-btn')) return;

      const { questionText, options, dropdownRows } = extractData(qEl);
      if (!questionText) return;

      const isFreeText = options.length === 0;
      const accent = theme.accentColor || DEFAULT_THEME.accentColor;
      const effectiveAutoSelect = stealthHidden;

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

      header.appendChild(btn);

      if (dropdownRows.length > 0) {
        // Detect if options are mostly numbers (e.g. packet trace questions) → needs screenshot
        const allOpts = dropdownRows.flatMap(r => r.options);
        const numericCount = allOpts.filter(o => /^\d+$/.test(o.trim())).length;
        const needsScreenshot = numericCount > allOpts.length / 2;

        // ── DROPDOWN QUESTION: solve all dropdowns, show answers in card ──────
        const card = document.createElement('div');
        card.className     = `answerly-card ${INJECTED}`;
        card.style.display = 'none';
        card.style.setProperty('background',   theme.cardBg,     'important');
        card.style.setProperty('border-color', theme.cardBorder, 'important');
        card.style.setProperty('opacity',      theme.opacity / 100, 'important');
        card.innerHTML = needsScreenshot
          ? `<div class="answerly-badge" style="color:${accent}!important">
               <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
               Answerly AI
             </div>
             <div class="answerly-hint-row" style="color:#a090f0!important;">
               📸 This question requires specific data to answer.<br>
               <span style="color:#c0c0d8!important;">Use the <strong style="color:#fff!important;">Screenshot Tool</strong> for AI assistance.</span>
             </div>`
          : `<div class="answerly-badge" style="color:${accent}!important">
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
            const isOpen = card.style.display !== 'none';
            card.style.display = isOpen ? 'none' : 'block';
            btn.dataset.opened = 'true';
            return;
          }
          if (btn.dataset.done) return;
          btn.dataset.done = 'true';
          btn.dataset.opened = 'true';
          if (!effectiveAutoSelect) card.style.display = 'block';

          const baseQ = questionText.length > 800
            ? questionText.slice(0, 800).trim() + '...'
            : questionText.trim();
          const results = [];

          for (const { rowLabel, selectEl, options: rowOpts } of dropdownRows) {
            const cleanLabel = rowLabel.replace(/→\s*$/, '').trim();
            const q = cleanLabel
              ? `${baseQ}\n\nFor: "${cleanLabel}"`
              : baseQ;

            await new Promise(resolve => {
              chrome.runtime.sendMessage(
                { type: 'SOLVE_QUESTION', question: q, options: rowOpts },
                (resp) => {
                  if (!chrome.runtime.lastError && resp && !resp.error) {
                    autoSelectDropdown(selectEl, resp.answer);
                    results.push({ label: cleanLabel, answer: resp.answer });
                  } else {
                    results.push({ label: cleanLabel, answer: '—' });
                  }
                  resolve();
                }
              );
            });
            await new Promise(resolve => setTimeout(resolve, 400));
          }

          if (effectiveAutoSelect) { card.style.display = 'none'; return; }
          const area = card.querySelector('.answerly-hint-area');
          area.innerHTML = results.map((r, i) =>
            `<div style="padding:5px 0;border-bottom:1px solid #2a2a4a;font-size:12px;">
              <span style="color:#fff!important;font-weight:600;">${i + 1}. ${r.label ? esc(r.label) + ' →' : ''}</span>
              <span style="color:${theme.answerColor}!important;font-weight:700;"> ${esc(r.answer)}</span>
            </div>`
          ).join('');
        });

      } else if (effectiveAutoSelect) {
        // ── AUTO-SELECT MODE: invisible button, click silently selects answer ─
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isFreeText || btn.dataset.done) return;
          btn.dataset.done = 'true';
          chrome.runtime.sendMessage(
            { type: 'SOLVE_QUESTION', question: questionText, options },
            (resp) => {
              if (!chrome.runtime.lastError && resp && !resp.error) {
                const matched = autoSelectAnswer(qEl, resp.answer);
                if (matched) {
                  btn.dataset.opened = 'true'; // only mark done after confirmed match
                } else {
                  // Answer came back but didn't match any option — allow retry
                  btn.dataset.done = '';
                }
              } else {
                // Network/server error — allow retry
                btn.dataset.done = '';
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
            ${isFreeText
              ? `<div class="answerly-hint-row" style="color:#a090f0!important;">
                  📸 This is a free-response question.<br>
                  <span style="color:#c0c0d8!important;">Use the <strong style="color:#fff!important;">Screenshot Tool</strong> in the extension for AI assistance.</span>
                 </div>`
              : `<div class="answerly-loading"><div class="answerly-spinner"></div>Thinking…</div>`
            }
          </div>`;

        const answers = qEl.querySelector('.answers') || qEl.querySelector('.answer_group');
        (answers || qEl).insertAdjacentElement('afterend', card);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const isOpen = card.style.display !== 'none';
          card.style.display = isOpen ? 'none' : 'block';
          if (!isOpen && !card.dataset.loaded && !isFreeText) {
            fetchAnswer(card, questionText, options);
          }
          if (!isOpen) {
            card.dataset.loaded = 'true';
            btn.dataset.opened  = 'true';
          }
        });
      }
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  function fetchAnswer(card, questionText, options) {
    card.dataset.loaded = 'true';
    chrome.runtime.sendMessage(
      { type: 'SOLVE_QUESTION', question: questionText, options },
      (resp) => {
        if (chrome.runtime.lastError || !resp) {
          return renderError(card, 'Extension error — try reloading.');
        }
        if (resp.error) return renderError(card, resp.error, resp.limitReached);
        renderResult(card, resp.hint, resp.answer);
      }
    );
  }

  function renderResult(card, hint, answer) {
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
        row.innerHTML = `<span class="answerly-answer-lbl" style="color:${accent}!important">Answer</span><div class="answerly-answer-text" style="color:${theme.answerColor}!important">${esc(answer)}</div>`;
        this.insertAdjacentElement('afterend', row);
        this.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transform:rotate(90deg)"><polyline points="9 18 15 12 9 6"/></svg> Hide Answer`;
        this.dataset.open = 'true';
      }
    });
  }

  function renderError(card, msg) {
    card.querySelector('.answerly-hint-area').innerHTML =
      `<div class="answerly-error">${esc(msg)}</div>`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  function removeAll() {
    document.querySelectorAll(`.${INJECTED}`).forEach(el => el.remove());
    observer?.disconnect();
    observer = null;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => { if (solverActive) injectButtons(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

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
  function deactivate() { solverActive = false; removeAll(); }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'QUIZ_SOLVER_ON')  activate();
    if (msg.type === 'QUIZ_SOLVER_OFF') deactivate();
    if (msg.type === 'STEALTH_ON')  { stealthHidden = true;  if (solverActive) { removeAll(); injectButtons(); startObserver(); } }
    if (msg.type === 'STEALTH_OFF') { stealthHidden = false; if (solverActive) { removeAll(); injectButtons(); startObserver(); } }
    if (msg.type === 'SOLVE_ALL') {
      injectStyles();
      injectButtons();
      // Stagger clicks 700ms apart so backend isn't flooded simultaneously
      const btns = Array.from(document.querySelectorAll('.answerly-btn:not([data-opened])'));
      btns.forEach((btn, i) => setTimeout(() => btn.click(), i * 700));
    }
  });

  // Re-inject buttons when theme or stealth changes (live updates from popup + customize)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !solverActive) return;
    const themeKey = currentCode ? 'answerlyTheme_' + currentCode : 'answerlyTheme';
    if (changes[themeKey]) {
      theme = { ...DEFAULT_THEME, ...changes[themeKey].newValue };
      removeAll();
      injectStyles();
      injectButtons();
      startObserver();
    }
  });

  // Load theme + activation state together so theme is always ready before buttons are injected
  // Theme is keyed to the activation code so each account has its own customization
  chrome.storage.local.get(['answerlyQuizActive', 'answerlyStealthActive', 'answerlySession'], (s) => {
    currentCode = s.answerlySession?.code || null;
    if (s.answerlyStealthActive) stealthHidden = true;
    if (s.answerlyQuizActive) activate();
  });

})();
} // end guard
