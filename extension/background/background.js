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
  const qLimit  = remaining?.quizLimit       || 100;
  const sLimit  = remaining?.screenshotLimit || 100;

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

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

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

    // Popup requests the current auth token (forwarded to solve endpoints)
    case 'GET_AUTH_TOKEN': {
      chrome.storage.local.get('answerlySession', (result) => {
        sendResponse({ token: result.answerlySession?.token || null });
      });
      return true;
    }

    // Relay solve-question request from content script through to backend
    case 'SOLVE_QUESTION': {
      chrome.storage.local.get('answerlySession', async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        try {
          const res = await fetch(`${BACKEND_URL}/api/solve-question`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ question: message.question, options: message.options, blankContext: message.blankContext }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'quiz', data.remaining);
            sendResponse({ hint: data.hint, answer: data.answer, remaining: data.remaining });
          }
        } catch (err) {
          sendResponse({ error: 'Network error — is the backend running?' });
        }
      });
      return true;
    }

    // Relay solve-screenshot request from content script through to backend
    case 'SOLVE_SCREENSHOT': {
      chrome.storage.local.get('answerlySession', async (result) => {
        const token = result.answerlySession?.token;
        const code  = result.answerlySession?.code;
        if (!token) { sendResponse({ error: 'Not logged in' }); return; }
        try {
          const res = await fetch(`${BACKEND_URL}/api/solve-screenshot`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ image: message.image, context: message.context }),
          });
          const data = await res.json();
          if (!res.ok) {
            sendResponse({ error: data.error || 'Server error', limitReached: data.limitReached });
          } else {
            incrementLocalUsage(code, 'screenshot', data.remaining);
            sendResponse({ response: data.response, remaining: data.remaining });
          }
        } catch (err) {
          sendResponse({ error: 'Network error — is the backend running?' });
        }
      });
      return true;
    }
  }
});

// ── Re-inject content scripts after navigation ────────────────────────────────
// Handles full page reloads and Canvas paginated quiz navigation (Next button)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';
  // Match any Canvas domain (not just instructure.com)
  if (!/\/courses\/\d+\/(quizzes|assignments)/.test(url)) return;

  chrome.storage.local.get(['answerlyQuizActive', 'answerlyScreenshotActive', 'answerlyStealthActive'], async (stored) => {
    try {
      // Re-inject scripts first, then send activation messages
      if (stored.answerlyQuizActive) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/quizSolver.js'] });
        await chrome.tabs.sendMessage(tabId, { type: 'QUIZ_SOLVER_ON' });
      }
      if (stored.answerlyScreenshotActive) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/screenshotTool.js'] });
        await chrome.tabs.sendMessage(tabId, { type: 'SCREENSHOT_TOOL_ON' });
      }
      if (stored.answerlyStealthActive) {
        await chrome.tabs.sendMessage(tabId, { type: 'STEALTH_ON' });
      }
    } catch (err) {
      // Tab may not be ready yet — ignore
    }
  });
});
