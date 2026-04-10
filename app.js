import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// config.js (gitignored) sets window.SUPABASE_URL and window.SUPABASE_ANON_KEY
const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// ── Login page logic ──────────────────────────────────
const loginForm = document.getElementById('login-form');

if (loginForm) {
  // Redirect to home if already signed in
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session) window.location.href = 'home.html';
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput  = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const errorEl     = document.getElementById('error-message');
    const submitBtn   = document.getElementById('submit-btn');

    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    const { error } = await supabase.auth.signInWithPassword({
      email:    emailInput.value.trim(),
      password: passwordInput.value,
    });

    if (error) {
      errorEl.textContent = 'Incorrect username or password. Please try again.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    } else {
      window.location.href = 'home.html';
    }
  });
}
