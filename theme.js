// theme.js — runs synchronously in <head> to prevent flash of wrong theme
// Also wires up the toggle button after DOM is ready.
(function () {
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  const saved       = localStorage.getItem('inkform-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved === 'dark' || (!saved && prefersDark) ? 'dark' : 'light');

  window.toggleTheme = function () {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('inkform-theme', next);
    syncToggleIcons();
  };

  function syncToggleIcons() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('.theme-toggle-icon').forEach(el => {
      el.textContent = isDark ? '☀' : '☽';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[id="theme-toggle"]').forEach(btn => {
      btn.addEventListener('click', window.toggleTheme);
    });
    syncToggleIcons();
  });
})();
