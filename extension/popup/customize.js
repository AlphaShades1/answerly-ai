const DEFAULTS = {
  accentColor: '#7c5cfc',
  cardBg:      '#1a1a2e',
  cardBorder:  '#7c5cfc',
  answerColor: '#ffffff',
  hintColor:   '#c0c0d8',
  opacity:     100,
};

const PRESETS = {
  default: { accentColor: '#7c5cfc', cardBg: '#1a1a2e', cardBorder: '#7c5cfc', answerColor: '#ffffff', hintColor: '#c0c0d8', opacity: 100 },
  ghost:   { accentColor: '#7c5cfc', cardBg: '#1a1a2e', cardBorder: '#7c5cfc', answerColor: '#ffffff', hintColor: '#c0c0d8', opacity: 0   },
  dark:    { accentColor: '#444466', cardBg: '#000000', cardBorder: '#444466', answerColor: '#ffffff', hintColor: '#888899', opacity: 95  },
  green:   { accentColor: '#00ff41', cardBg: '#001a00', cardBorder: '#00ff41', answerColor: '#00ff41', hintColor: '#00cc33', opacity: 100 },
};

let theme = { ...DEFAULTS };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const colorAccent  = document.getElementById('color-accent');
const hexAccent    = document.getElementById('hex-accent');
const colorBg      = document.getElementById('color-bg');
const hexBg        = document.getElementById('hex-bg');
const colorBorder  = document.getElementById('color-border');
const hexBorder    = document.getElementById('hex-border');
const colorAnswer  = document.getElementById('color-answer');
const hexAnswer    = document.getElementById('hex-answer');
const colorHint    = document.getElementById('color-hint');
const hexHint      = document.getElementById('hex-hint');
const opacitySlider = document.getElementById('opacity-slider');
const opacityVal   = document.getElementById('opacity-val');
const savedMsg     = document.getElementById('saved-msg');

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
let themeKey = 'answerlyTheme';
chrome.storage.local.get('answerlySession', (sess) => {
  const code = sess.answerlySession?.code;
  if (code) themeKey = 'answerlyTheme_' + code;
  chrome.storage.local.get(themeKey, (s) => {
    if (s[themeKey]) theme = { ...DEFAULTS, ...s[themeKey] };
    applyToUI();
    updatePreview();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function syncColorPair(colorInput, hexInput, key) {
  colorInput.addEventListener('input', () => {
    hexInput.value = colorInput.value;
    theme[key] = colorInput.value;
    updatePreview();
    clearActivePreset();
  });
  hexInput.addEventListener('input', () => {
    const val = hexInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      colorInput.value = val;
      theme[key] = val;
      updatePreview();
      clearActivePreset();
    }
  });
}

syncColorPair(colorAccent, hexAccent, 'accentColor');
syncColorPair(colorBg,     hexBg,     'cardBg');
syncColorPair(colorBorder, hexBorder, 'cardBorder');
syncColorPair(colorAnswer, hexAnswer, 'answerColor');
syncColorPair(colorHint,   hexHint,   'hintColor');

opacitySlider.addEventListener('input', () => {
  theme.opacity = parseInt(opacitySlider.value);
  opacityVal.textContent = theme.opacity + '%';
  updatePreview();
  clearActivePreset();
});


function applyToUI() {
  colorAccent.value = theme.accentColor || DEFAULTS.accentColor;
  hexAccent.value   = theme.accentColor || DEFAULTS.accentColor;
  colorBg.value     = theme.cardBg;
  hexBg.value       = theme.cardBg;
  colorBorder.value = theme.cardBorder;
  hexBorder.value   = theme.cardBorder;
  colorAnswer.value = theme.answerColor;
  hexAnswer.value   = theme.answerColor;
  colorHint.value   = theme.hintColor;
  hexHint.value     = theme.hintColor;
  opacitySlider.value = theme.opacity;
  opacityVal.textContent = theme.opacity + '%';
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
  previewAnswerBox.style.background = '#0f0f1e';
  previewAnswerBox.style.border = `1px solid ${theme.cardBorder}`;
  previewAnswerLbl.style.color = theme.cardBorder;
  previewAnswerText.style.color = theme.answerColor;
}

function clearActivePreset() {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

// ── Presets ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.preset;
    theme = { ...PRESETS[key] };
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
  chrome.storage.local.set({
    [themeKey]: theme,
  }, () => {
    savedMsg.style.display = 'block';
    setTimeout(() => { savedMsg.style.display = 'none'; }, 3000);
  });
});
