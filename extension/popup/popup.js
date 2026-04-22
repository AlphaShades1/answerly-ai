// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_URL = 'https://answerly-ai-backend.onrender.com';

// ── State ─────────────────────────────────────────────────────────────────────
let currentSession   = null; // { token, code, expiresAt }
let quizActive       = false;
let screenshotActive = false;
let stealthActive    = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const viewActivate = document.getElementById('view-activate');
const viewMain     = document.getElementById('view-main');

const codeInput      = document.getElementById('code-input');
const activateError  = document.getElementById('activate-error');
const btnActivate    = document.getElementById('btn-activate');
const btnBuy         = document.getElementById('btn-buy');

const btnProfile      = document.getElementById('btn-profile');
const profileDropdown = document.getElementById('profile-dropdown');
const profileCode     = document.getElementById('profile-code');
const profileExpiry   = document.getElementById('profile-expiry');
const btnDeactivate   = document.getElementById('btn-deactivate');

const btnMenu      = document.getElementById('btn-menu');
const menuDropdown = document.getElementById('menu-dropdown');
const btnClose     = document.getElementById('btn-close');

const notCanvasNotice = document.getElementById('not-canvas-notice');
const btnQuizSolver   = document.getElementById('btn-quiz-solver');
const quizLabel       = document.getElementById('quiz-label');
const btnScreenshot   = document.getElementById('btn-screenshot');
const screenshotLabel = document.getElementById('screenshot-label');

const usageBars         = document.getElementById('usage-bars');
const usageQuizBar      = document.getElementById('usage-quiz-bar');
const usageQuizText     = document.getElementById('usage-quiz-text');
const usageScreenBar    = document.getElementById('usage-screenshot-bar');
const usageScreenText   = document.getElementById('usage-screenshot-text');

const btnStealth = document.getElementById('btn-stealth');
const stealthRow = document.getElementById('stealth-row');

// ── Helpers ───────────────────────────────────────────────────────────────────
function showView(id) {
  ['view-activate', 'view-main', 'view-loading'].forEach(v => {
    document.getElementById(v)?.classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
}

function formatCode(raw) {
  // Strip everything except alphanumeric, uppercase
  let clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Remove leading ANS prefix if user typed it
  if (clean.startsWith('ANS')) clean = clean.slice(3);
  // Chunk into groups of 4
  const chunks = clean.match(/.{1,4}/g) || [];
  return 'ANS-' + chunks.slice(0, 3).join('-');
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Wake up Render server immediately (free tier sleeps after inactivity).
  // By the time the user types their code and clicks Activate, it'll be ready.
  fetch(`${BACKEND_URL}/health`).catch(() => {});
  const stored = await chrome.storage.local.get([
    'answerlySession', 'answerlyQuizActive', 'answerlyScreenshotActive', 'answerlyStealthActive'
  ]);

  if (stored.answerlySession) {
    const payload = parseJwt(stored.answerlySession.token);
    const tokenValid = payload && payload.exp * 1000 > Date.now();

    if (tokenValid) {
      // ── Show UI immediately from local token — no network wait ──────────
      currentSession   = stored.answerlySession;
      quizActive       = !!stored.answerlyQuizActive;
      screenshotActive = !!stored.answerlyScreenshotActive;
      stealthActive    = !!stored.answerlyStealthActive;
      await renderMain();
      showView('view-main');

      // ── Verify in background — kick out only if server says invalid ─────
      fetch(`${BACKEND_URL}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${stored.answerlySession.token}` }
      }).then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.codeExpired || res.status === 401) {
            await chrome.storage.local.remove(['answerlySession','answerlyQuizActive','answerlyScreenshotActive','answerlyStealthActive']);
            currentSession = null;
            showView('view-activate');
          }
        }
      }).catch(() => {
        // Network error / Render sleeping — keep showing UI, user is fine
      });

      return;
    }

    // Token expired locally — clear and show activation
    await chrome.storage.local.remove(['answerlySession', 'answerlyQuizActive', 'answerlyScreenshotActive', 'answerlyStealthActive']);
  }

  showView('view-activate');
}

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

// ── Render main view ──────────────────────────────────────────────────────────
async function renderMain() {
  profileCode.textContent   = currentSession.code;
  profileExpiry.textContent = 'Active until ' + formatDate(currentSession.expiresAt);

  renderToolBtn(btnQuizSolver, quizLabel, quizActive, 'QUIZ SOLVER');
  renderToolBtn(btnScreenshot, screenshotLabel, screenshotActive, 'SCREENSHOT TOOL');
  renderStealthBtn();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url  = tabs[0]?.url || '';
  const isCanvas = /\/courses\/\d+\/(quizzes|assignments)/.test(url);
  notCanvasNotice.classList.toggle('hidden', isCanvas);

  // Load usage for THIS specific code (per-code storage so switching accounts is correct)
  const usageKey = 'answerlyUsage_' + currentSession.code;
  const storedUsage = await chrome.storage.local.get(usageKey);
  const today = new Date().toISOString().slice(0, 10);
  const stored = storedUsage[usageKey];

  if (stored?.date === today) {
    // Local data is fresh — use it immediately (no network needed)
    updateUsageBars(stored);
  } else {
    // No local data for today (reinstall, new day, or first use) —
    // fetch real usage from server so we never show a fake 100/100
    updateUsageBars(null); // optimistic default while fetching
    fetch(`${BACKEND_URL}/api/auth/usage`, {
      headers: { 'Authorization': `Bearer ${currentSession.token}` },
    })
      .then(r => r.json())
      .then(data => {
        if (data.remaining) {
          // Calculate actual uses from server, then apply against our 150 limit.
          // This works even if the deployed backend still reports an old limit.
          const quizUsed   = (data.remaining.quizLimit   || 150) - (data.remaining.quiz       ?? 0);
          const screenUsed = (data.remaining.screenshotLimit || 150) - (data.remaining.screenshot ?? 0);
          const entry = {
            quiz:       Math.max(0, 150 - quizUsed),
            screenshot: Math.max(0, 150 - screenUsed),
            date: today,
          };
          chrome.storage.local.set({ [usageKey]: entry });
          updateUsageBars(entry);
        }
      })
      .catch(() => {}); // network fail — keep showing 150/150 as fallback
  }
}

function renderToolBtn(btn, label, active, name) {
  btn.dataset.active = String(active);
  label.textContent  = active ? `DEACTIVATE ${name}` : `ACTIVATE ${name}`;
}

function renderStealthBtn() {
  btnStealth.classList.toggle('active', stealthActive);
  stealthRow.classList.toggle('stealth-disabled', !quizActive);
}

function updateUsageBars(remaining) {
  const qRem   = remaining?.quiz       ?? 150;
  const sRem   = remaining?.screenshot ?? 150;
  const qLimit = 150;
  const sLimit = 150;

  const qPct = Math.max(0, Math.min(100, (qRem / qLimit) * 100));
  const sPct = Math.max(0, Math.min(100, (sRem / sLimit) * 100));

  usageQuizBar.style.width    = qPct + '%';
  usageScreenBar.style.width  = sPct + '%';
  usageQuizText.textContent   = `${qRem}/${qLimit}`;
  usageScreenText.textContent = `${sRem}/${sLimit}`;

  // Turn bar red when low
  usageQuizBar.style.background   = qRem <= 10 ? '#f05454' : qRem <= 30 ? '#f0a054' : '#7c5cfc';
  usageScreenBar.style.background = sRem <= 10 ? '#f05454' : sRem <= 30 ? '#f0a054' : '#7c5cfc';
}


// ── Activation ────────────────────────────────────────────────────────────────
// Auto-format code input as user types
codeInput.addEventListener('input', () => {
  const pos = codeInput.selectionStart;
  const raw  = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const chunks = raw.match(/.{1,4}/g) || [];
  // Build formatted: ANS-XXXX-XXXX-XXXX
  let formatted = '';
  if (raw.length > 0) {
    const withoutPrefix = raw.startsWith('ANS') ? raw.slice(3) : raw;
    const parts = withoutPrefix.match(/.{1,4}/g) || [];
    formatted = 'ANS-' + parts.slice(0, 3).join('-');
  }
  codeInput.value = formatted;
});

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnActivate.click();
});

btnActivate.addEventListener('click', async () => {
  const raw  = codeInput.value.trim();
  if (!raw) { showActivateError('Please enter your activation code.'); return; }

  activateError.classList.add('hidden');
  btnActivate.disabled = true;
  btnActivate.textContent = 'Activating…';

  try {
    const res  = await fetch(`${BACKEND_URL}/api/auth/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: raw }),
    });
    const data = await res.json();

    if (!res.ok) {
      showActivateError(data.error || 'Activation failed.');
      return;
    }

    currentSession = { token: data.token, code: data.code, expiresAt: data.expiresAt };
    await chrome.storage.local.set({ answerlySession: currentSession });
    await renderMain();
    showView('view-main');
  } catch {
    showActivateError('Cannot reach server. Check your connection.');
  } finally {
    btnActivate.disabled = false;
    btnActivate.textContent = 'Activate';
  }
});

function showActivateError(msg) {
  activateError.textContent = msg;
  activateError.classList.remove('hidden');
}

btnBuy.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://buy.stripe.com/9B6aEP1Pi4CZ6CP17Y67S00' });
});

// ── Profile dropdown ──────────────────────────────────────────────────────────
btnProfile.addEventListener('click', (e) => {
  e.stopPropagation();
  menuDropdown.classList.add('hidden');
  profileDropdown.classList.toggle('hidden');
});

btnDeactivate.addEventListener('click', async () => {
  // Turn off active tools on the page before clearing session
  if (quizActive)       await sendToActiveTab({ type: 'QUIZ_SOLVER_OFF' });
  if (screenshotActive) await sendToActiveTab({ type: 'SCREENSHOT_TOOL_OFF' });

  currentSession   = null;
  quizActive       = false;
  screenshotActive = false;
  stealthActive    = false;
  await chrome.storage.local.remove(['answerlySession','answerlyQuizActive','answerlyScreenshotActive','answerlyStealthActive']);
  profileDropdown.classList.add('hidden');
  codeInput.value = '';
  showView('view-activate');
});

// ── Menu dropdown ─────────────────────────────────────────────────────────────
btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  profileDropdown.classList.add('hidden');
  menuDropdown.classList.toggle('hidden');
});

document.getElementById('menu-subscription').addEventListener('click', () => {
  menuDropdown.classList.add('hidden');
  chrome.tabs.create({ url: 'https://buy.stripe.com/9B6aEP1Pi4CZ6CP17Y67S00' });
});

document.getElementById('menu-manage').addEventListener('click', () => {
  menuDropdown.classList.add('hidden');
  chrome.tabs.create({ url: 'https://billing.stripe.com/p/login/9B6aEP1Pi4CZ6CP17Y67S00' });
});

document.getElementById('menu-help').addEventListener('click', () => {
  menuDropdown.classList.add('hidden');
  chrome.tabs.create({ url: 'mailto:AnswerlyAISupport@gmail.com' });
});


btnClose.addEventListener('click', () => window.close());

// ── Script injection ──────────────────────────────────────────────────────────
async function injectScript(file) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
  } catch (err) {
    console.warn('Answerly AI: injection failed', err.message);
  }
}

async function sendToActiveTab(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, message); } catch {}
}

// ── Tool toggles ──────────────────────────────────────────────────────────────
btnQuizSolver.addEventListener('click', async () => {
  quizActive = !quizActive;
  renderToolBtn(btnQuizSolver, quizLabel, quizActive, 'QUIZ SOLVER');
  await chrome.storage.local.set({ answerlyQuizActive: quizActive });
  if (quizActive) {
    await injectScript('content/quizSolver.js');
    await sendToActiveTab({ type: 'QUIZ_SOLVER_ON' });
  } else {
    // Turn off stealth when quiz solver is deactivated
    if (stealthActive) {
      stealthActive = false;
      await chrome.storage.local.set({ answerlyStealthActive: false });
      await sendToActiveTab({ type: 'STEALTH_OFF' });
    }
    await sendToActiveTab({ type: 'QUIZ_SOLVER_OFF' });
  }
  renderStealthBtn();
});

document.getElementById('btn-solve-all').addEventListener('click', async () => {
  const label = document.getElementById('solve-all-label');
  label.textContent = 'SOLVING…';
  await injectScript('content/quizSolver.js');
  await sendToActiveTab({ type: 'SOLVE_ALL' });
  setTimeout(() => { label.textContent = 'SOLVE ALL QUESTIONS'; }, 2000);
});

btnScreenshot.addEventListener('click', async () => {
  screenshotActive = !screenshotActive;
  renderToolBtn(btnScreenshot, screenshotLabel, screenshotActive, 'SCREENSHOT TOOL');
  await chrome.storage.local.set({ answerlyScreenshotActive: screenshotActive });
  if (screenshotActive) {
    await injectScript('content/screenshotTool.js');
    await sendToActiveTab({ type: 'SCREENSHOT_TOOL_ON' });
  } else {
    await sendToActiveTab({ type: 'SCREENSHOT_TOOL_OFF' });
  }
});


// ── Stealth toggle ────────────────────────────────────────────────────────────
btnStealth.addEventListener('click', async () => {
  stealthActive = !stealthActive;
  renderStealthBtn();
  await chrome.storage.local.set({ answerlyStealthActive: stealthActive });
  await sendToActiveTab({ type: stealthActive ? 'STEALTH_ON' : 'STEALTH_OFF' });
});

// ── Review ────────────────────────────────────────────────────────────────────
document.getElementById('btn-review').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chromewebstore.google.com/detail/answerly-ai-%E2%80%94-canvas-home/gmekadimanglmacabjkmaigckocobnnc/reviews' });
});

// ── Customize ─────────────────────────────────────────────────────────────────
document.getElementById('btn-customize').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/customize.html') });
});


// ── Live usage bar updates ────────────────────────────────────────────────────
// When background.js saves new usage to storage, update the bars immediately
// Only update if the changed key matches the currently logged-in code
chrome.storage.onChanged.addListener((changes) => {
  if (!currentSession?.code) return;

  // Usage bars
  const usageKey = 'answerlyUsage_' + currentSession.code;
  if (changes[usageKey]?.newValue) {
    updateUsageBars(changes[usageKey].newValue);
  }

  // Screenshot widget closed via its own X button — sync popup button state
  if (changes['answerlyScreenshotActive'] !== undefined) {
    screenshotActive = !!changes['answerlyScreenshotActive'].newValue;
    renderToolBtn(btnScreenshot, screenshotLabel, screenshotActive, 'SCREENSHOT TOOL');
  }
});

init();
