// FAQ accordion
document.querySelectorAll('.faq-q').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faq-item');
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

// CTA button — update href once Chrome Web Store link is ready
const ctaBtn = document.getElementById('cta-btn');
if (ctaBtn) {
  ctaBtn.addEventListener('click', (e) => {
    // placeholder: scroll to pricing until store link is added
    if (ctaBtn.getAttribute('href') === '#') {
      e.preventDefault();
      document.getElementById('pricing').scrollIntoView({ behavior: 'smooth' });
    }
  });
}
