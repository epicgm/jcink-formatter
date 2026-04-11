/**
 * offline.js — Connectivity detection, offline banner, write queue
 *
 * Usage: import and call at the top of any protected page after creating
 * the supabase client. Relies on window.SUPABASE_URL + SUPABASE_ANON_KEY
 * set by config.js.
 */

const QUEUE_KEY = 'jcink_offline_queue';

// ── Connectivity check (3-second timeout) ────────────────────────────────────
// Uses a lightweight fetch to the Supabase REST root. Any HTTP response means
// we're online; AbortError / network failure means offline.

export async function checkOnline() {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${window.SUPABASE_URL}/rest/v1/`, {
      signal:  controller.signal,
      headers: { apikey: window.SUPABASE_ANON_KEY },
    });
    clearTimeout(timeoutId);
    return true;
  } catch {
    return false;
  }
}

// ── Offline banner ────────────────────────────────────────────────────────────

let _banner = null;

export function showOfflineBanner() {
  if (_banner) return;
  _banner = document.createElement('div');
  _banner.className = 'offline-banner';
  _banner.setAttribute('role', 'status');
  _banner.setAttribute('aria-live', 'polite');
  _banner.textContent =
    'Working offline — your characters are loaded from your last session. ' +
    'Changes will sync automatically when connection is restored.';
  const nav = document.querySelector('.navbar');
  if (nav) nav.insertAdjacentElement('afterend', _banner);
  else      document.body.prepend(_banner);
}

export function hideOfflineBanner() {
  _banner?.remove();
  _banner = null;
}

// ── Write queue ───────────────────────────────────────────────────────────────
// Entries: { table, op: 'insert'|'update'|'delete', payload, id? }

export function enqueueWrite(entry) {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    q.push({ ...entry, queued_at: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {}
}

export async function replayQueue(supabase) {
  let q;
  try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { q = []; }
  if (!q.length) return 0;

  let synced = 0;
  for (const e of q) {
    try {
      if (e.op === 'insert') {
        const { error } = await supabase.from(e.table).insert(e.payload);
        if (!error) synced++;
      } else if (e.op === 'update') {
        const { error } = await supabase.from(e.table).update(e.payload).eq('id', e.id);
        if (!error) synced++;
      } else if (e.op === 'delete') {
        const { error } = await supabase.from(e.table).delete().eq('id', e.id);
        if (!error) synced++;
      }
    } catch {}
  }

  localStorage.removeItem(QUEUE_KEY);
  return synced;
}

// ── Online recovery watcher ───────────────────────────────────────────────────
// Polls every 10 s. Calls onRecover() once when connection is restored.

export function watchOnlineRecovery(onRecover) {
  const timer = setInterval(async () => {
    if (await checkOnline()) {
      clearInterval(timer);
      onRecover();
    }
  }, 10_000);
  return () => clearInterval(timer);
}
