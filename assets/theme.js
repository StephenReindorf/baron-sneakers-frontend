(() => {
  const saved = localStorage.getItem('baron-theme');
  if (saved === 'dark') document.body.classList.add('inv');

  const toggle = document.querySelector('#themeToggle');
  if (!toggle) return;

  const update = () => {
    const dark = document.body.classList.contains('inv');
    toggle.textContent = dark ? '☀' : '☾';
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  };

  toggle.addEventListener('click', () => {
    const dark = document.body.classList.toggle('inv');
    localStorage.setItem('baron-theme', dark ? 'dark' : 'light');
    update();
  });
  update();
})();
