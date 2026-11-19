/**
 * "My Questions" - the student's own solve history, read back from the backend.
 *
 * Everything is rendered with textContent, never innerHTML: these strings are
 * quiz text scraped off a page, so treating them as markup would let a quiz
 * author's stray angle bracket (or worse) run inside an extension page.
 */
const BACKEND_URL = 'https://answerly-ai-backend.onrender.com';

const subEl = document.getElementById('sub');
const barEl = document.getElementById('bar');
const listEl = document.getElementById('list');
const retEl = document.getElementById('retention');
const searchEl = document.getElementById('search');

let allRows = [];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function dayLabel(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeLabel(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function showEmpty(big, small) {
  listEl.replaceChildren();
  const box = el('div', 'empty');
  box.appendChild(el('div', 'big', big));
  box.appendChild(el('div', null, small));
  listEl.appendChild(box);
}

/** Group consecutive rows by quiz + day, so one sitting reads as one block. */
function group(rows) {
  const out = [];
  for (const r of rows) {
    const title = r.quizTitle || 'Untitled quiz';
    const day = dayLabel(r.ts);
    const last = out[out.length - 1];
    if (last && last.title === title && last.day === day) last.rows.push(r);
    else out.push({ title, day, rows: [r] });
  }
  return out;
}

function render(rows) {
  listEl.replaceChildren();
  if (!rows.length) {
    showEmpty('Nothing matches that search.', 'Try a different word, or clear the box.');
    return;
  }
  for (const g of group(rows)) {
    const sec = el('div', 'quiz');
    const head = el('div', 'quiz-head');
    head.appendChild(el('div', 'quiz-title', g.title));
    head.appendChild(el('div', 'quiz-meta',
      g.day + ' · ' + g.rows.length + (g.rows.length === 1 ? ' question' : ' questions')));
    sec.appendChild(head);

    for (const r of g.rows) {
      const q = el('div', 'q');
      q.appendChild(el('div', 'q-text', r.question || '(no question text saved)'));

      if (Array.isArray(r.options) && r.options.length) {
        const ul = el('ul', 'q-opts');
        for (const o of r.options) {
          // Mark the option Answerly picked, when the answer names one of them.
          const picked = r.answer && String(o).trim() === String(r.answer).trim();
          ul.appendChild(el('li', picked ? 'pick' : null, o));
        }
        q.appendChild(ul);
      }

      const ans = el('div', 'q-ans');
      ans.appendChild(el('span', 'lbl', r.failed ? 'No answer: ' : 'Answerly answered: '));
      ans.appendChild(document.createTextNode(
        r.failed ? 'this one did not go through' : (r.answer || '(not saved)')));
      q.appendChild(ans);

      const foot = el('div', 'q-foot', timeLabel(r.ts));
      if (r.screenshot) foot.appendChild(el('span', 'tag', 'screenshot'));
      q.appendChild(foot);
      sec.appendChild(q);
    }
    listEl.appendChild(sec);
  }
}

function applySearch() {
  const s = searchEl.value.trim().toLowerCase();
  if (!s) return render(allRows);
  render(allRows.filter(r =>
    (r.question || '').toLowerCase().includes(s) ||
    (r.answer || '').toLowerCase().includes(s) ||
    (r.quizTitle || '').toLowerCase().includes(s) ||
    (r.options || []).some(o => String(o).toLowerCase().includes(s))));
}

function asText(rows) {
  const L = ['ANSWERLY - MY QUESTIONS', ''];
  for (const g of group(rows)) {
    L.push('='.repeat(70), g.title + '  -  ' + g.day, '='.repeat(70), '');
    g.rows.forEach((r, i) => {
      L.push((i + 1) + '. ' + (r.question || '(no question text saved)'));
      for (const o of (r.options || [])) L.push('     - ' + o);
      L.push('   Answerly answered: ' + (r.failed ? '(did not go through)' : (r.answer || '(not saved)')));
      L.push('   ' + timeLabel(r.ts) + (r.screenshot ? '  [screenshot]' : ''), '');
    });
  }
  return L.join('\r\n');
}

function download() {
  const rows = allRows;
  if (!rows.length) return;
  const blob = new Blob([asText(rows)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'answerly-my-questions.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function load() {
  subEl.textContent = 'Loading…';
  let session;
  try {
    const stored = await chrome.storage.local.get('answerlySession');
    session = stored.answerlySession;
  } catch { session = null; }

  if (!session || !session.token) {
    subEl.textContent = '';
    showEmpty('You are not signed in.',
              'Open the Answerly popup and enter your activation code, then come back.');
    return;
  }

  let data;
  try {
    const res = await fetch(BACKEND_URL + '/api/history?limit=1000', {
      headers: { Authorization: 'Bearer ' + session.token },
    });
    if (res.status === 401) {
      subEl.textContent = '';
      showEmpty('Your code is not active.',
                'Open the popup and sign in again, then come back.');
      return;
    }
    if (!res.ok) throw new Error('server said ' + res.status);
    data = await res.json();
  } catch (err) {
    subEl.textContent = '';
    showEmpty('Could not load your history.',
              'Check your connection and press Refresh. (' + err.message + ')');
    return;
  }

  allRows = Array.isArray(data.rows) ? data.rows : [];
  barEl.style.display = 'flex';
  subEl.textContent = allRows.length
    ? allRows.length + (allRows.length === 1 ? ' question' : ' questions') +
      ' · ' + dayLabel(data.oldest) + ' to ' + dayLabel(data.newest)
    : '';

  if (!allRows.length) {
    showEmpty('No questions saved yet.',
              'Once you use Answerly on a quiz, the questions show up here.');
  } else {
    applySearch();
  }
  retEl.textContent = 'Answerly keeps about two weeks of history, so older quizzes drop off. '
                    + 'Use Download to keep a copy.';
}

searchEl.addEventListener('input', applySearch);
document.getElementById('btn-refresh').addEventListener('click', load);
document.getElementById('btn-download').addEventListener('click', download);
load();
