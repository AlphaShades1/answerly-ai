const DEFAULTS = {
  accentColor: '#7c5cfc',
  cardBg:      '#1a1a2e',
  cardBorder:  '#7c5cfc',
  answerColor: '#ffffff',
  hintColor:   '#c0c0d8',
  opacity:     100,
  // Same defaults the content scripts fall back to. Without them a student with
  // no saved theme, or anyone who pressed Reset, saw "undefined" in the Buttons
  // field. answerBg is deliberately absent: deriveAnswerBg() works it out from
  // the card, and a fixed default here would put a black box in a light theme.
  buttonColor:  '#a090f0',
  answerWeight: 800,
  // Screenshot drag box, read by all three selection overlays. The defaults
  // are the purple box and red crosshair it always had.
  selectionColor:   '#7c5cfc',
  crosshairColor:   '#ff3b3b',
  selectionOpacity: 100,
};

const PRESETS = {
  default: { accentColor: '#7c5cfc', cardBg: '#1a1a2e', cardBorder: '#7c5cfc', answerBg: '#0f0f1e', buttonColor: '#a090f0', answerColor: '#ffffff', hintColor: '#c0c0d8', opacity: 100 },
  ghost:   { accentColor: '#7c5cfc', cardBg: '#1a1a2e', cardBorder: '#7c5cfc', answerBg: '#0f0f1e', buttonColor: '#a090f0', answerWeight: 800, answerColor: '#ffffff', hintColor: '#c0c0d8', opacity: 0   },
  dark:    { accentColor: '#444466', cardBg: '#000000', cardBorder: '#444466', answerBg: '#000000', buttonColor: '#a090f0', answerWeight: 800, answerColor: '#ffffff', hintColor: '#888899', opacity: 95  },
  green:   { accentColor: '#00ff41', cardBg: '#001a00', cardBorder: '#00ff41', answerBg: '#001a00', buttonColor: '#a090f0', answerWeight: 800, answerColor: '#00ff41', hintColor: '#00cc33', opacity: 100 },
  // Canvas's own palette: #f5f5f5 question headers, #c7cdd1 rules, #2d3b45 body
  // text. Matching them rather than inventing a light theme is what makes the
  // card read as part of the page instead of a pale box sitting on top of it.
  canvas:  { accentColor: '#c7cdd1', cardBg: '#f5f5f5', cardBorder: '#c7cdd1', answerBg: '#ffffff', buttonColor: '#9aa3ab', answerWeight: 500, answerColor: '#6b7780', hintColor: '#9aa3ab', opacity: 100 },
};

let theme = { ...DEFAULTS };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const colorAccent  = document.getElementById('color-accent');
const hexAccent    = document.getElementById('hex-accent');
const colorBg      = document.getElementById('color-bg');
const hexBg        = document.getElementById('hex-bg');
const colorBorder  = document.getElementById('color-border');
const hexBorder    = document.getElementById('hex-border');
const previewReveal = document.getElementById('preview-reveal');
const previewSs     = document.getElementById('preview-ss');
const previewSsBar  = document.getElementById('preview-ss-bar');
const previewSsTitle= document.getElementById('preview-ss-title');
const previewSsWell = document.getElementById('preview-ss-well');
const previewSsField= document.getElementById('preview-ss-field');
const previewSsBtn  = document.getElementById('preview-ss-btn');
const previewSsSend = document.getElementById('preview-ss-send');
const colorButton  = document.getElementById('color-button');
const hexButton    = document.getElementById('hex-button');
const colorAnswerBg = document.getElementById('color-answerbg');
const hexAnswerBg   = document.getElementById('hex-answerbg');
const colorAnswer  = document.getElementById('color-answer');
const hexAnswer    = document.getElementById('hex-answer');
const colorHint    = document.getElementById('color-hint');
const hexHint      = document.getElementById('hex-hint');
const opacitySlider = document.getElementById('opacity-slider');
const opacityVal   = document.getElementById('opacity-val');
const savedMsg     = document.getElementById('saved-msg');
const keybindEnabled = document.getElementById('keybind-enabled');
const keybindCapture = document.getElementById('keybind-capture');
const colorSelection = document.getElementById('color-selection');
const hexSelection   = document.getElementById('hex-selection');
const colorCrosshair = document.getElementById('color-crosshair');
const hexCrosshair   = document.getElementById('hex-crosshair');
const selOpacitySlider = document.getElementById('selection-opacity-slider');
const selOpacityVal    = document.getElementById('selection-opacity-val');
const previewSelBox    = document.getElementById('preview-sel-box');
const previewSelBadge  = document.getElementById('preview-sel-badge');
const previewSelCross  = document.getElementById('preview-sel-cross');

// Preview elements
const previewCard      = document.getElementById('preview-card');
const previewBadge     = document.getElementById('preview-badge');
const previewHint      = document.getElementById('preview-hint');
const previewAnswerBox = document.getElementById('preview-answer-box');
const previewAnswerLbl = document.getElementById('preview-answer-lbl');
const previewAnswerText = document.getElementById('preview-answer-text');
const previewBtnDemo   = document.getElementById('preview-btn-demo');
const previewBtnLabel  = document.getElementById('preview-btn-label');

// ── Load saved theme (keyed to the active code so each account has own theme) ─
let themeKey   = 'answerlyTheme';
let themeReady = false;   // guards against saving to the wrong key before load
chrome.storage.local.get('answerlySession', (sess) => {
  const code = sess.answerlySession?.code;
  if (code) themeKey = 'answerlyTheme_' + code;
  chrome.storage.local.get(themeKey, (s) => {
    if (s[themeKey]) theme = { ...DEFAULTS, ...s[themeKey] };
    themeReady = true;
    applyToUI();
    updatePreview();
  });
});

// ── Screenshot toggle shortcut (read-only, managed by browser commands API) ──
const toggleSsShortcut = document.getElementById('toggle-ss-shortcut');
if (toggleSsShortcut && chrome.commands?.getAll) {
  chrome.commands.getAll((cmds) => {
    const cmd = cmds.find(c => c.name === 'toggle-screenshot');
    if (cmd?.shortcut) toggleSsShortcut.textContent = cmd.shortcut;
    else toggleSsShortcut.textContent = 'Not set';
  });
}

// ── Stealth keybind (global preference) ──────────────────────────────────────
let keybind = { enabled: false, key: '' };
function prettyKey(k) {
  if (!k) return 'Not set';
  if (k === ' ') return 'Space';
  return k.length === 1 ? k.toUpperCase() : k;
}
let keybindReady = false; // guards against overwriting a saved keybind with the default
chrome.storage.local.get('answerlyStealthKeybind', (s) => {
  if (s.answerlyStealthKeybind) keybind = s.answerlyStealthKeybind;
  keybindReady = true;
  keybindEnabled.checked     = !!keybind.enabled;
  keybindCapture.textContent = prettyKey(keybind.key);
});
keybindEnabled.addEventListener('change', () => { keybind.enabled = keybindEnabled.checked; });
let capturingKey = false;
keybindCapture.addEventListener('click', () => {
  capturingKey = true;
  keybindCapture.textContent = 'Press a key…';
});
// Keys that must never be bound. A bare modifier would make every single press
// of it fire a solve (and burn usage); navigation keys break normal page use.
const BAD_KEYBIND_KEYS = [
  'Shift','Control','Alt','Meta','AltGraph','CapsLock','Tab','Enter',
  'ContextMenu','OS','NumLock','ScrollLock','Dead','Unidentified','Process',
  'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End',
];
document.addEventListener('keydown', (e) => {
  if (!capturingKey) return;
  // Ignore (don't preventDefault) so these keys keep their normal behaviour and
  // capture mode stays open for a real key.
  if (BAD_KEYBIND_KEYS.includes(e.key)) return;
  e.preventDefault();
  capturingKey = false;
  if (e.key !== 'Escape') keybind.key = e.key;
  keybindCapture.textContent = prettyKey(keybind.key);
});
// Cancel capture if the user clicks away — otherwise the next keystroke typed
// anywhere in the page gets silently swallowed and bound.
document.addEventListener('mousedown', (e) => {
  if (capturingKey && e.target !== keybindCapture) {
    capturingKey = false;
    keybindCapture.textContent = prettyKey(keybind.key);
  }
});

// ── Screenshot stealth keybind ────────────────────────────────────────────────
// Deliberately a parallel implementation rather than a refactor of the pair
// above: that one is live for every paying user and a shared capture-mode flag
// is the kind of change that breaks it quietly. The two cancel each other for
// free, because each mousedown handler ends capture when the click lands on
// anything that is not its own button.
const ssKeybindEnabled = document.getElementById('ss-keybind-enabled');
const ssKeybindCapture = document.getElementById('ss-keybind-capture');
let ssKeybind = { enabled: false, key: '' };
let ssKeybindReady = false;
let capturingSsKey = false;
chrome.storage.local.get('answerlyScreenshotKeybind', (s) => {
  if (s.answerlyScreenshotKeybind) ssKeybind = s.answerlyScreenshotKeybind;
  ssKeybindReady = true;
  ssKeybindEnabled.checked   = !!ssKeybind.enabled;
  ssKeybindCapture.textContent = prettyKey(ssKeybind.key);
});
ssKeybindEnabled.addEventListener('change', () => { ssKeybind.enabled = ssKeybindEnabled.checked; });
ssKeybindCapture.addEventListener('click', () => {
  capturingSsKey = true;
  ssKeybindCapture.textContent = 'Press a key…';
});
document.addEventListener('keydown', (e) => {
  if (!capturingSsKey) return;
  if (BAD_KEYBIND_KEYS.includes(e.key)) return;
  e.preventDefault();
  capturingSsKey = false;
  if (e.key !== 'Escape') ssKeybind.key = e.key;
  ssKeybindCapture.textContent = prettyKey(ssKeybind.key);
});
document.addEventListener('mousedown', (e) => {
  if (capturingSsKey && e.target !== ssKeybindCapture) {
    capturingSsKey = false;
    ssKeybindCapture.textContent = prettyKey(ssKeybind.key);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// keepPreset: the drag box is not part of any preset, so changing it should not
// un-highlight the preset the cards are still on.
function syncColorPair(colorInput, hexInput, key, keepPreset) {
  colorInput.addEventListener('input', () => {
    hexInput.value = colorInput.value;
    theme[key] = colorInput.value;
    updatePreview();
    if (!keepPreset) clearActivePreset();
  });
  hexInput.addEventListener('input', () => {
    const val = hexInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      colorInput.value = val;
      theme[key] = val;
      updatePreview();
      if (!keepPreset) clearActivePreset();
    }
  });
}

syncColorPair(colorAccent, hexAccent, 'accentColor');
syncColorPair(colorBg,     hexBg,     'cardBg');
syncColorPair(colorBorder, hexBorder, 'cardBorder');
syncColorPair(colorButton, hexButton, 'buttonColor');
syncColorPair(colorAnswerBg, hexAnswerBg, 'answerBg');
syncColorPair(colorAnswer, hexAnswer, 'answerColor');
syncColorPair(colorHint,   hexHint,   'hintColor');
syncColorPair(colorSelection, hexSelection, 'selectionColor', true);
syncColorPair(colorCrosshair, hexCrosshair, 'crosshairColor', true);

selOpacitySlider.addEventListener('input', () => {
  theme.selectionOpacity = parseInt(selOpacitySlider.value);
  selOpacityVal.textContent = theme.selectionOpacity + '%';
  updatePreview();
});

// A theme saved before the drag box settings existed has none of these keys.
function dragBoxOf(t) {
  return {
    selectionColor:   t.selectionColor || DEFAULTS.selectionColor,
    crosshairColor:   t.crosshairColor || DEFAULTS.crosshairColor,
    selectionOpacity: t.selectionOpacity != null ? t.selectionOpacity : DEFAULTS.selectionOpacity,
  };
}

opacitySlider.addEventListener('input', () => {
  theme.opacity = parseInt(opacitySlider.value);
  opacityVal.textContent = theme.opacity + '%';
  updatePreview();
  clearActivePreset();
});



// A theme saved before the Answer box setting existed has no answerBg, and
// showing the old hardcoded dark in the picker would tell the student their
// light theme is fine when the page will render a black box. Derive it the same
// way the content scripts do so the swatch matches what they will actually see.
const DARK_ANSWER_BG = '#0f0f1e';   // the content scripts' default answer box
function deriveAnswerBg(t) {
  if (t && t.answerBg) return t.answerBg;
  const bg = (t && t.cardBg) || DEFAULTS.cardBg;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bg).trim());
  if (!m) return DARK_ANSWER_BG;
  const n = parseInt(m[1], 16);
  const l = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]) > 0.4 ? '#ffffff' : DARK_ANSWER_BG;
}
function applyToUI() {
  colorAccent.value = theme.accentColor || DEFAULTS.accentColor;
  hexAccent.value   = theme.accentColor || DEFAULTS.accentColor;
  colorBg.value     = theme.cardBg;
  hexBg.value       = theme.cardBg;
  colorBorder.value = theme.cardBorder;
  hexBorder.value   = theme.cardBorder;
  const btn = theme.buttonColor || DEFAULTS.buttonColor;
  colorButton.value = btn;
  hexButton.value   = btn;
  theme.answerBg = deriveAnswerBg(theme);
  colorAnswerBg.value = theme.answerBg;
  hexAnswerBg.value   = theme.answerBg;
  colorAnswer.value = theme.answerColor;
  hexAnswer.value   = theme.answerColor;
  colorHint.value   = theme.hintColor;
  hexHint.value     = theme.hintColor;
  opacitySlider.value = theme.opacity;
  opacityVal.textContent = theme.opacity + '%';
  const box = dragBoxOf(theme);
  colorSelection.value = box.selectionColor;
  hexSelection.value   = box.selectionColor;
  colorCrosshair.value = box.crosshairColor;
  hexCrosshair.value   = box.crosshairColor;
  selOpacitySlider.value = box.selectionOpacity;
  selOpacityVal.textContent = box.selectionOpacity + '%';
}


// The Send button's label sits on the accent colour, so white disappears on a
// pale one. Mirrors ssReadableOn() in screenshotTool.js so the preview cannot
// disagree with the real widget.
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const l = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]) > 0.45 ? '#111118' : '#ffffff';
}
function updatePreview() {
  const op = theme.opacity / 100;
  const accent = theme.accentColor || DEFAULTS.accentColor;

  // Button preview
  previewBtnDemo.style.background = accent;
  previewBtnDemo.style.boxShadow  = `0 2px 8px ${accent}88`;
  previewBtnDemo.style.border     = 'none';
  previewBtnDemo.textContent      = '?';
  previewBtnLabel.textContent     = '';

  // Card preview
  previewCard.style.background = theme.cardBg;
  previewCard.style.border = `1px solid ${theme.cardBorder}`;
  previewCard.style.opacity = op;
  previewBadge.style.color = accent;
  previewHint.style.color = theme.hintColor;
  previewAnswerBox.style.background = deriveAnswerBg(theme);
  previewAnswerBox.style.border = `1px solid ${theme.cardBorder}`;
  previewAnswerLbl.style.color = theme.cardBorder;
  previewAnswerText.style.color = theme.answerColor;
  previewAnswerText.style.fontWeight = theme.answerWeight || DEFAULTS.answerWeight;

  const btn   = theme.buttonColor || DEFAULTS.buttonColor;
  const field = deriveAnswerBg(theme);
  previewReveal.style.color = btn;
  previewReveal.style.borderColor = btn;

  // Screenshot tool preview, painted from the same values applySsTheme() uses.
  previewSs.style.background = theme.cardBg;
  previewSs.style.border = '1px solid ' + theme.cardBorder;
  previewSs.style.opacity = op;
  previewSsBar.style.borderBottom = '1px solid ' + theme.cardBorder;
  previewSsTitle.style.color = accent;
  [previewSsWell, previewSsField].forEach(el => {
    el.style.background = field;
    el.style.borderColor = theme.cardBorder;
    el.style.color = theme.hintColor;
  });
  previewSsBtn.style.background = field;
  previewSsBtn.style.color = btn;
  previewSsBtn.style.borderColor = btn;
  previewSsSend.style.background = accent;
  previewSsSend.style.color = readableOn(accent);
  previewSsSend.style.borderColor = accent;

  // Drag box preview, from the same values the overlays read.
  const box = dragBoxOf(theme);
  previewSelBox.style.borderColor = box.selectionColor;
  previewSelBox.querySelectorAll('i').forEach(h => { h.style.background = box.selectionColor; });
  previewSelBadge.style.background = box.selectionColor;
  previewSelBadge.style.color = readableOn(box.selectionColor);
  previewSelBox.style.opacity   = box.selectionOpacity / 100;
  previewSelCross.style.color   = box.crosshairColor;
  previewSelCross.style.opacity = box.selectionOpacity / 100;
}

function clearActivePreset() {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

// ── Presets ───────────────────────────────────────────────────────────────────
// [data-preset] matters: the two keybind buttons borrow the .preset-btn look,
// and with this bound to them too a click on "Not set" replaced the theme with
// PRESETS[undefined] - nothing at all - so the next Save wiped every colour the
// student had picked. Presets style the cards only, so the drag box is kept.
document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.preset;
    theme = { ...PRESETS[key], ...dragBoxOf(theme) };
    applyToUI();
    updatePreview();
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-reset').addEventListener('click', () => {
  theme = { ...DEFAULTS };
  applyToUI();
  updatePreview();
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-preset="default"]').classList.add('active');
});

// ── Save ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', () => {
  // Only write values whose load has resolved — otherwise a save fired in the
  // first milliseconds would blank the saved keybind or write the theme to the
  // generic (non-account) key.
  const payload = {};
  if (themeReady)   payload[themeKey] = theme;
  if (keybindReady) payload.answerlyStealthKeybind = keybind;
  if (ssKeybindReady) payload.answerlyScreenshotKeybind = ssKeybind;
  chrome.storage.local.set(payload, () => {
    savedMsg.style.display = 'block';
    setTimeout(() => { savedMsg.style.display = 'none'; }, 3000);
  });
});
