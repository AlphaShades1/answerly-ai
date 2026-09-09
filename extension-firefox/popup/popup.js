// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_URL = 'https://answerly-ai-backend.onrender.com';

// ── State ─────────────────────────────────────────────────────────────────────
let currentSession          = null; // { token, code, expiresAt }
let quizActive              = false;
let screenshotActive        = false;
let quizStealthActive       = false;
let screenshotStealthActive = false;
let privacyGuardActive      = false;

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
const contextSection    = document.getElementById('context-file-section');
const btnUploadContext  = document.getElementById('btn-upload-context');
const contextFileInput  = document.getElementById('context-file-input');
const contextFileActive = document.getElementById('context-file-active');
const contextFileName   = document.getElementById('context-file-name');
const btnClearContext   = document.getElementById('btn-clear-context');
const contextStatus     = document.getElementById('context-status');

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

const btnQuizStealth  = document.getElementById('btn-quiz-stealth');
const quizStealthRow  = document.getElementById('quiz-stealth-row');
const btnSsStealth    = document.getElementById('btn-ss-stealth');
const ssStealthRow    = document.getElementById('ss-stealth-row');
const btnPrivacyGuard = document.getElementById('btn-privacy-guard');

// ── Helpers ───────────────────────────────────────────────────────────────────
function showView(id) {
  ['view-activate', 'view-main', 'view-loading', 'view-support'].forEach(v => {
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
// ── "Solve All skipped image questions" notice ────────────────────────────────
// The solver writes answerlySkippedImages whenever a Solve All pass leaves
// image-dependent questions blank. In normal mode the student also sees an
// on-page toast, but in stealth mode nothing is drawn on the quiz page at all —
// so this popup notice is their only way to learn why some answers are missing.
//
// Only recent records are shown. Without the freshness check, a skip from days
// ago would greet the user every time they opened the popup.
const SKIPPED_FRESH_MS = 5 * 60 * 1000;

function renderSkippedImages(rec) {
  const box = document.getElementById('skipped-images-notice');
  const txt = document.getElementById('skipped-images-text');
  if (!box || !txt) return;

  const fresh = rec && rec.count > 0 && (Date.now() - rec.ts) < SKIPPED_FRESH_MS;
  if (!fresh) { box.classList.add('hidden'); return; }

  const n = rec.count;
  txt.innerHTML = n === 1
    ? '<strong>1 question was skipped</strong> because its answer is in an image. Use the <strong>Screenshot Tool</strong> on it.'
    : `<strong>${n} questions were skipped</strong> because their answers are in images. Use the <strong>Screenshot Tool</strong> on them.`;
  box.classList.remove('hidden');
}

async function refreshSkippedImages() {
  const { answerlySkippedImages } = await chrome.storage.local.get('answerlySkippedImages');
  renderSkippedImages(answerlySkippedImages);
}

async function init() {
  // Wake up Render server immediately (free tier sleeps after inactivity).
  // By the time the user types their code and clicks Activate, it'll be ready.
  fetch(`${BACKEND_URL}/health`).catch(() => {});
  const stored = await chrome.storage.local.get([
    'answerlySession', 'answerlyQuizActive', 'answerlyScreenshotActive',
    'answerlyQuizStealthActive', 'answerlyScreenshotStealthActive',
    'answerlyPrivacyGuardActive'
  ]);

  if (stored.answerlySession) {
    const payload = parseJwt(stored.answerlySession.token);
    const tokenValid = payload && payload.exp * 1000 > Date.now();

    if (tokenValid) {
      // ── Show UI immediately from local token — no network wait ──────────
      currentSession          = stored.answerlySession;
      quizActive              = !!stored.answerlyQuizActive;
      screenshotActive        = !!stored.answerlyScreenshotActive;
      // A stealth flag is only real while its parent tool is on. When the tool is
      // off the stealth row is merely greyed out, so a stale `true` stayed hidden
      // from the user and then silently re-armed (hiding the screenshot widget)
      // the moment the tool was switched back on. Normalise it away for good.
      quizStealthActive       = quizActive       && !!stored.answerlyQuizStealthActive;
      screenshotStealthActive = screenshotActive && !!stored.answerlyScreenshotStealthActive;
      privacyGuardActive      = !!stored.answerlyPrivacyGuardActive;
      if (quizStealthActive       !== !!stored.answerlyQuizStealthActive ||
          screenshotStealthActive !== !!stored.answerlyScreenshotStealthActive) {
        await chrome.storage.local.set({
          answerlyQuizStealthActive:       quizStealthActive,
          answerlyScreenshotStealthActive: screenshotStealthActive,
        });
      }
      await renderMain();
      showView('view-main');

      // ── Verify in background — kick out only if server says invalid ─────
      fetch(`${BACKEND_URL}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${stored.answerlySession.token}` }
      }).then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.codeExpired || res.status === 401) {
            // Deactivate any running tools before kicking the user out
            if (quizActive)       await sendToActiveTab({ type: 'QUIZ_SOLVER_OFF' });
            if (screenshotActive) await sendToActiveTab({ type: 'SCREENSHOT_TOOL_OFF' });
            if (screenshotStealthActive) await sendToActiveTab({ type: 'SS_STEALTH_OFF' });
            await chrome.storage.local.remove([
              'answerlySession','answerlyQuizActive','answerlyScreenshotActive',
              'answerlyQuizStealthActive','answerlyScreenshotStealthActive',
              'answerlyPrivacyGuardActive'
            ]);
            currentSession = null;
            quizActive = false; screenshotActive = false;
            quizStealthActive = false; screenshotStealthActive = false;
            privacyGuardActive = false;
            showView('view-activate');
          }
        }
      }).catch(() => {
        // Network error / Render sleeping — keep showing UI, user is fine
      });

      return;
    }

    // Token expired locally — clear and show activation
    await chrome.storage.local.remove([
      'answerlySession', 'answerlyQuizActive', 'answerlyScreenshotActive',
      'answerlyQuizStealthActive', 'answerlyScreenshotStealthActive',
      'answerlyPrivacyGuardActive'
    ]);
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

  // Context-file uploader — available to everyone
  contextSection.classList.remove('hidden');
  const storedCtx = await chrome.storage.local.get('answerlyContextFile');
  if (storedCtx.answerlyContextFile?.fileName) showContextActive(storedCtx.answerlyContextFile.fileName);
  else contextFileActive.classList.add('hidden');

  renderToolBtn(btnQuizSolver, quizLabel, quizActive, 'QUIZ SOLVER');
  renderToolBtn(btnScreenshot, screenshotLabel, screenshotActive, 'SCREENSHOT TOOL');
  renderStealthBtns();
  renderSolveAllBtn();
  btnPrivacyGuard.classList.toggle('active', privacyGuardActive);

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const url  = tabs[0]?.url || '';
  // Hide the "not on Canvas" notice when on a Canvas quiz/assignment page
  // OR when on a quiz-lti page (New Quizzes) directly
  const isCanvas = /\/courses\/\d+\/(quizzes|assignments)/.test(url)
                || url.includes('quiz-lti-iad-prod.instructure.com');
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

function renderStealthBtns() {
  btnQuizStealth.classList.toggle('active', quizStealthActive);
  quizStealthRow.classList.toggle('stealth-disabled', !quizActive);

  btnSsStealth.classList.toggle('active', screenshotStealthActive);
  ssStealthRow.classList.toggle('stealth-disabled', !screenshotActive);
}

function renderSolveAllBtn() {
  const btn   = document.getElementById('btn-solve-all');
  const label = document.getElementById('solve-all-label');
  btn.disabled      = !quizActive;
  btn.style.opacity = quizActive ? '' : '0.4';
  btn.style.cursor  = quizActive ? '' : 'not-allowed';
  if (!quizActive) label.textContent = 'SOLVE ALL QUESTIONS';
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

    currentSession = { token: data.token, code: data.code, expiresAt: data.expiresAt, tier: data.tier || 'base' };
    await chrome.storage.local.set({ answerlySession: currentSession });

    // Some codes are configured server-side (AUTO_ENABLE_CODES on the backend) to
    // come up with every tool already on, so the user types their code and is
    // ready — no walking them through five separate toggles.
    //
    // Deliberately only on activation. These are starting values, not enforced
    // ones: whatever they switch off afterwards stays off, because nothing here
    // runs again until they activate a code.
    //
    // Only the storage flags are written. The background script already re-reads
    // them on every tab update and injects accordingly, so the tools come up on
    // the next Canvas page without the popup reaching into tabs itself.
    if (data.autoEnable) {
      await chrome.storage.local.set({
        answerlyQuizActive:              true,
        answerlyQuizStealthActive:       true,
        answerlyScreenshotActive:        true,
        answerlyScreenshotStealthActive: true,
        answerlyPrivacyGuardActive:      true,
      });
      // Privacy Guard is a dynamically registered content script, so the
      // background has to register it — setting the flag alone is not enough.
      chrome.runtime.sendMessage({ type: 'PRIVACY_GUARD_TOGGLE', active: true }).catch(() => {});
    }

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

document.getElementById('btn-discord-activate').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://discord.gg/uxFXsMgqrE' });
});

// Manage Subscription from the activation screen — opens Stripe's hosted portal
// login page (customer enters their email there; no logged-in session needed).
document.getElementById('btn-manage-activate').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://billing.stripe.com/p/login/9B6aEP1Pi4CZ6CP17Y67S00' });
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

  currentSession          = null;
  quizActive              = false;
  screenshotActive        = false;
  quizStealthActive       = false;
  screenshotStealthActive = false;
  privacyGuardActive      = false;
  chrome.runtime.sendMessage({ type: 'PRIVACY_GUARD_TOGGLE', active: false }).catch(() => {});
  await chrome.storage.local.remove([
    'answerlySession','answerlyQuizActive','answerlyScreenshotActive',
    'answerlyQuizStealthActive','answerlyScreenshotStealthActive',
    'answerlyPrivacyGuardActive'
  ]);
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
  // mailto: doesn't work via chrome.tabs.create — copy address to clipboard instead
  navigator.clipboard.writeText('AnswerlyAISupport@gmail.com').catch(() => {});
});

// ── Pro: context file upload ────────────────────────────────────────────────
// Uploads a reference file (PDF/image/text); backend extracts its text once and
// the extension stores it. quizSolver.js sends that text as context per question.
btnUploadContext.addEventListener('click', () => contextFileInput.click());

contextFileInput.addEventListener('change', async () => {
  const file = contextFileInput.files[0];
  if (!file) return;
  if (file.size > 7 * 1024 * 1024) {
    showContextStatus('File too large (max 7 MB).', true);
    contextFileInput.value = '';
    return;
  }
  showContextStatus('Reading file…', false);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
    const base64 = String(dataUrl).split(',')[1];
    const res = await fetch(`${BACKEND_URL}/api/process-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentSession.token}` },
      body: JSON.stringify({ fileData: base64, mimeType: file.type || 'text/plain', fileName: file.name }),
    });
    const data = await res.json();
    if (!res.ok) { showContextStatus(data.error || 'Upload failed.', true); return; }
    await chrome.storage.local.set({ answerlyContextFile: { fileName: data.fileName, context: data.context } });
    showContextActive(data.fileName);
    showContextStatus('Loaded ✓ — used as context when solving', false);
  } catch {
    showContextStatus('Could not process this file.', true);
  } finally {
    contextFileInput.value = '';
  }
});

btnClearContext.addEventListener('click', async () => {
  await chrome.storage.local.remove('answerlyContextFile');
  contextFileActive.classList.add('hidden');
  showContextStatus('', false);
});

function showContextActive(name) {
  contextFileName.textContent = name;
  contextFileActive.classList.remove('hidden');
}

function showContextStatus(msg, isError) {
  if (!msg) { contextStatus.classList.add('hidden'); return; }
  contextStatus.textContent = msg;
  contextStatus.style.color = isError ? '#f09090' : '#9bdc9b';
  contextStatus.classList.remove('hidden');
}


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

async function injectMainWorldScript(file) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab  = tabs[0];
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file], world: 'MAIN' });
  } catch (err) {
    console.warn('Answerly AI: main-world injection failed', err.message);
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
  // Write the stealth flag too — turning the solver on must never inherit a stale
  // stealth state (that is what made normal mode come back up as stealth).
  await chrome.storage.local.set({
    answerlyQuizActive: quizActive,
    answerlyQuizStealthActive: quizActive && quizStealthActive,
  });
  if (quizActive) {
    await injectScript('content/quizSolver.js');
    await sendToActiveTab({ type: 'QUIZ_SOLVER_ON' });
    // Re-assert BOTH directions so the page can never keep a stale stealth mode
    await sendToActiveTab({ type: quizStealthActive ? 'QUIZ_STEALTH_ON' : 'QUIZ_STEALTH_OFF' });
    if (screenshotStealthActive) await sendToActiveTab({ type: 'SS_STEALTH_ON' });
  } else {
    // Turn off quiz stealth when quiz solver is deactivated
    if (quizStealthActive) {
      quizStealthActive = false;
      await chrome.storage.local.set({ answerlyQuizStealthActive: false });
      await sendToActiveTab({ type: 'QUIZ_STEALTH_OFF' });
    }
    // Do NOT turn off screenshot stealth — it runs independently of quiz solver
    await sendToActiveTab({ type: 'QUIZ_SOLVER_OFF' });
  }
  renderStealthBtns();
  renderSolveAllBtn();
});

document.getElementById('btn-solve-all').addEventListener('click', async () => {
  if (!quizActive) return; // only works when quiz solver is on
  const label = document.getElementById('solve-all-label');
  label.textContent = 'SOLVING…';
  // Drop the previous pass's notice before starting a new one, so a stale count
  // can't sit there looking like it describes the run now in progress. The
  // storage listener hides the box; the solver rewrites it if this pass skips.
  await chrome.storage.local.remove('answerlySkippedImages');
  await injectScript('content/quizSolver.js');
  await sendToActiveTab({ type: 'SOLVE_ALL' });
  // Also trigger New Quizzes solver via storage (iframe can't receive tab messages)
  await chrome.storage.local.set({ answerlyNQSolveAll: Date.now() });
  setTimeout(() => { label.textContent = 'SOLVE ALL QUESTIONS'; }, 2000);
});

btnScreenshot.addEventListener('click', async () => {
  screenshotActive = !screenshotActive;
  renderToolBtn(btnScreenshot, screenshotLabel, screenshotActive, 'SCREENSHOT TOOL');
  // Always write the stealth flag alongside the tool flag so turning the tool on
  // can never silently re-arm a stale stealth state (which hid the widget).
  await chrome.storage.local.set({
    answerlyScreenshotActive: screenshotActive,
    answerlyScreenshotStealthActive: screenshotActive && screenshotStealthActive,
  });
  if (screenshotActive) {
    await injectScript('content/screenshotTool.js');
    await sendToActiveTab({ type: 'SCREENSHOT_TOOL_ON' });
    await sendToActiveTab({ type: screenshotStealthActive ? 'SS_STEALTH_ON' : 'SS_STEALTH_OFF' });
  } else {
    // Turn off screenshot stealth when screenshot tool is deactivated
    if (screenshotStealthActive) {
      screenshotStealthActive = false;
      await chrome.storage.local.set({ answerlyScreenshotStealthActive: false });
    }
    // Broadcast OFF to ALL tabs so no stale widgets remain
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: 'SCREENSHOT_TOOL_OFF' }); } catch {}
    }
  }
  renderStealthBtns();
});


// ── Stealth toggles ───────────────────────────────────────────────────────────
btnQuizStealth.addEventListener('click', async () => {
  if (!quizActive) return; // guard: can't enable without quiz solver on
  quizStealthActive = !quizStealthActive;
  renderStealthBtns();
  await chrome.storage.local.set({ answerlyQuizStealthActive: quizStealthActive });
  await sendToActiveTab({ type: quizStealthActive ? 'QUIZ_STEALTH_ON' : 'QUIZ_STEALTH_OFF' });
});

btnSsStealth.addEventListener('click', async () => {
  if (!screenshotActive) return; // requires Screenshot Tool to be on
  screenshotStealthActive = !screenshotStealthActive;
  renderStealthBtns();
  await chrome.storage.local.set({ answerlyScreenshotStealthActive: screenshotStealthActive });
  if (screenshotStealthActive) {
    // Inject quizSolver.js so it can run screenshot stealth even without quiz solver active
    await injectScript('content/quizSolver.js');
  }
  await sendToActiveTab({ type: screenshotStealthActive ? 'SS_STEALTH_ON' : 'SS_STEALTH_OFF' });
});

// ── Privacy Guard toggle ──────────────────────────────────────────────────
btnPrivacyGuard.addEventListener('click', async () => {
  privacyGuardActive = !privacyGuardActive;
  btnPrivacyGuard.classList.toggle('active', privacyGuardActive);
  await chrome.storage.local.set({ answerlyPrivacyGuardActive: privacyGuardActive });
  chrome.runtime.sendMessage({ type: 'PRIVACY_GUARD_TOGGLE', active: privacyGuardActive }).catch(() => {});
  if (privacyGuardActive) {
    await injectMainWorldScript('content/privacyGuard.js');
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab  = tabs[0];
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => { window.__answerlyPGActive = false; },
        });
      } catch {}
    }
  }
});

// ── Review ────────────────────────────────────────────────────────────────────
document.getElementById('btn-review').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://chromewebstore.google.com/detail/answerly-ai-%E2%80%94-canvas-home/gmekadimanglmacabjkmaigckocobnnc/reviews' });
});

document.getElementById('btn-discord').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://discord.gg/uxFXsMgqrE' });
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

  // Solve All finished and skipped image questions. Updating live matters:
  // the student usually still has the popup open when the pass completes.
  if (changes['answerlySkippedImages'] !== undefined) {
    renderSkippedImages(changes['answerlySkippedImages'].newValue);
  }
});

init();
refreshSkippedImages();

// ── Support / Report-a-Bug chat ───────────────────────────────────────────────
(function initSupport() {
  const thread   = document.getElementById('support-thread');
  const input    = document.getElementById('support-input');
  const sendBtn  = document.getElementById('support-send');
  const backBtn  = document.getElementById('support-back');
  const menuItem = document.getElementById('btn-report');
  const menuDot  = document.getElementById('report-dot');
  if (!thread || !menuItem) return;

  let pollTimer = null;

  function token() { return currentSession && currentSession.token; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch { return ''; }
  }

  function render(messages) {
    if (!messages || !messages.length) {
      thread.innerHTML = '<div class="support-empty">Something not working? Tell us what happened and we\u2019ll fix it fast. Only you can see this chat.</div>';
      return;
    }
    thread.innerHTML = messages.map(m =>
      `<div class="support-msg ${m.from === 'user' ? 'user' : 'owner'}">${esc(m.text)}<span class="support-ts">${fmtTime(m.ts)}</span></div>`
    ).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  async function loadThread() {
    if (!token()) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/messages`, { headers: { 'Authorization': `Bearer ${token()}` } });
      const data = await res.json();
      render(data.thread && data.thread.messages);
      if (menuDot) menuDot.classList.add('hidden');  // opening the chat clears the unread dot
    } catch { /* offline — leave as-is */ }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !token()) return;
    sendBtn.disabled = true;
    // Attach the current page URL as context so the owner knows where the bug was.
    let context = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context = tab && tab.url ? tab.url : '';
    } catch {}
    try {
      const res = await fetch(`${BACKEND_URL}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` },
        body: JSON.stringify({ text, context }),
      });
      const data = await res.json();
      if (data.thread) render(data.thread.messages);
      input.value = '';
      input.style.height = 'auto';
    } catch {
      /* keep the text so they can retry */
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function openSupport() {
    menuDropdown.classList.add('hidden');
    showView('view-support');
    loadThread();
    input.focus();
    clearInterval(pollTimer);
    pollTimer = setInterval(loadThread, 15000);   // pull in owner replies while open
  }
  function closeSupport() {
    clearInterval(pollTimer);
    showView('view-main');
  }

  // Quietly check for an unseen owner reply and light up the menu dot.
  async function checkUnread() {
    if (!token()) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/messages`, { headers: { 'Authorization': `Bearer ${token()}` } });
      const data = await res.json();
      const unseen = data.thread && data.thread.unreadForUser;
      if (menuDot) menuDot.classList.toggle('hidden', !unseen);
    } catch {}
  }

  menuItem.addEventListener('click', openSupport);
  backBtn.addEventListener('click', closeSupport);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 90) + 'px';
  });

  // Check for replies shortly after the popup opens, then every 60s it's open.
  setTimeout(checkUnread, 2500);
  setInterval(checkUnread, 60000);
})();
