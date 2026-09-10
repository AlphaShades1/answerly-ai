// ── Background Service Worker ────────────────────────────────────────────────
// Responsibilities:
//  1. Route messages between popup and content scripts
//  2. Capture visible tab screenshots (captureVisibleTab requires background)
//  3. Re-inject content scripts on navigation if needed

const BACKEND_URL = 'https://answerly-ai-backend.onrender.com';


// ── Usage persistence helper ─────────────────────────────────────────────────
// Tracks usage client-side by incrementing a local counter on every successful
// solve. Completely independent of backend state — Render restarts, resets, or
// redeploys have zero effect on the displayed bars.
// Resets automatically at midnight (date change).
function incrementLocalUsage(code, type, remaining) {
  if (!code) return;
  const today   = new Date().toISOString().slice(0, 10);
  const usageKey = `answerlyUsage_${code}`;
  const qLimit  = 150;
  const sLimit  = 150;

  chrome.storage.local.get(usageKey, (stored) => {
    const cur      = stored[usageKey];
    const isNewDay = !cur || cur.date !== today;

    const qUsed = isNewDay ? 0 : (cur.quizUsed       || 0);
    const sUsed = isNewDay ? 0 : (cur.screenshotUsed  || 0);

    const newQUsed = type === 'quiz'       ? qUsed + 1 : qUsed;
    const newSUsed = type === 'screenshot' ? sUsed + 1 : sUsed;

    chrome.storage.local.set({ [usageKey]: {
      quizUsed:       newQUsed,
      screenshotUsed: newSUsed,
      quiz:           Math.max(0, qLimit - newQUsed),
      screenshot:     Math.max(0, sLimit - newSUsed),
      quizLimit:      qLimit,
      screenshotLimit: sLimit,
      date:           today,
    }});
  });
}

// ── Service-worker keepalive ─────────────────────────────────────────────────
// An MV3 service worker is terminated after ~30s idle, and a plain fetch() does
// NOT count as activity. On a slow backend (Render cold start) the worker was
// being killed mid-request: sendResponse never fired, so the content script's
// callback never ran and its button stayed locked. That is the "it works, I wait
// a bit, then clicking does nothing until I toggle" bug.
// Calling a chrome API on a timer resets the idle countdown for as long as a
// solve is in flight.
let keepAliveTimer = null;
let keepAliveRefs  = 0;
function keepAliveStart() {
  keepAliveRefs++;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch {}
  }, 20000);
}
function keepAliveStop() {
  keepAliveRefs = Math.max(0, keepAliveRefs - 1);
  if (keepAliveRefs === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Combines the quiz's own description/passages (from the content script) with any
// reference file the user uploaded, into the single fileContext field the backend
// already understands. Returns undefined when both are empty, so a request with
// neither is byte-for-byte identical to before this feature existed.
function mergeContext(quizContext, uploaded) {
  const parts = [];
  if (quizContext) parts.push('QUIZ CONTEXT / INSTRUCTIONS:\n' + quizContext);
  if (uploaded)    parts.push(uploaded);
  return parts.length ? parts.join('\n\n---\n\n') : undefined;
}

// Always resolves or throws — never hangs forever, so the content script always
// gets an answer and can unlock its button.
async function fetchWithTimeout(url, opts, ms = 75000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Privacy Guard: early injection via dynamic content script ────────────────
// Registered dynamically so it only runs when the user toggles Privacy Guard on.
// world: MAIN + runAt: document_start = overrides land before page scripts.
async function registerPrivacyGuardScript() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'answerly-privacy-guard',
      matches: ['<all_urls>'],
      js: ['content/privacyGuard.js'],
      runAt: 'document_start',
      world: 'MAIN',
    }]);
  } catch {}
}
async function unregisterPrivacyGuardScript() {
  try { await chrome.scripting.unregisterContentScripts({ ids: ['answerly-privacy-guard'] }); } catch {}
}
chrome.storage.local.get('answerlyPrivacyGuardActive', (result) => {
  if (result.answerlyPrivacyGuardActive) registerPrivacyGuardScript();
  else unregisterPrivacyGuardScript();
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // Heartbeat from a content script on an open quiz page. Chrome terminates an
    // idle MV3 service worker after ~30s; the next click then had to wake it and
    // could be dropped, which is why everything "worked, then stopped after
    // sitting on the page doing nothing". Answering this keeps the worker alive.
    case 'PING': {
      sendResponse({ ok: true });
      return false;
    }

    // Reports whether an answer actually landed on the page. Fire-and-forget:
    // nothing waits on it and a failure is swallowed, because a diagnostic must
    // never be able to break a solve for a paying student.
    case 'REPORT_OUTCOME': {
      chrome.storage.local.get('answerlySession', async (result) => {
        const token = result.answerlySession?.token;
        if (!token || !message.solveId) return;
        try {
          await fetchWithTimeout(`${BACKEND_URL}/api/solve-outcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ solveId: message.solveId, matched: !!message.matched, detail: message.detail }),
          }, 10000);
        } catch { /* diagnostics are best-effort */ }
      });
      return false;
    }

    case 'PRIVACY_GUARD_TOGGLE': {
      if (message.active) registerPrivacyGuardScript();
      else unregisterPrivacyGuardScript();
      sendResponse({ ok: true });
      return false;
    }

    // Content script requests a screenshot capture
    case 'CAPTURE_SCREENSHOT': {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ error: 'No tab ID available' });
        return false;
      }
      chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ dataUrl });
        }
      });
      return true; // Keep the message channel open for async response
    }

    // A content script detected a submitted quiz's results page and is
    // reporting the score. Fire-and-forget: never surfaces an error to the
    // user, and silently no-ops when logged out.
    case 'REPORT_SCORE': {
      chrome.storage.local.get('answerlySession', async (result) => {
        const token = result.answerlySession?.token;
        if (!token) { sendResponse({ ok: false }); return; }
        try {
          await fetchWithTimeout(`${BACKEND_URL}/api/scores/report`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(message.payload || {}),
          });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
      });
      return true;
    }

    // Popup requests the current auth token (forwarded to solve endpoints)
    case 'GET_AUTH_TOKEN': {
      chrome.storage.local.get('answerlySession', (result) => {
        sendResponse({ token: result.answerlySession?.token || null });
      });
      return true;
    }

    // Relay solve-question request from content script through to backend
    case 'SOLVE_QUESTION': {
      chrome.storage.local.get(['answerlySession', 'answerlyContextFile'], async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        // Quiz description/passages (this page) + any uploaded notes.
        const fileContext = mergeContext(message.quizContext, result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithTimeout(`${BACKEND_URL}/api/solve-question`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ question: message.question, options: message.options, blankContext: message.blankContext, isMultiSelect: message.isMultiSelect, blankCount: message.blankCount, fileContext, quizTitle: message.quizTitle }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'quiz', data.remaining);
            // solveId must be forwarded or outcome reporting cannot work at
            // all: the content script only reports on a solve it can name, so
            // dropping the id here silently disabled the whole diagnostic —
            // it read exactly zero, which looked like nobody had updated yet.
            sendResponse({ hint: data.hint, answer: data.answer, answerParts: data.answerParts, remaining: data.remaining, solveId: data.solveId });
          }
        } catch (err) {
          sendResponse({ error: err?.name === 'AbortError' ? 'Timed out — try again.' : 'Network error — is the backend running?' });
        } finally {
          keepAliveStop();
        }
      });
      return true;
    }

    // Relay solve-matching request (matching/dropdown questions with shared options)
    case 'SOLVE_MATCHING': {
      chrome.storage.local.get(['answerlySession', 'answerlyContextFile'], async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        const fileContext = mergeContext(message.quizContext, result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithTimeout(`${BACKEND_URL}/api/solve-matching`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ question: message.question, rows: message.rows, fileContext, quizTitle: message.quizTitle }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'quiz', data.remaining);
            sendResponse({ answers: data.answers, remaining: data.remaining, solveId: data.solveId });
          }
        } catch (err) {
          sendResponse({ error: err?.name === 'AbortError' ? 'Timed out — try again.' : 'Network error — is the backend running?' });
        } finally {
          keepAliveStop();
        }
      });
      return true;
    }

    // Stealth screenshot: content script sends a pre-cropped image → backend returns answer
    case 'SOLVE_SCREENSHOT_STEALTH': {
      chrome.storage.local.get(['answerlySession', 'answerlyContextFile'], async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        const fileContext = result.answerlyContextFile?.context; // uploaded reference notes
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        if (!message.image) { sendResponse({ error: 'No image provided' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithTimeout(`${BACKEND_URL}/api/solve-screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ image: message.image, context: message.questionText, stealth: true, fileContext, quizTitle: message.quizTitle }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'screenshot', data.remaining);
            sendResponse({ answer: data.answer, answerText: data.answerText, remaining: data.remaining, solveId: data.solveId });
          }
        } catch (err) {
          sendResponse({ error: err?.name === 'AbortError' ? 'Timed out — try again.' : 'Network error — is the backend running?' });
        } finally {
          keepAliveStop();
        }
      });
      return true;
    }

    // Relay solve-screenshot request from content script through to backend
    case 'SOLVE_SCREENSHOT': {
      chrome.storage.local.get(['answerlySession', 'answerlyContextFile'], async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        const fileContext = result.answerlyContextFile?.context; // uploaded reference notes
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithTimeout(`${BACKEND_URL}/api/solve-screenshot`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ image: message.image, context: message.context, fileContext, quizTitle: message.quizTitle }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'screenshot', data.remaining);
            sendResponse({ response: data.response, remaining: data.remaining, solveId: data.solveId });
          }
        } catch (err) {
          sendResponse({ error: err?.name === 'AbortError' ? 'Timed out — try again.' : 'Network error — is the backend running?' });
        } finally {
          keepAliveStop();
        }
      });
      return true;
    }
  }
});

// ── Inject screenshot tool when switching tabs ──────────────────────────────
// tabs.onUpdated only fires on page loads. When the user switches to an already-
// loaded tab, the screenshot tool won't appear unless we inject it here.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.storage.local.get('answerlyScreenshotActive', (stored) => {
    if (!stored.answerlyScreenshotActive) return;
    chrome.tabs.get(tabId, async (tab) => {
      if (chrome.runtime.lastError) return;
      const url = tab.url || '';
      if (!url.startsWith('http')) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/screenshotTool.js'] });
        chrome.tabs.sendMessage(tabId, { type: 'ANSWERLY_SYNC' }).catch(() => {});
      } catch {}
    });
  });
});

// ── Re-inject content scripts after navigation ────────────────────────────────
// Handles full page reloads and Canvas paginated quiz navigation (Next button).
// Screenshot tool re-injects on ANY website; quiz/new-quiz solvers are Canvas-only.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  const isCanvas = /\/courses\/\d+/.test(url);

  chrome.storage.local.get([
    'answerlyQuizActive', 'answerlyScreenshotActive',
    'answerlyQuizStealthActive', 'answerlyScreenshotStealthActive',
    'answerlyPrivacyGuardActive'
  ], async (stored) => {
    // Privacy Guard: handled by dynamic content script (document_start),
    // but belt-and-braces re-inject on Canvas pages.
    if (isCanvas && stored.answerlyPrivacyGuardActive) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/privacyGuard.js'], world: 'MAIN' });
      } catch { /* tab not injectable */ }
    }

    // ── Canvas-only: quiz solver + New Quizzes ──────────────────────────────
    if (isCanvas) {
      const wantSolver = !!stored.answerlyQuizActive;
      const wantCam = !!(stored.answerlyScreenshotActive && stored.answerlyScreenshotStealthActive);

      if (wantSolver || wantCam) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content/quizSolver.js'] });
          chrome.tabs.sendMessage(tabId, { type: 'ANSWERLY_SYNC' }).catch(() => {});
        } catch { /* tab not injectable */ }
      }

      if (wantSolver || wantCam) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files:  ['content/newQuizSolver.js'],
          });
          chrome.tabs.sendMessage(tabId, { type: 'ANSWERLY_SYNC' }).catch(() => {});
        } catch { /* quiz-lti frame may not be present — silently skip */ }
      }
    }

    // ── Screenshot tool: works on ANY website ───────────────────────────────
    if (stored.answerlyScreenshotActive) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/screenshotTool.js'] });
        chrome.tabs.sendMessage(tabId, { type: 'ANSWERLY_SYNC' }).catch(() => {});
      } catch { /* tab not ready — ignore */ }
    }
  });
});
