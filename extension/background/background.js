// ── Background Service Worker ────────────────────────────────────────────────
// Responsibilities:
//  1. Route messages between popup and content scripts
//  2. Capture visible tab screenshots (captureVisibleTab requires background)
//  3. Re-inject content scripts on navigation if needed

const BACKEND_URL = 'https://answerly-ai-backend.onrender.com';

// Fallback only. The server is the authority on the daily cap and reports it as
// quizLimit / screenshotLimit; this is used solely when a response predates
// those fields. It was previously hardcoded in three separate places, so
// changing the cap meant editing the backend, the popup and the worker in
// lockstep - and whichever shipped second showed students the wrong number.
const DEFAULT_DAILY_LIMIT = 200;


// ── Usage persistence helper ─────────────────────────────────────────────────
// Tracks usage client-side by incrementing a local counter on every successful
// solve. Completely independent of backend state — Render restarts, resets, or
// redeploys have zero effect on the displayed bars.
// Resets automatically at midnight (date change).
function incrementLocalUsage(code, type, remaining) {
  if (!code) return;
  const today   = new Date().toISOString().slice(0, 10);
  const usageKey = `answerlyUsage_${code}`;
  const qLimit  = (remaining && remaining.quizLimit)       || DEFAULT_DAILY_LIMIT;
  const sLimit  = (remaining && remaining.screenshotLimit) || DEFAULT_DAILY_LIMIT;

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

// The student's own uploaded notes, sent alongside fileContext rather than only
// inside it. The backend trusts a course's notes about its own subject while
// still distrusting whatever the quiz page supplied; merged into one field it
// could not tell the two apart. fileContext is still sent unchanged, so an
// older backend behaves exactly as it does today.
function notesOnly(uploaded) {
  return (typeof uploaded === 'string' && uploaded.trim()) ? uploaded : undefined;
}

// Only what the quiz page itself supplied. The student's uploaded notes now
// travel in notesContext, where the backend can trust them; sending them here
// as well would put two contradictory instructions about the same text in one
// prompt — trust it, and ignore it.
function quizOnly(quizContext) {
  return quizContext ? 'QUIZ CONTEXT / INSTRUCTIONS:\n' + quizContext : undefined;
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

// ── Survive a backend restart ────────────────────────────────────────────────
// The backend auto-deploys on push and refuses connections for 30-60 seconds
// while it restarts. With no retry at all, every solve attempted in that
// window reached the student as "Network error - is the backend running?" and
// cost them that answer. Two deploys three minutes apart on 2026-10-20 did
// exactly that to a customer sitting an exam, who reported it as happening
// "once every 5-7 questions" - two restart windows, not a flaky connection.
//
// Only a network-level rejection is retried. An HTTP response, even an error
// one, carries a real answer from the server - a usage limit, a dead code -
// and repeating that request would be wrong. An AbortError has already waited
// the full timeout, so retrying only makes the student wait twice.
//
// Four attempts spread over about 19 seconds, which covers a typical restart
// without leaving the student staring at a spinner if the backend is genuinely
// down. The keep-alive ping that wraps these calls stays running throughout,
// so the service worker is not suspended mid-wait.
const RETRY_BACKOFF_MS = [2000, 5000, 12000];

async function fetchWithRetry(url, opts, ms = 75000) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetchWithTimeout(url, opts, ms);
    } catch (err) {
      lastErr = err;
      if (err?.name === 'AbortError') throw err;
      const wait = RETRY_BACKOFF_MS[attempt];
      if (wait === undefined) break;
      console.warn('[Answerly] request failed, retrying in ' + wait + 'ms:', err?.message || err);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ── Privacy Guard: early injection via dynamic content script ────────────────
// Registered dynamically so it only runs when the user toggles Privacy Guard on.
// world: MAIN + runAt: document_start = overrides land before page scripts.
async function registerPrivacyGuardScript() {
  const spec = {
      id: 'answerly-privacy-guard',
      matches: ['<all_urls>'],
      // YouTube is excluded outright. The guard swallows fullscreenchange,
      // webkitfullscreenchange and resize so a quiz page cannot log them, and
      // YouTube's player listens for exactly those to size the video - so with
      // the guard on, clicking fullscreen did nothing. Reported 2026-10-23.
      //
      // Nothing is lost by skipping it: there is no Canvas quiz on youtube.com,
      // and excluding the embed domain too means a YouTube video embedded in a
      // Canvas page still goes fullscreen normally.
      excludeMatches: [
        '*://*.youtube.com/*',
        '*://youtube.com/*',
        '*://*.youtube-nocookie.com/*',
      ],
      js: ['content/privacyGuard.js'],
      runAt: 'document_start',
      world: 'MAIN',
      // Every frame, not just the top one. New Quizzes can still be served
      // inside the quiz-lti iframe, and the logging calls are made from
      // inside that frame — guarding only the top document left them
      // unblocked while the solver (allFrames: true) worked fine, so the
      // guard looked switched on and wasn't. The script is idempotent
      // (__answerlyPGInstalled) and only intercepts the Canvas event URLs
      // in BLOCKED, so extra frames cost nothing.
      allFrames: true,
  };

  // A registration made through registerContentScripts persists across browser
  // restarts AND extension updates, and registering an id that already exists
  // throws. That throw used to be swallowed here, so anyone upgrading kept the
  // spec they were first registered with: the YouTube exclusion above would
  // have reached nobody who already had the previous version installed. The
  // only way out was toggling Privacy Guard off and on, which unregisters
  // first - and no one would think to do that.
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [spec.id] });
    if (existing && existing.length) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
    return;
  } catch {}

  // Fall back to a clean re-add, so a stale or malformed registration cannot
  // pin a user to an old spec.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [spec.id] });
    await chrome.scripting.registerContentScripts([spec]);
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
          await fetchWithRetry(`${BACKEND_URL}/api/solve-outcome`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ solveId: message.solveId, matched: !!message.matched, detail: message.detail }),
          }, 10000);
        } catch { /* diagnostics are best-effort */ }
      });
      return false;
    }

    // Reports questions the gate DECLINED to send. Fire-and-forget, same rules
    // as REPORT_OUTCOME: a diagnostic must never be able to break a solve.
    case 'REPORT_SKIPPED': {
      chrome.storage.local.get('answerlySession', async (result) => {
        const token = result.answerlySession?.token;
        if (!token) return;
        try {
          await fetchWithRetry(`${BACKEND_URL}/api/solve-skipped`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
              quizTitle: message.quizTitle,
              count: message.count,
              reason: message.reason,
            }),
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
          await fetchWithRetry(`${BACKEND_URL}/api/scores/report`, {
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
        const fileContext = quizOnly(message.quizContext);
        const notesContext = notesOnly(result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithRetry(`${BACKEND_URL}/api/solve-question`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ question: message.question, options: message.options, blankContext: message.blankContext, isMultiSelect: message.isMultiSelect, blankCount: message.blankCount, fileContext, notesContext, quizTitle: message.quizTitle, relatedQuestions: message.relatedQuestions }),
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
            sendResponse({ hint: data.hint, answer: data.answer, answerParts: data.answerParts, answerIndexes: data.answerIndexes, remaining: data.remaining, solveId: data.solveId });
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
        const fileContext = quizOnly(message.quizContext);
        const notesContext = notesOnly(result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithRetry(`${BACKEND_URL}/api/solve-matching`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ question: message.question, rows: message.rows, fileContext, notesContext, quizTitle: message.quizTitle, relatedQuestions: message.relatedQuestions }),
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
        const fileContext = undefined;   // notes now travel in notesContext
        const notesContext = notesOnly(result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        if (!message.image) { sendResponse({ error: 'No image provided' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithRetry(`${BACKEND_URL}/api/solve-screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            // `images` carries the rest of a question that ran off the bottom of
            // the screen. The backend already reads a list as one question; this
            // relay was simply dropping it, so only the visible part was ever
            // sent and rows below the fold came back unanswered.
            body: JSON.stringify({ image: message.image, images: message.images, context: message.questionText, stealth: true, fileContext, notesContext, quizTitle: message.quizTitle }),
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
        const fileContext = undefined;   // notes now travel in notesContext
        const notesContext = notesOnly(result.answerlyContextFile?.context);
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        keepAliveStart();
        try {
          const res = await fetchWithRetry(`${BACKEND_URL}/api/solve-screenshot`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ image: message.image, images: message.images, context: message.context, fileContext, notesContext, quizTitle: message.quizTitle }),
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
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/privacyGuard.js'], world: 'MAIN' });
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

// ── Keyboard shortcut: toggle the Screenshot Tool ────────────────────────────
// Registered LAST, and behind a guard, on purpose. chrome.commands is absent in
// some contexts, and an unguarded chrome.commands.onCommand throws at the top
// level of this file — which killed every listener registered below it,
// including the message router. That is what broke CAPTURE_SCREENSHOT and made
// the screenshot tool stop responding after this shortcut was added.
let ssHotkeyAt = 0;
if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-screenshot') return;

    // Holding the key repeats the command, which toggled the widget straight
    // back off again and read as the tool "turning on twice" and glitching.
    const now = Date.now();
    if (now - ssHotkeyAt < 400) return;
    ssHotkeyAt = now;

    const stored = await new Promise(r => chrome.storage.local.get([
      'answerlyScreenshotActive', 'answerlySession',
    ], r));
    if (!stored.answerlySession?.code) return;
    const nowActive = !stored.answerlyScreenshotActive;

    // Stealth is always cleared here: this shortcut is the NORMAL screenshot
    // tool. A stealth flag left on from an earlier session hid the widget the
    // instant it was built, so the key looked like it did nothing at all.
    await new Promise(r => chrome.storage.local.set({
      answerlyScreenshotActive: nowActive,
      answerlyScreenshotStealthActive: false,
    }, r));

    if (nowActive) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.startsWith('http')) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/screenshotTool.js'] });
        chrome.tabs.sendMessage(tab.id, { type: 'SS_STEALTH_OFF' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, { type: 'SCREENSHOT_TOOL_ON' }).catch(() => {});
      } catch { /* tab not injectable */ }
      return;
    }

    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'SCREENSHOT_TOOL_OFF' }); } catch {}
    }
  });
}
