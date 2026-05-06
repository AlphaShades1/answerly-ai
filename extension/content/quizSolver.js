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

    const labelEls = qEl.querySelectorAll(
      '.answer .answer_label, .answer_label, [data-answer-text], ' +
      '.answer .answer_text, .answer_text, .answer label'
    );
    const seen = new Set();
    const options = [];
    labelEls.forEach(el => {
      const t = el.innerText.trim();
      if (t && !seen.has(t)) { seen.add(t); options.push(t); }
    });

    // Fallback: if no labels found via class selectors, discover them from the inputs directly
    if (options.length === 0) {
      qEl.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(input => {
        const t = getOptionLabelText(input, qEl);
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

      console.log('[Answerly] Dropdown row label:', JSON.stringify(rowLabel), '| options:', rowOptions);
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
  function autoFillTextInput(inputEls, answer) {
    if (!inputEls.length) return false;
    const el = inputEls[0];
    el.focus();
    el.value = answer;
    ['input', 'change'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
    el.blur();
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
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.appendChild(canvas);

    const hint = document.createElement('div');
    hint.id = 'answerly-stealth-hint';
    hint.textContent = 'Drag to select area  •  Esc to cancel';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
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
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.50)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (drawn || selecting) {
        const x = Math.min(startX, curX), y = Math.min(startY, curY);
        const w = Math.abs(curX - startX),  h = Math.abs(curY - startY);
        if (w > 2 && h > 2) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.clearRect(x, y, w, h);
          if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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

  // ── Get the visible label text for any input element ─────────────────────
  // Works regardless of which wrapper class Canvas uses (.answer, .answer-option, etc.)
  function getOptionLabelText(input, scope) {
    scope = scope || document;
    // 1. Explicit <label for="id">
    if (input.id) {
      const lbl = scope.querySelector(`label[for="${input.id}"]`) ||
                  document.querySelector(`label[for="${input.id}"]`);
      if (lbl) return lbl.innerText.trim();
    }
    // 2. Input wrapped inside a <label>
    const wrappedLabel = input.closest('label');
    if (wrappedLabel) return wrappedLabel.innerText.trim();
    // 3. Named answer element in parent container
    const container = input.closest('.answer, .answer-option, .answer_choice, [data-answer], li, tr');
    if (container) {
      const lbl = container.querySelector('.answer_label, .answer_text, label, span.answer-label');
      if (lbl) return lbl.innerText.trim();
      // Fallback: full text of the container minus the input's own text
      return container.innerText.replace(input.value || '', '').trim();
    }
    // 4. Next sibling element
    const sib = input.nextElementSibling;
    if (sib) return sib.innerText.trim();
    return '';
  }

  // ── Auto-select: click the matching radio/checkbox in Canvas ───────────────
  // Anchored on input elements — works regardless of Canvas wrapper class names.
  function autoSelectAnswer(qEl, answer) {
    const answerNorm  = normalizeText(answer);
    const answerLower = answer.trim().toLowerCase();
    const targets    = answer.split(',').map(a => normalizeText(a)).filter(Boolean);
    const rawTargets = answer.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);

    // ── Checkbox / select-all-that-apply ─────────────────────────────────────
    const checkboxes = Array.from(qEl.querySelectorAll('input[type="checkbox"]'));
    if (checkboxes.length > 0) {
      const toCheck = [];
      for (const input of checkboxes) {
        const labelText = getOptionLabelText(input, qEl);
        if (!labelText) continue;
        const labelNorm = normalizeText(labelText);
        const labelLow  = labelText.toLowerCase();

        // Exact comma-split match OR reverse substring (option appears inside AI answer)
        const exactMatch = targets.some(t => t === labelNorm) ||
                           rawTargets.some(t => t === labelLow);
        const revMatch   = labelNorm.length > 12 &&
                           (answerNorm.includes(labelNorm) || answerLower.includes(labelLow));

        if ((exactMatch || revMatch) && !input.checked) toCheck.push(input);
      }
      // Safety: abort if every checkbox would be checked (AI was not selective)
      if (toCheck.length >= checkboxes.length) return false;
      if (toCheck.length > 0) { toCheck.forEach(i => i.click()); return true; }

      // Letter fallback: if AI returned "A, C" style answers, map to checkbox indices
      const letterTargets = answer.split(',').map(a => a.trim().toUpperCase()).filter(a => /^[A-E]$/.test(a));
      if (letterTargets.length > 0) {
        const letterChecks = [];
        for (const letter of letterTargets) {
          const idx = letter.charCodeAt(0) - 65;
          if (checkboxes[idx] && !checkboxes[idx].checked) letterChecks.push(checkboxes[idx]);
        }
        if (letterChecks.length > 0 && letterChecks.length < checkboxes.length) {
          letterChecks.forEach(i => i.click()); return true;
        }
      }
      return false;
    }

    // ── Single answer — radio ─────────────────────────────────────────────────
    const radios  = Array.from(qEl.querySelectorAll('input[type="radio"]'));
    const target    = targets[0]    || answerNorm;
    const targetRaw = rawTargets[0] || answerLower;

    // Pass 1: exact normalized match
    for (const input of radios) {
      const lbl = getOptionLabelText(input, qEl);
      if (normalizeText(lbl) === target) { input.click(); return true; }
    }
    // Pass 2: includes match (normalized)
    for (const input of radios) {
      const lblNorm = normalizeText(getOptionLabelText(input, qEl));
      if (lblNorm.includes(target) || target.includes(lblNorm)) { input.click(); return true; }
    }
    // Pass 3: raw includes match
    for (const input of radios) {
      const lblLow = getOptionLabelText(input, qEl).toLowerCase();
      if (lblLow.includes(targetRaw) || targetRaw.includes(lblLow)) { input.click(); return true; }
    }
    // Pass 4: first 25 chars
    for (const input of radios) {
      const lblNorm = normalizeText(getOptionLabelText(input, qEl));
      if (lblNorm.startsWith(target.slice(0, 25)) || target.startsWith(lblNorm.slice(0, 25))) {
        input.click(); return true;
      }
    }

    // Pass 5: letter fallback — if AI returned "B" etc., map directly to radio index
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
    console.log('[Answerly AI] Found', questions.length, 'question(s)');

    questions.forEach(qEl => {
      if (qEl.querySelector('.answerly-btn')) return;

      const { questionText, options, dropdownRows, textInputEls } = extractData(qEl);
      if (!questionText) return;

      // Detect images ONLY inside the question text area — ignore decorative icons in headers/labels
      const qTextEl = qEl.querySelector('.question_text, [data-question-text], .question-text, .formattedHtml');
      const hasImage = !!qTextEl && (
        !!qTextEl.querySelector('img[src]:not([src=""])') ||
        !!qTextEl.querySelector('img:not([src=""])')
      );

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
        // Redirect to screenshot if question has an image or explicitly references external data
        const needsScreenshot = hasImage || /refer to|see (the |figure|diagram|image|graph|chart|table|packet|trace|capture|exhibit)|based on (the |figure|diagram|image|above)|shown (in|below|above)|in the (figure|diagram|image|graph|chart|table|packet|capture)/i.test(questionText);

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
              chrome.runtime.sendMessage(
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
              if (area && !effectiveAutoSelect) area.innerHTML = '<div class="answerly-error">Failed to solve — click to retry.</div>';
              return;
            }
          } else {
            // ── Non-matching: solve each dropdown separately ──────────────────
            let anySuccess = false;
            for (const { rowLabel, selectEl, options: rowOpts } of dropdownRows) {
              const cleanLabel = rowLabel.replace(/→\s*$/, '').trim();
              const q = cleanLabel ? `${baseQ}\n\nFor: "${cleanLabel}"` : baseQ;
              await new Promise(resolve => {
                chrome.runtime.sendMessage(
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

        // If question has an image, create a hidden card shown only on click
        let imageCard = null;
        if (hasImage) {
          imageCard = document.createElement('div');
          imageCard.className = `answerly-card ${INJECTED}`;
          imageCard.style.display = 'none';
          imageCard.style.setProperty('background',   theme.cardBg,     'important');
          imageCard.style.setProperty('border-color', theme.cardBorder, 'important');
          imageCard.style.setProperty('opacity',      theme.opacity / 100, 'important');
          imageCard.innerHTML = `
            <div class="answerly-badge" style="color:${accent}!important">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Answerly AI
            </div>
            <div class="answerly-hint-row" style="color:#a090f0!important;">
              📸 This question contains an image.<br>
              <span style="color:#c0c0d8!important;">Use the <strong style="color:#fff!important;">Screenshot Tool</strong> for accurate AI assistance.</span>
            </div>`;
          const answers = qEl.querySelector('.answers') || qEl.querySelector('.answer_group');
          (answers || qEl).insertAdjacentElement('afterend', imageCard);
        }

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (hasImage) {
            if (imageCard) imageCard.style.display = 'block';
            btn.dataset.opened = 'true';
            return;
          }
          if (btn.dataset.done) return;
          btn.dataset.done = 'true';
          const liveTextInputs = Array.from(
            qEl.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
          ).filter(el => el.type !== 'hidden' && !el.disabled);
          const liveHasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
          if (liveTextInputs.length > 0 && !liveHasChoices) {
            chrome.runtime.sendMessage(
              { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false },
              (resp) => {
                if (!chrome.runtime.lastError && resp && !resp.error) {
                  let filled = autoFillTextInput(liveTextInputs, resp.answer);
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
                  if (filled) btn.dataset.opened = 'true';
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
          chrome.runtime.sendMessage(
            { type: 'SOLVE_QUESTION', question: questionText, options, isMultiSelect },
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
            ${hasImage
              ? `<div class="answerly-hint-row" style="color:#a090f0!important;">
                  📸 This question contains an image.<br>
                  <span style="color:#c0c0d8!important;">Use the <strong style="color:#fff!important;">Screenshot Tool</strong> for accurate AI assistance.</span>
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
          if (!isOpen && !card.dataset.loaded && !hasImage) {
            card.dataset.loaded = 'true';
            const liveTextInputs = Array.from(
              qEl.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')
            ).filter(el => el.type !== 'hidden' && !el.disabled);
            const liveHasChoices = !!qEl.querySelector('input[type="checkbox"], input[type="radio"]');
            if (liveTextInputs.length > 0 && !liveHasChoices) {
              chrome.runtime.sendMessage(
                { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false },
                (resp) => {
                  if (chrome.runtime.lastError || !resp) return renderError(card, 'Extension error — try reloading.');
                  if (resp.error) return renderError(card, resp.error, resp.limitReached);
                  renderResult(card, resp.hint, resp.answer, resp.answerParts, []);
                  autoFillTextInput(liveTextInputs, resp.answer);
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
      if (showCamBtn) {
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
          if (camBtn.dataset.busy) return;
          camBtn.dataset.busy = 'true';
          doCameraCapture(camBtn, qEl, questionText);
        });
      }
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────
  function fetchAnswer(card, questionText, options, isMultiSelect) {
    card.dataset.loaded = 'true';
    chrome.runtime.sendMessage(
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

      setTimeout(() => {
        chrome.runtime.sendMessage(
          { type: 'SOLVE_QUESTION', question: qText, options: [], isMultiSelect: false },
          (resp) => {
            if (!chrome.runtime.lastError && resp && !resp.error) {
              autoFillTextInput(textInputs, resp.answer);
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
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (captResp) => {
      if (chrome.runtime.lastError || !captResp || captResp.error) {
        triggerBtn.dataset.busy = ''; return;
      }
      showStealthSelectionOverlay(captResp.dataUrl, (region) => {
        cropStealthImage(captResp.dataUrl, region.x, region.y, region.w, region.h).then(croppedDataUrl => {
          chrome.runtime.sendMessage(
            { type: 'SOLVE_SCREENSHOT_STEALTH', image: croppedDataUrl, questionText: questionText.slice(0, 200) },
            (r) => {
              if (chrome.runtime.lastError || !r || r.error) {
                triggerBtn.dataset.busy = ''; return;
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
                  chrome.runtime.sendMessage(
                    { type: 'SOLVE_QUESTION', question: questionText, options: [], isMultiSelect: false },
                    (resp) => {
                      triggerBtn.dataset.busy = '';
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
                triggerBtn.dataset.busy = '';
                return;
              }

              // ── Normal fill path ──────────────────────────────────────────
              triggerBtn.dataset.busy = '';
              const textParts = answerText
                ? answerText.split('|').map(p => p.trim()).filter(Boolean)
                : [];
              const selects = Array.from(qEl.querySelectorAll('select'));
              let matched   = false;
              if (textParts.length > 0) matched = autoSelectAnswer(qEl, textParts.join(', '));
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
                if (inputs.length) matched = autoFillTextInput(inputs, textParts[0]);
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
              if (matched) triggerBtn.dataset.opened = 'true';
            }
          );
        });
      }, () => { triggerBtn.dataset.busy = ''; });
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
        if (camBtn.dataset.busy) return;
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

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (solverActive) injectButtons();
      else if (screenshotStealthActive) injectCameraOnlyButtons();
    });
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
  function deactivate() {
    solverActive = false;
    removeAll();
    // If screenshot stealth is still on, keep camera buttons alive independently
    if (screenshotStealthActive) {
      injectCameraOnlyButtons();
      startObserver();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'QUIZ_SOLVER_ON')  activate();
    if (msg.type === 'QUIZ_SOLVER_OFF') deactivate();

    // Quiz stealth: hides the ? button (invisible click-through)
    if (msg.type === 'QUIZ_STEALTH_ON') {
      stealthHidden = true;
      if (solverActive) { removeAll(); injectButtons(); startObserver(); }
    }
    if (msg.type === 'QUIZ_STEALTH_OFF') {
      stealthHidden = false;
      if (solverActive) { removeAll(); injectButtons(); startObserver(); }
    }

    // Screenshot stealth — works independently of quiz solver state
    if (msg.type === 'SS_STEALTH_ON') {
      screenshotStealthActive = true;
      removeAll();
      if (solverActive) { injectButtons(); }
      else              { injectCameraOnlyButtons(); }
      startObserver();
    }
    if (msg.type === 'SS_STEALTH_OFF') {
      screenshotStealthActive = false;
      removeAll();
      if (solverActive) { injectButtons(); startObserver(); }
      // else: quiz solver is off and SS stealth off — nothing to inject
    }

    if (msg.type === 'SOLVE_ALL') {
      if (!solverActive) return; // only run when quiz solver is active
      injectStyles();
      injectButtons();
      // Directly fill fill-in-blank questions (bypasses button mechanism)
      setTimeout(stealthFillAll, 500);
      // First pass: stagger clicks for radio/checkbox/dropdown
      const btns = Array.from(document.querySelectorAll('.answerly-btn:not([data-opened]):not(.answerly-cam-btn)'));
      btns.forEach((btn, i) => setTimeout(() => btn.click(), i * 1200));
      // Retry pass
      const retryDelay = btns.length * 1200 + 8000;
      setTimeout(() => {
        stealthFillAll();
        const retryBtns = Array.from(document.querySelectorAll('.answerly-btn:not([data-opened]):not(.answerly-cam-btn)'));
        retryBtns.forEach((btn, i) => setTimeout(() => btn.click(), i * 1200));
      }, retryDelay);
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
  chrome.storage.local.get([
    'answerlyQuizActive', 'answerlyQuizStealthActive', 'answerlyScreenshotStealthActive', 'answerlySession'
  ], (s) => {
    currentCode = s.answerlySession?.code || null;
    if (s.answerlyQuizStealthActive)       stealthHidden           = true;
    if (s.answerlyScreenshotStealthActive) screenshotStealthActive = true;
    if (s.answerlyQuizActive) {
      activate(); // quiz solver on — handles camera buttons too via injectButtons()
    } else if (s.answerlyScreenshotStealthActive) {
      // Screenshot stealth on but quiz solver off — inject camera buttons independently
      // This is the ROOT FIX: camera buttons now auto-appear on page load without quiz solver
      injectStyles();
      injectCameraOnlyButtons();
      startObserver();
    }
  });

})();
} // end guard
