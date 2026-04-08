// Affiliate form — AJAX submit so page never redirects
const affForm = document.getElementById('affiliate-form');
if (affForm) {
  affForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('aff-submit-btn');
    const success = document.getElementById('aff-success');
    btn.textContent = 'Sending…';
    btn.disabled = true;
    try {
      const res = await fetch('https://formspree.io/f/xdapjgoy', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: new FormData(affForm),
      });
      if (res.ok) {
        affForm.reset();
        btn.style.display = 'none';
        success.classList.remove('hidden');
      } else {
        btn.textContent = 'Error — try again';
        btn.disabled = false;
      }
    } catch {
      btn.textContent = 'Error — try again';
      btn.disabled = false;
    }
  });
}

// FAQ accordion
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});
