function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach((item) => {
    const button = item.querySelector('button');
    const panel = item.querySelector('.faq-panel');
    if (!button || !panel) return;

    button.addEventListener('click', () => {
      const isExpanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!isExpanded));
      panel.hidden = isExpanded;
      const icon = button.querySelector('.icon');
      if (icon) {
        icon.textContent = isExpanded ? '+' : '×';
      }
    });
  });
}

function initSignupForms() {
  const forms = document.querySelectorAll('.signup-form');
  forms.forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const feedback = form.querySelector('.form-feedback');
      if (!input || !feedback) return;

      const value = input.value.trim();
      if (value && value.includes('@')) {
        feedback.textContent = `Ще ти изпратим покана на ${value}.`;
        input.value = '';
      } else {
        feedback.textContent = 'Моля, въведи валиден имейл адрес.';
      }
    });
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initFaqAccordion();
  initSignupForms();
});
