// ── Answerly AI — Screenshot Tool Content Script ─────────────────────────────────
if (window.__answerlyScreenshotLoaded) { /* already running */ } else {
window.__answerlyScreenshotLoaded = true;

(function () {
  'use strict';

  let widgetEl    = null;
  let capturedUrl = null; // the cropped selection data URL
  let isDragging  = false;
  let dragStartX = 0, dragStartY = 0, widgetStartX = 0, widgetStartY = 0;

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('answerly-ss-styles')) return;
    const s = document.createElement('style');
    s.id = 'answerly-ss-styles';
    s.textContent = `
      #answerly-ss-widget {
        position: fixed; bottom: 20px; right: 20px; width: 310px;
        background: #0f0f12; border: 1px solid #2e2e3e; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(124,92,252,.2);
        z-index: 2147483647; color: #f0f0f5;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; user-select: none;
      }
      #answerly-ss-widget.answerly-stealth-hidden { visibility:hidden!important; opacity:0!important; }

      .answerly-ss-topbar {
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 12px 8px; border-bottom:1px solid #2e2e3e; cursor:grab;
      }
      .answerly-ss-topbar:active { cursor:grabbing; }
      .answerly-ss-drag  { font-size:16px; color:#555570; pointer-events:none; }
      .answerly-ss-title { font-size:11px; font-weight:700; letter-spacing:.5px; color:#7c5cfc; text-transform:uppercase; }
      .answerly-ss-close {
        background:none; border:none; color:#555570; cursor:pointer;
        font-size:16px; line-height:1; padding:3px 5px; border-radius:4px;
        display:flex; align-items:center; transition:color .15s;
      }
      .answerly-ss-close:hover { color:#f0f0f5; }

      .answerly-ss-preview {
        margin:10px 12px; height:160px; background:#0a0a0e;
        border:1px solid #2e2e3e; border-radius:8px;
        display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative;
      }
      .answerly-ss-preview img { width:100%; height:100%; object-fit:contain; border-radius:7px; }
      .answerly-ss-placeholder { display:flex; flex-direction:column; align-items:center; gap:6px; color:#555570; font-size:11px; }
      .answerly-ss-placeholder svg { opacity:.4; }

      .answerly-ss-response {
        margin:0 12px 10px; background:#1a1a22; border:1px solid #2e2e3e;
        border-radius:8px; padding:10px 12px; font-size:12px; line-height:1.6;
        color:#d0d0e0; max-height:200px; overflow-y:auto; display:none; user-select:text;
      }
      .answerly-ss-response::-webkit-scrollbar { width:4px; }
      .answerly-ss-response::-webkit-scrollbar-thumb { background:#3a3a50; border-radius:2px; }
      .answerly-ss-resp-hdr { font-size:10px; font-weight:700; letter-spacing:.5px; color:#7c5cfc; text-transform:uppercase; margin-bottom:6px; }

      .answerly-ss-ctx { margin:0 12px 10px; }
      .answerly-ss-ctx textarea {
        width:100%; background:#1a1a22; border:1px solid #2e2e3e; border-radius:8px;
        padding:11px 12px; color:#f0f0f5; font-size:13px; outline:none; transition:border-color .15s;
        box-sizing:border-box; resize:vertical; min-height:52px; line-height:1.5;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      }
      .answerly-ss-ctx textarea::placeholder { color:#555570; }
      .answerly-ss-ctx textarea:focus { border-color:#7c5cfc; }

      .answerly-ss-actions { display:flex; gap:8px; padding:0 12px 12px; }
      .answerly-ss-btn {
        flex:1; padding:9px 8px; border-radius:8px; border:1px solid #2e2e3e;
        background:#1a1a22; color:#f0f0f5; font-size:12px; font-weight:600;
        cursor:pointer; display:flex; align-items:center; justify-content:center; gap:5px;
        transition:background .15s, border-color .15s;
      }
      .answerly-ss-btn:hover:not(:disabled) { background:#22222e; border-color:#4a4a60; }
      .answerly-ss-btn:disabled { opacity:.45; cursor:not-allowed; }
      .answerly-ss-send { background:#7c5cfc; border-color:#7c5cfc; color:#fff; }
      .answerly-ss-send:hover:not(:disabled) { background:#9171fd; border-color:#9171fd; }

      .answerly-ss-spinner {
        width:11px; height:11px; border:2px solid rgba(255,255,255,.3);
        border-top-color:#fff; border-radius:50%; animation:answerly-ss-spin .6s linear infinite; flex-shrink:0;
      }
      @keyframes answerly-ss-spin { to { transform:rotate(360deg); } }

      .answerly-ss-error { margin:0 12px 8px; font-size:11px; color:#f05454; display:none; }

      /* ── Selection overlay ── */
      #answerly-select-overlay {
        position: fixed; top:0; left:0; width:100vw; height:100vh;
        z-index: 2147483646; cursor: none; user-select:none;
        -webkit-user-select:none;
      }
      #answerly-select-overlay canvas {
        position:absolute; top:0; left:0; display:block;
      }
      #answerly-select-hint {
        position:absolute; bottom:24px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,.75); color:#fff; padding:8px 18px;
        border-radius:20px; font-size:13px; font-family:sans-serif;
        pointer-events:none; white-space:nowrap;
        border:1px solid rgba(124,92,252,.4);
      }
    `;
    document.head.appendChild(s);
  }

  // ── Widget ─────────────────────────────────────────────────────────────────
  function buildWidget() {
    if (document.getElementById('answerly-ss-widget')) return;
    injectStyles();

    widgetEl = document.createElement('div');
    widgetEl.id = 'answerly-ss-widget';
    widgetEl.innerHTML = `
      <div class="answerly-ss-topbar" id="answerly-ss-topbar">
        <span class="answerly-ss-drag">⊹</span>
        <span class="answerly-ss-title">Answerly AI — Screenshot</span>
        <button type="button" class="answerly-ss-close" id="answerly-ss-close">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="answerly-ss-preview" id="answerly-ss-preview">
        <div class="answerly-ss-placeholder" id="answerly-ss-ph">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Drag to select an area
        </div>
        <img id="answerly-ss-img" src="" style="display:none" alt="Screenshot selection" />
      </div>

      <div class="answerly-ss-response" id="answerly-ss-resp">
        <div class="answerly-ss-resp-hdr">Answerly AI Answer</div>
        <div id="answerly-ss-resp-text"></div>
      </div>

      <div class="answerly-ss-ctx">
        <textarea id="answerly-ss-ctx" placeholder="Add context (optional)…"></textarea>
      </div>

      <div class="answerly-ss-error" id="answerly-ss-err"></div>

      <div class="answerly-ss-actions">
        <button type="button" class="answerly-ss-btn" id="answerly-ss-capture">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Select Area
        </button>
        <button type="button" class="answerly-ss-btn answerly-ss-send" id="answerly-ss-send" disabled>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Send
        </button>
      </div>`;

    document.body.appendChild(widgetEl);
    bindEvents();
  }

  // ── Drag widget ────────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('answerly-ss-close').addEventListener('click', () => {
      deactivate();
      chrome.storage.local.set({ answerlyScreenshotActive: false });
    });
    document.getElementById('answerly-ss-topbar').addEventListener('mousedown', startWidgetDrag);
    document.getElementById('answerly-ss-capture').addEventListener('click', startCapture);
    document.getElementById('answerly-ss-send').addEventListener('click', doSend);
  }

  function startWidgetDrag(e) {
    if (e.target.closest('button')) return;
    isDragging = true;
    const r = widgetEl.getBoundingClientRect();
    dragStartX = e.clientX; dragStartY = e.clientY;
    widgetStartX = r.left;  widgetStartY = r.top;
    document.addEventListener('mousemove', onWidgetDrag);
    document.addEventListener('mouseup',   stopWidgetDrag);
    e.preventDefault();
  }
  function onWidgetDrag(e) {
    if (!isDragging) return;
    const l = Math.max(0, Math.min(window.innerWidth  - widgetEl.offsetWidth,  widgetStartX + e.clientX - dragStartX));
    const t = Math.max(0, Math.min(window.innerHeight - widgetEl.offsetHeight, widgetStartY + e.clientY - dragStartY));
    widgetEl.style.left = l+'px'; widgetEl.style.top = t+'px';
    widgetEl.style.right = 'auto'; widgetEl.style.bottom = 'auto';
  }
  function stopWidgetDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', onWidgetDrag);
    document.removeEventListener('mouseup',   stopWidgetDrag);
  }

  // ── Capture + Selection overlay ────────────────────────────────────────────
  function startCapture() {
    const btn = document.getElementById('answerly-ss-capture');
    btn.disabled = true;
    btn.textContent = 'Capturing…';

    // Hide widget briefly so it doesn't appear in screenshot
    widgetEl.style.visibility = 'hidden';

    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (resp) => {
        widgetEl.style.visibility = 'visible';
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Select Area`;

        if (!resp || resp.error) { showErr(resp?.error || 'Capture failed.'); return; }

        // Show selection overlay on top of page
        showSelectionOverlay(resp.dataUrl, (region) => {
          cropImage(resp.dataUrl, region.x, region.y, region.w, region.h).then(cropped => {
            capturedUrl = cropped;
            showPreview(cropped);
          });
        }, () => {
          // User pressed Esc — nothing captured
        });
      });
    }, 150);
  }

  // ── Selection overlay ──────────────────────────────────────────────────────
  function showSelectionOverlay(fullDataUrl, onSelect, onCancel) {
    const overlay = document.createElement('div');
    overlay.id = 'answerly-select-overlay';

    const canvas = document.createElement('canvas');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.appendChild(canvas);

    const hint = document.createElement('div');
    hint.id = 'answerly-select-hint';
    hint.textContent = 'Drag to select an area  •  Esc to cancel';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    const ctx = canvas.getContext('2d');
    const img = new Image();
    let startX = 0, startY = 0, curX = 0, curY = 0, mouseX = 0, mouseY = 0, selecting = false, drawn = false;

    function drawCrosshair(x, y) {
      const size = 12, gap = 4, thick = 2;
      ctx.save();
      // White shadow for contrast on any background
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur  = 3;
      ctx.strokeStyle = '#ff3b3b'; // bright red — visible on any background
      ctx.lineWidth   = thick;
      ctx.lineCap     = 'round';
      // Horizontal arms
      ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x - gap, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + gap,  y); ctx.lineTo(x + size, y); ctx.stroke();
      // Vertical arms
      ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x, y - gap); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + gap);  ctx.lineTo(x, y + size); ctx.stroke();
      // Center dot
      ctx.fillStyle = '#ff3b3b';
      ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw full screenshot as base
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      // Dark overlay everywhere
      ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (drawn || selecting) {
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);

        if (w > 2 && h > 2) {
          // Clear selection area — show screenshot at full brightness
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          ctx.clearRect(x, y, w, h);
          if (img.complete && img.naturalWidth) {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
          ctx.restore();

          // Purple selection border
          ctx.strokeStyle = '#7c5cfc';
          ctx.lineWidth   = 2;
          ctx.strokeRect(x, y, w, h);

          // Corner handles
          const hs = 7;
          ctx.fillStyle = '#7c5cfc';
          [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy]) => {
            ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
          });

          // Dimension badge
          const label = `${Math.round(w)} × ${Math.round(h)}`;
          ctx.font = 'bold 11px -apple-system, sans-serif';
          const tw = ctx.measureText(label).width;
          const bx = x, by = y > 22 ? y - 22 : y + h + 4;
          ctx.fillStyle = '#7c5cfc';
          ctx.beginPath();
          ctx.roundRect(bx, by, tw + 12, 18, 4);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(label, bx + 6, by + 13);
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
      startX = e.clientX; startY = e.clientY;
      curX = e.clientX;   curY = e.clientY;
      selecting = true; drawn = false;
      e.preventDefault();
    });

    overlay.addEventListener('mouseup', (e) => {
      if (!selecting) return;
      selecting = false;
      curX = e.clientX; curY = e.clientY;

      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      overlay.remove();
      removeEscListener();

      if (w < 10 || h < 10) {
        onCancel(); // too small, treat as cancel
        return;
      }
      onSelect({ x, y, w, h });
    });

    function escHandler(e) {
      if (e.key === 'Escape') { overlay.remove(); removeEscListener(); onCancel(); }
    }
    function removeEscListener() {
      document.removeEventListener('keydown', escHandler);
    }
    document.addEventListener('keydown', escHandler);
  }

  // ── Crop helper ────────────────────────────────────────────────────────────
  function cropImage(dataUrl, x, y, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // captureVisibleTab returns image at devicePixelRatio resolution
        const dpr = window.devicePixelRatio || 1;
        // The canvas element we used for the overlay was sized to CSS pixels (innerWidth/innerHeight),
        // so the image was drawn scaled down. We need to sample from the real screenshot proportionally.
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

  // ── Show preview ───────────────────────────────────────────────────────────
  function showPreview(dataUrl) {
    document.getElementById('answerly-ss-ph').style.display = 'none';
    const imgEl = document.getElementById('answerly-ss-img');
    imgEl.src = dataUrl; imgEl.style.display = 'block';
    document.getElementById('answerly-ss-resp').style.display = 'none';
    document.getElementById('answerly-ss-preview').style.display = 'flex';
    document.getElementById('answerly-ss-send').disabled = false;
    hideErr();
  }

  // ── Markdown → HTML (safe subset) ─────────────────────────────────────────
  function renderMarkdown(text) {
    return text
      // Escape HTML first to prevent injection
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      // **bold**
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#fff;font-weight:800;">$1</strong>')
      // *italic*
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Newlines → line breaks
      .replace(/\n/g, '<br>');
  }

  // ── Send to AI ─────────────────────────────────────────────────────────────
  function doSend() {
    if (!capturedUrl) return;
    const btn = document.getElementById('answerly-ss-send');
    const ctx = document.getElementById('answerly-ss-ctx').value.trim();
    btn.disabled = true;
    btn.innerHTML = '<div class="answerly-ss-spinner"></div> Analyzing…';
    hideErr();

    chrome.runtime.sendMessage({ type: 'SOLVE_SCREENSHOT', image: capturedUrl, context: ctx }, (resp) => {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg> Send`;

      if (!resp || resp.error) { showErr(resp?.error || 'AI request failed.'); return; }

      document.getElementById('answerly-ss-preview').style.display = 'none';
      document.getElementById('answerly-ss-resp-text').innerHTML = renderMarkdown(resp.response);
      document.getElementById('answerly-ss-resp').style.display = 'block';
    });
  }

  function showErr(m) { const e = document.getElementById('answerly-ss-err'); e.textContent = m; e.style.display = 'block'; }
  function hideErr()  { const e = document.getElementById('answerly-ss-err'); if(e) e.style.display = 'none'; }

  // ── Activate / Deactivate ──────────────────────────────────────────────────
  function activate()   { buildWidget(); }
  function deactivate() {
    document.getElementById('answerly-ss-widget')?.remove();
    document.getElementById('answerly-select-overlay')?.remove();
    widgetEl = null; capturedUrl = null;
  }

  function applyStealthState(hidden) {
    document.getElementById('answerly-ss-widget')?.classList.toggle('answerly-stealth-hidden', hidden);
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCREENSHOT_TOOL_ON')  activate();
    if (msg.type === 'SCREENSHOT_TOOL_OFF') deactivate();
    if (msg.type === 'STEALTH_ON')  applyStealthState(true);
    if (msg.type === 'STEALTH_OFF') applyStealthState(false);
  });

  chrome.storage.local.get(['answerlyScreenshotActive', 'answerlyStealthActive'], (s) => {
    if (s.answerlyScreenshotActive) activate();
    if (s.answerlyStealthActive)    applyStealthState(true);
  });

})();
} // end guard
