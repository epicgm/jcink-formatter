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

    const emailInput    = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const errorEl       = document.getElementById('error-message');
    const submitBtn     = document.getElementById('submit-btn');

    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    // ── 1. Auth ───────────────────────────────────────────────────────────────
    let signInData, signInError;
    try {
      ({ data: signInData, error: signInError } =
        await supabase.auth.signInWithPassword({
          email:    emailInput.value.trim(),
          password: passwordInput.value,
        }));
    } catch {
      errorEl.textContent = 'Having trouble connecting. Check your internet connection and try again.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
      return;
    }

    if (signInError) {
      errorEl.textContent = 'Wrong username or password. Please try again.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
      return;
    }

    // ── 2. Confirm we actually have a session ────────────────────────────────
    // session is null when Supabase requires email confirmation.
    // Use signInData.user.id (always present) rather than session.user.id.
    if (!signInData.session) {
      await supabase.auth.signOut();
      errorEl.textContent = 'Please confirm your email address before signing in. Check your inbox for a confirmation link.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
      return;
    }

    const uid = signInData.user.id;

    // ── 3. Read profile (active status + role) ────────────────────────────────
    const { data: profile } = await supabase
      .from('users')
      .select('active, role')
      .eq('id', uid)
      .single();

    if (profile?.active === false) {
      await supabase.auth.signOut();
      errorEl.textContent = 'Your account has been deactivated. Please contact an admin.';
      errorEl.classList.add('visible');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
      return;
    }

    // ── 4. Persist role so every page can show the Admin nav link ─────────────
    const role = profile?.role ?? 'user';
    localStorage.setItem('inkform_role', role);

    window.location.href = 'home.html';
  });
}
