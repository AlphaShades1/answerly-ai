// Answerly AI — score reporter.
// Detects a submitted-quiz results page on Canvas and reports the score so
// solver accuracy can be measured against real outcomes.
//
// Reports ONLY: quiz title, points earned, points possible, attempt number.
// Never the student's name, email, course, institution, or any question text.
// Disclosed in the privacy policy under "Quiz scores".
(function () {
  if (window.__answerlyScoreReporterLoaded) return;
  window.__answerlyScoreReporterLoaded = true;

  var DEDUPE_KEY = 'answerlyReportedScores';
  var MAX_DEDUPE = 200;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function txt(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  // "20 out of 20", "18.5 out of 20", "20/20"
  function parsePair(s) {
    if (!s) return null;
    var m = s.match(/([\d.]+)\s*(?:out\s*of|\/)\s*([\d.]+)/i);
    if (!m) return null;
    var score = parseFloat(m[1]);
    var possible = parseFloat(m[2]);
    if (!isFinite(score) || !isFinite(possible)) return null;
    if (possible <= 0 || score < 0 || score > possible) return null;
    return { score: score, possible: possible };
  }

  function firstMatch(root, re) {
    var t = txt(root);
    var m = t.match(re);
    return m ? m[0] : null;
  }

  function versionTable() {
    return document.querySelector('#quiz-submission-version-table, table.score_details, .quiz_versions');
  }

  // ── Is this a results page? ────────────────────────────────────────────────
  function resultsRoot() {
    return document.querySelector('.quiz-submission')
        || document.querySelector('#quiz-submission-version-table')
        || document.querySelector('.quiz_score')
        || null;
  }

  function looksLikeResults() {
    if (resultsRoot()) return true;
    var body = txt(document.body);
    return /Score for this attempt/i.test(body)
        || /Attempt History/i.test(body)
        || /Kept Score/i.test(body);
  }

  // ── Score extraction (several strategies, first plausible hit wins) ─────────
  function extractScore() {
    var root = resultsRoot() || document.body;

    // A0. New Quizzes. It prints the score with no prefix at all — "6 out of 10
    // points" — so every prefixed pattern below misses it and the whole report
    // was abandoned. That is why 500 reported results contained zero New
    // Quizzes attempts: detection passed, this step returned nothing, and the
    // reporter gave up silently.
    //
    // Gated on a New Quizzes results page so the loose "N out of M" wording can
    // never be picked up off a Classic page, where a question's own points line
    // would match it.
    if (document.querySelector('[data-automation="sdk-item-wrapper"], [data-automation="sdk-quiz-score-percentage"], [data-automation="sdk-info-score"]')) {
      var nq = firstMatch(document.body, /[\d.]+\s*out of\s*[\d.]+\s*points?/i);
      if (nq) { var pnq = parsePair(nq); if (pnq) return pnq; }
    }

    // A. "Score for this attempt: N out of M"
    var a = firstMatch(root, /Score for this attempt:?\s*[\d.]+\s*out of\s*[\d.]+/i);
    if (a) { var pa = parsePair(a); if (pa) return pa; }

    // B. Sidebar "Current Score" / "Kept Score"
    var b = firstMatch(document.body, /(?:Current|Kept)\s*Score:?\s*[\d.]+\s*out of\s*[\d.]+/i);
    if (b) { var pb = parsePair(b); if (pb) return pb; }

    // C. Attempt History table — the LATEST row's score cell.
    // Join cells with a space: textContent runs adjacent cells together
    // ("2 minutes" + "20 out of 20" -> "2 minutes20 out of 20").
    var table = versionTable();
    if (table) {
      var rows = Array.from(table.querySelectorAll('tr'));
      for (var i = 0; i < rows.length; i++) {
        var cells = Array.from(rows[i].querySelectorAll('td, th')).map(txt);
        var p = parsePair(cells.length ? cells.join(' ') : txt(rows[i]));
        if (p) return p;   // first parseable row is the LATEST attempt
      }
    }

    // D. Canvas's own score element + points possible from the quiz header
    var scoreEl = document.querySelector('.quiz-submission .score_value, .score_value');
    if (scoreEl) {
      var s = parseFloat(txt(scoreEl));
      var possTxt = firstMatch(document.body, /Points\s*[\d.]+/i);
      var poss = possTxt ? parseFloat(possTxt.replace(/[^\d.]/g, '')) : NaN;
      if (isFinite(s) && isFinite(poss) && poss > 0 && s >= 0 && s <= poss) {
        return { score: s, possible: poss };
      }
    }

    return null;
  }

  function extractTitle() {
    var el = document.querySelector('#quiz_title, .quiz-header h1, h1.quiz-header__title, #content h1, h1');
    var t = txt(el);
    if (t) return t.slice(0, 120);
    // Fall back to the breadcrumb's last entry
    var crumbs = document.querySelectorAll('#breadcrumbs li a, nav[aria-label="breadcrumbs"] a');
    if (crumbs.length) return txt(crumbs[crumbs.length - 1]).slice(0, 120);
    return 'Untitled quiz';
  }

  function extractAttempt() {
    var m = location.search.match(/[?&]version=(\d+)/);
    if (m) return parseInt(m[1], 10);

    // Read the attempt from its own cell/link rather than the page text:
    // adjacent cells concatenate in textContent, so a whole-body regex turns
    // "Attempt 1" followed by "2 minutes" into "Attempt 12".
    var table = versionTable();
    if (table) {
      var cells = Array.from(table.querySelectorAll('a, td, th'));
      for (var i = 0; i < cells.length; i++) {
        var t = txt(cells[i]).match(/^Attempt\s+(\d+)$/i);
        if (t) return parseInt(t[1], 10);
      }
      // A history table exists but no cell parsed. Do NOT guess — an unreadable
      // multi-attempt table is exactly the case where a wrong number is worse
      // than an honest blank.
      return null;
    }

    // No ?version= and no history table at all. Canvas only renders the
    // attempt-history table once there is more than one attempt, so this is a
    // first attempt — which is why every score so far reported "n/a" rather
    // than a number. Reporting 1 here is right whenever the table is absent.
    return 1;
  }

  // ── How long the attempt took ──────────────────────────────────────────────
  // Canvas prints this two ways: a "Time Elapsed"/"Time" line beside the score,
  // and a Time column in the attempt-history table. Read both, since which one
  // is present depends on whether there are multiple attempts.
  // Returns whole seconds, or null when nothing readable is on the page — a
  // wrong duration is worse than an honest blank.
  function parseDuration(str) {
    var t = String(str || '').toLowerCase();
    if (!t) return null;
    if (/less\s+than\s+a\s+minute/.test(t)) return 30;   // Canvas's own wording
    var total = 0, found = false;
    var h = t.match(/(\d+)\s*hour/);         if (h) { total += parseInt(h[1], 10) * 3600; found = true; }
    var m = t.match(/(\d+)\s*minute/);       if (m) { total += parseInt(m[1], 10) * 60;   found = true; }
    var sec = t.match(/(\d+)\s*second/);     if (sec) { total += parseInt(sec[1], 10);    found = true; }
    if (!found) {
      // "00:14:32" / "14:32"
      var clock = t.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
      if (clock) {
        total = (parseInt(clock[1] || '0', 10) * 3600) + (parseInt(clock[2], 10) * 60) + parseInt(clock[3], 10);
        found = true;
      }
    }
    if (!found) return null;
    // Bound it: a scrape that reads a page number as hours must not poison the data.
    if (total <= 0 || total > 24 * 3600) return null;
    return total;
  }

  function extractDuration() {
    // 1. The labelled line Canvas shows beside the score.
    var body = txt(document.body);
    var lbl = body.match(/Time\s*(?:Elapsed)?\s*:\s*([^|]{1,40}?)(?:\s{2,}|Attempt|Score|Kept|$)/i);
    if (lbl) {
      var d = parseDuration(lbl[1]);
      if (d) return d;
    }
    // 2. The Time cell in the attempt-history row. Read the row, not the page
    //    text — adjacent cells concatenate and would merge the score into it.
    var table = versionTable();
    if (table) {
      var rows = table.querySelectorAll('tr');
      for (var i = 0; i < rows.length; i++) {
        var cells = rows[i].querySelectorAll('td, th');
        for (var j = 0; j < cells.length; j++) {
          var d2 = parseDuration(txt(cells[j]));
          // Only trust a cell that is ONLY a duration, so a score cell like
          // "18 out of 20" can never be read as 18 minutes.
          if (d2 && /^[\s\d:.,]*(hour|minute|second|less than a minute|\d{1,2}:\d{2})/i.test(txt(cells[j]))) return d2;
        }
      }
    }
    return null;
  }

  // Canvas cannot auto-grade essay / file-upload questions. Until the instructor
  // marks them the results page shows a provisional score — an asterisk after it
  // and a "not yet graded" note — which would otherwise be reported as if final
  // and look like a failure. Detect that so the score can be labelled pending.
  function gradingPending() {
    var body = txt(document.body);
    if (/not\s+yet\s+(?:been\s+)?graded|has\s+not\s+been\s+graded|pending\s+(?:manual\s+)?grad|awaiting\s+grad|requires?\s+(?:manual\s+)?grading/i.test(body)) return true;
    // "Score for this attempt: 5 out of 22 *"
    if (/out\s*of\s*[\d.]+\s*\*/i.test(body)) return true;
    if (document.querySelector('.not_graded, .ungraded, [class*="not-graded"], [class*="needs_grading"], [class*="needs-grading"]')) return true;
    return false;
  }

  function detectEngine() {
    // Check New Quizzes FIRST and key off the one marker this codebase has
    // actually verified against real markup — newQuizSolver.js keys its whole
    // engine off sdk-item-wrapper. The previous order tested Classic first and
    // fell back to 'classic' when nothing matched, so every score in the store
    // read "classic" whether or not it was, which made the field useless.
    if (document.querySelector('[data-automation="sdk-item-wrapper"], [data-automation="sdk-quiz-results"]')) return 'new';
    if (document.querySelector('.quiz-submission, #quiz-submission-version-table, .quiz_score')) return 'classic';
    // Say "unknown" rather than guessing. A wrong label is worse than no label:
    // it hides whether New Quizzes users are scoring differently from Classic.
    return 'unknown';
  }


  // ── Per-question verdicts ──────────────────────────────────────────────────
  // The results page is the only place the CORRECT answer is ever visible to
  // us. A total score says five of seventeen were wrong without saying which;
  // this says exactly which, and is the difference between a benchmark built
  // from real usage and guessing from aggregates.
  //
  // Deliberately conservative: it reports a verdict ONLY when Canvas has
  // labelled the question itself, and reports nothing at all when it cannot
  // tell. A wrong verdict stored as fact is far worse than a missing one,
  // because it would be served back to students as a verified answer.
  function verdictFor(qEl) {
    var c = ' ' + (qEl.className || '') + ' ';
    // Classic Canvas labels the question container directly. These class names
    // are long-standing and unambiguous.
    if (/\scorrect\s/.test(c) && !/\sincorrect\s/.test(c)) return 'correct';
    if (/\sincorrect\s/.test(c)) return 'incorrect';
    if (/\spartial_credit\s/.test(c)) return 'partial';
    // New Quizzes results mark each question with an icon, not a class or a
    // data attribute: a cross for wrong, a tick for right, with the wrong ones
    // also carrying the words "Incorrect answer:".
    //
    // Order matters and is not cosmetic. A question answered wrongly shows BOTH
    // icons, because it prints the student's wrong answer and the correct one
    // beneath it. Testing for the tick first would therefore mark every wrong
    // answer correct. Verified against a real 6-out-of-10 results page: this
    // returns exactly 6 correct and 4 incorrect, with none unknown.
    // Everything from here down reads New Quizzes markup, and running it on
    // Classic is actively harmful. Classic prints the words "Incorrect answer"
    // as a label beside every distractor it lists, on right and wrong questions
    // alike, so the text test below matched every single question. Observed on a
    // real Classic practice quiz: 39 questions stored as "incorrect" and zero as
    // "correct", on an attempt that actually scored 73%. Classic is already fully
    // resolved by the class check above; if that did not settle it we genuinely do
    // not know, and this file would rather say nothing than store a wrong verdict
    // as fact.
    if (qEl.classList && (qEl.classList.contains('display_question') ||
        qEl.querySelector('.selected_answer, .correct_answer'))) return null;

    if (qEl.querySelector('svg[name="IconX"]') ||
        /Incorrect answer\s*:/i.test(qEl.textContent || '')) return 'incorrect';
    if (qEl.querySelector('svg[name="IconCheck"], svg[name="IconCheckMark"]')) return 'correct';

    // New Quizzes marks the result with a data attribute rather than a class.
    var da = qEl.getAttribute('data-automation') || '';
    if (/incorrect/i.test(da)) return 'incorrect';
    // "incorrect" contains "correct", so [data-automation*="correct"] matches
    // both markers and querySelector returns whichever comes first in the
    // document. A results page that prints the correct answer above the
    // student's wrong one therefore read as 'correct', and a wrong answer
    // stored as verified is served back to the next student as fact.
    //
    // Look for a losing marker anywhere first, and only trust a winning one
    // after confirming the node it matched is not an "incorrect" marker.
    if (qEl.querySelector('[data-automation*="incorrect"]')) return 'incorrect';
    var good = qEl.querySelector('[data-automation*="correct"]');
    if (good && !/incorrect/i.test(good.getAttribute('data-automation') || '')) return 'correct';
    return null;                       // unknown — say nothing
  }

  function stemOf(qEl) {
    var el = qEl.querySelector('div[tabindex="-1"] .user_content.enhanced')
          || qEl.querySelector('.question_text.user_content')
          || qEl.querySelector('.user_content.enhanced')
          || qEl.querySelector('.question_text');
    var t = el ? txt(el) : '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  // Canvas's answer-definition block sits inside the same .answer container on
  // short-answer and fill-in-blank questions, so scraping the container's text
  // swept up the grading metadata with it. Observed 2026-10-08 on a real row:
  //   "4168 Golgi Apparatus Golgi Apparatus exact_answer none 9267 4168
  //    margin of error +/-"
  // stored as the student's answer. Unusable as benchmark data, and worse than
  // nothing, because it looks like a real answer that simply did not match.
  var ANSWER_NOISE_RE = /exact_answer|margin of error|answer_weight|numerical_answer_type|answer_comment|answer_for_|answer_error_margin/i;

  // Read what the page actually shows. The metadata above sits in display:none
  // siblings INSIDE the same .answer container, and innerText leaves those out
  // where textContent sweeps them in. An unrendered node is still read with
  // textContent, because innerText degrades to textContent there anyway and the
  // clean label spans on matching and fill-in-blank questions are themselves
  // hidden - reading those as empty would throw away answers that work today.
  function cellText(el) {
    if (!el) return '';
    var rendered = false;
    try { rendered = el.getClientRects().length > 0; } catch {}
    return String((rendered ? el.innerText : el.textContent) || '')
      .replace(/\s+/g, ' ').trim();
  }

  // Numerical questions print the accepted value with its grading tolerance
  // attached ("144 (with margin: 0)"). Keep the value, drop the tolerance.
  function stripAnswerTails(t) {
    return t.replace(/\s*\(with (?:margin|precision)\s*:[^)]*\)/gi, '')
            .replace(/\s*Between\s+-?[\d.]+\s+and\s+-?[\d.]+/gi, '')
            .replace(/\s*margin of error.*$/i, '')
            .replace(/\s+/g, ' ').trim();
  }

  function collectTexts(qEl, sel) {
    var out = [];
    Array.prototype.forEach.call(qEl.querySelectorAll(sel), function (a) {
      var t = cellText(a);
      // Canvas appends markers like "You Answered" / "Correct Answer" to the
      // label; strip them or the stored text will not match the live option.
      t = t.replace(/^(you answered|correct answer|correct!|incorrect)\s*/i, '').trim();
      t = stripAnswerTails(t);
      // Drop a grading-metadata blob outright rather than trying to repair it.
      // The clean value is usually present as its own sibling node in the same
      // query, so dropping this one keeps the good answer and loses only noise.
      if (ANSWER_NOISE_RE.test(t)) return;
      // A bare database id prefix ("4168 Golgi Apparatus") on an otherwise
      // clean label.
      t = t.replace(/^\d{3,}\s+/, '').trim();
      if (t && out.indexOf(t) === -1 && t.length < 300) out.push(t.slice(0, 200));
    });
    return out;
  }

  // Short-answer and numerical questions keep both the typed response and the
  // accepted answers in INPUT VALUES, which carry no text at all, so a text
  // scrape came back empty for the whole family and every maths or fill-in
  // question was stored as a verdict with no evidence behind it. Verified on a
  // real Classic results page 2026-10-19: the student's answer is
  // input.question_input[name="question_<id>"], and each accepted answer is a
  // hidden input[name="answer_text"].
  //
  // Scoped to .correct_answer on purpose. Multiple-choice questions carry one
  // of these inputs per option, so an unscoped read would record every
  // distractor as a correct answer.
  function fieldValues(qEl, sel) {
    var out = [];
    Array.prototype.forEach.call(qEl.querySelectorAll(sel), function (i) {
      if (i.type === 'radio' || i.type === 'checkbox') return;
      var v = String(i.value == null ? '' : i.value).replace(/\s+/g, ' ').trim();
      if (v && out.indexOf(v) === -1 && v.length < 300) out.push(v.slice(0, 200));
    });
    return out;
  }

  // querySelectorAll with a comma list is a union, not an order of preference,
  // so the precise label node and the whole .answer container both matched and
  // the container's metadata blob competed with the clean label. Take the
  // selectors in order and stop at the first that yields anything; fall back to
  // the input values only when none of them did.
  function answerTexts(qEl, sels, fallbackSel) {
    for (var i = 0; i < sels.length; i++) {
      var out = collectTexts(qEl, sels[i]);
      if (out.length) return out;
    }
    return fallbackSel ? fieldValues(qEl, fallbackSel) : [];
  }

  var CHOSEN_SELECTORS = [
    '.selected_answer .answer_text',
    '.selected_answer .answer_label',
    '.answer.selected_answer',
  ];
  var CORRECT_SELECTORS = [
    '.correct_answer .answer_text',
    '.correct_answer .answer_label',
    '.answer.correct_answer',
  ];
  var CHOSEN_FALLBACK =
    'input.question_input[name^="question_"]:not([name*="_score_"]), ' +
    'textarea.question_input[name^="question_"]:not([name*="_score_"])';
  var CORRECT_FALLBACK = '.correct_answer input[name="answer_text"]';

  function extractQuestionResults() {
    var qs = document.querySelectorAll('[data-automation="sdk-item-wrapper"], div.question.display_question, div.display_question');
    var out = [];
    Array.prototype.forEach.call(qs, function (qEl) {
      var verdict = verdictFor(qEl);
      if (!verdict) return;
      var stem = stemOf(qEl);
      if (!stem || stem.length < 12) return;
      out.push({
        stem: stem,
        verdict: verdict,
        chosen:  answerTexts(qEl, CHOSEN_SELECTORS, CHOSEN_FALLBACK),
        correct: answerTexts(qEl, CORRECT_SELECTORS, CORRECT_FALLBACK),
      });
    });
    return out.slice(0, 80);
  }

  // ── Dedupe so reloading/revisiting a results page doesn't re-report ────────
  function alreadyReported(key, cb) {
    try {
      chrome.storage.local.get(DEDUPE_KEY, function (stored) {
        var list = Array.isArray(stored && stored[DEDUPE_KEY]) ? stored[DEDUPE_KEY] : [];
        cb(list.indexOf(key) !== -1, list);
      });
    } catch { cb(false, []); }
  }

  function markReported(key, list) {
    try {
      var next = list.concat([key]);
      if (next.length > MAX_DEDUPE) next = next.slice(next.length - MAX_DEDUPE);
      var payload = {};
      payload[DEDUPE_KEY] = next;
      chrome.storage.local.set(payload);
    } catch {}
  }

  // ── Main ───────────────────────────────────────────────────────────────────
  function run() {
    if (!looksLikeResults()) return false;

    var parsed = extractScore();
    if (!parsed) return false;

    var payload = {
      quizTitle: extractTitle(),
      score: parsed.score,
      possible: parsed.possible,
      attempt: extractAttempt(),
      engine: detectEngine(),
      durationSec: extractDuration(),
      pending: gradingPending(),
      questions: extractQuestionResults(),
    };

    // New Quizzes gives every attempt its own participant-session id in the URL
    // (/taking/:id/results), while extractAttempt() can only ever return 1 there
    // because the page has no attempt-history table to read. Without the session
    // id, a genuine retake that happened to score the same as the previous one
    // produced an identical key and was silently dropped as a duplicate — so
    // only the very first New Quizzes attempt could ever be reported.
    var session = (location.pathname.match(/\/taking\/(\d+)/) || [])[1] || '';
    var key = [payload.quizTitle, payload.attempt, payload.score, payload.possible, session].join('|');

    alreadyReported(key, function (dupe, list) {
      if (dupe) {
        console.log('[Answerly] Score already reported, skipping:', key);
        return;
      }
      try {
        console.log('[Answerly] Reporting score:', payload.score + '/' + payload.possible,
                    '| engine:', payload.engine, '| quiz:', payload.quizTitle);
        chrome.runtime.sendMessage({ type: 'REPORT_SCORE', payload: payload }, function () {
          void chrome.runtime.lastError;   // extension may be reloading; ignore
        });
        markReported(key, list);
      } catch {}
    });

    return true;
  }

  // Results content can render slightly after load — retry briefly, then stop.
  function arm(limit) {
    var tries = 0;
    (function attempt() {
      if (run()) return;
      if (++tries >= limit) return;
      setTimeout(attempt, 700);
    })();
  }
  arm(6);

  // New Quizzes is a single-page app: the document loads once at
  // /assignments/:id/launch, and /take and /results are client-side routes with
  // NO further navigation — verified on a real attempt, where the only
  // performance navigation entry was the launch URL. So the burst above expires
  // ~4 seconds in, while the student is still answering, and nothing ever
  // re-injects this script. That, not the match patterns, is why no New Quizzes
  // result has ever been reported: on the live results page the detection
  // itself works (score 3/3, engine "new") — it simply never runs there.
  //
  // Re-arm on every URL change, with a longer window because the results view
  // renders asynchronously after the route changes.
  //
  // This POLLS location.href instead of wrapping history.pushState. A content
  // script runs in an isolated world, so a wrapper installed on history here is
  // never called by the page's own router, which lives in the page's world —
  // the wrapper looks right and silently never fires. Reading location.href
  // works from either world, so polling is the only thing that actually
  // observes a client-side route change. The tick is a string compare; only an
  // actual change pays for detection.
  var lastHref = location.href;
  function onRouteChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    arm(14);                    // ~10s, enough for the results view to paint
  }
  setInterval(onRouteChange, 1000);
  // Back/forward dispatch real events in this world too — cheap to also catch.
  window.addEventListener('popstate', onRouteChange);
  window.addEventListener('hashchange', onRouteChange);

  // Safety net for any flow that reveals results without changing the URL.
  // run() bails immediately when the page is not a results page, and the
  // storage dedupe makes a repeat harmless, so sweep slowly rather than trusting
  // the URL alone. Stops as soon as a results page is found, or after ~20min.
  var sweeps = 0;
  var sweepTimer = setInterval(function () {
    if (++sweeps > 240 || run()) clearInterval(sweepTimer);
  }, 5000);
})();
