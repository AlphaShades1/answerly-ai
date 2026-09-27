// Answerly — New Quizzes diagnostic. Paste into the browser console ON THE QUIZ
// PAGE, at the moment the buttons are missing. Prints one block to copy back.
//
// Everything it reads is already on the page: how many question wrappers exist,
// whether the stem text the solver needs comes out empty, which inputs are
// present, and whether any Answerly button made it into the DOM. Question text
// is truncated to 60 characters so a whole quiz is never copied out.
(() => {
  const out = {};
  out.when = new Date().toISOString();
  out.url = location.href.replace(/\/\/[^/]*@/, '//');
  out.inIframe = window.top !== window.self;
  out.frames = window.frames.length;

  // What the solver looks for. If this is 0, nothing else can run.
  const wraps = document.querySelectorAll('[data-automation="sdk-item-wrapper"]');
  out.questionWrappers = wraps.length;

  // If Canvas renamed the markup, the real value shows up here.
  out.dataAutomationValues = [...new Set([...document.querySelectorAll('[data-automation]')]
    .map(e => e.getAttribute('data-automation')))].slice(0, 25);

  // Buttons the extension should have injected.
  out.answerlyButtons = document.querySelectorAll('.answerly-nq-btn').length;
  out.answerlyClassicButtons = document.querySelectorAll('.answerly-btn').length;
  out.answerlyCards = document.querySelectorAll('.answerly-nq-card').length;
  out.answerlyStyleTag = !!document.querySelector('style[id*="answerly"], style[class*="answerly"]');

  // Per question: does the stem text the solver needs actually come out?
  out.questions = [...wraps].slice(0, 5).map((q, i) => {
    const stem = q.querySelector('div[tabindex="-1"] .user_content.enhanced')
              || q.querySelector('.user_content.enhanced');
    const text = stem ? (stem.innerText || stem.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return {
      i,
      posBox: (q.querySelector('[data-automation="sdk-position-box-text"]') || {}).textContent || null,
      typeLabel: (q.querySelector('[data-automation="sdk-interaction-type-name-div"]') || {}).textContent || null,
      stemFound: !!stem,
      stemChars: text.length,          // 0 here = the solver skips this question
      stemPreview: text.slice(0, 60),
      radios: q.querySelectorAll('input[type="radio"]').length,
      checkboxes: q.querySelectorAll('input[type="checkbox"]').length,
      textInputs: q.querySelectorAll('input[type="text"], textarea').length,
      selects: q.querySelectorAll('select').length,
      images: q.querySelectorAll('img, canvas, svg').length,
      answerlyBtns: q.querySelectorAll('.answerly-nq-btn').length,
    };
  });

  // Markup of the first question, structure only — attributes and tags, no text.
  const first = wraps[0];
  out.firstQuestionSkeleton = first
    ? [...first.querySelectorAll('*')].slice(0, 40).map(e =>
        e.tagName.toLowerCase()
        + (e.getAttribute('data-automation') ? '[data-automation=' + e.getAttribute('data-automation') + ']' : '')
        + (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : '')
        + (e.className && typeof e.className === 'string' && e.className.trim()
            ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
      )
    : null;

  const text = 'ANSWERLY-DIAG ' + JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); console.log('%c^ copied to clipboard — paste it to Saymon', 'color:#0a0'); } catch (e) {}
  return out;
})();
