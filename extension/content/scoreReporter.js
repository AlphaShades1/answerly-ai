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
    };

    var key = [payload.quizTitle, payload.attempt, payload.score, payload.possible].join('|');

    alreadyReported(key, function (dupe, list) {
      if (dupe) return;
      try {
        chrome.runtime.sendMessage({ type: 'REPORT_SCORE', payload: payload }, function () {
          void chrome.runtime.lastError;   // extension may be reloading; ignore
        });
        markReported(key, list);
      } catch {}
    });

    return true;
  }

  // Results content can render slightly after load — retry briefly, then stop.
  var tries = 0;
  (function attempt() {
    if (run()) return;
    if (++tries >= 6) return;
    setTimeout(attempt, 700);
  })();
})();
