/**
 * admin.js — Admin panel: user management + board library review queue
 * Requires config.js loaded first.
 * Redirects non-admin users to home.html immediately.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Hide immediately — revealed only after admin role confirmed, preventing flash.
document.body.style.visibility = 'hidden';

// ── Auth + admin guard ────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;

const { data: selfProfile } = await supabase
  .from('users')
  .select('role')
  .eq('id', userId)
  .single();

if (selfProfile?.role !== 'admin') {
  window.location.replace('home.html'); throw 0;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const tabBtns          = document.querySelectorAll('.tab-btn');
const themeToggle      = document.getElementById('theme-toggle');
const logoutBtn        = document.getElementById('logout-btn');

// Show logged-in username in nav
const _navUsername = document.getElementById('nav-username');
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// Export
const exportAllBtn     = document.getElementById('export-all-btn');
const exportAllStatus  = document.getElementById('export-all-status');

// Users tab
const createUserForm   = document.getElementById('create-user-form');
const newUsernameIn    = document.getElementById('new-username');
const newPasswordIn    = document.getElementById('new-password');
const newRoleSel       = document.getElementById('new-role');
const createUserBtn    = document.getElementById('create-user-btn');
const createUserStatus = document.getElementById('create-user-status');
const userTbody        = document.getElementById('user-tbody');
const usersEmpty       = document.getElementById('users-empty');

// Review queue tab
const reviewList       = document.getElementById('review-list');
const reviewEmpty      = document.getElementById('review-empty');
const queueCount       = document.getElementById('queue-count');

// Reject dialog
const rejectDialog     = document.getElementById('reject-dialog');
const rejectForm       = document.getElementById('reject-form');
const rejectNote       = document.getElementById('reject-note');
const rejectTriggerEl  = document.getElementById('reject-dialog-trigger').querySelector('code');

// ── State ─────────────────────────────────────────────────────────────────────

let _rejectBlockId = null;

// ── Theme + logout ────────────────────────────────────────────────────────────

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('inkform-theme', next);
  themeToggle.querySelector('.theme-toggle-icon').textContent = next === 'dark' ? '☀' : '☽';
});
if (document.documentElement.getAttribute('data-theme') === 'dark') {
  themeToggle.querySelector('.theme-toggle-icon').textContent = '☀';
}

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  localStorage.removeItem('inkform_role');
  window.location.href = 'index.html';
});

// ── Tab switching ─────────────────────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.hidden = p.id !== `tab-${target}`;
    });
    if (target === 'review') loadReviewQueue();
  });
});

// ── Dialog helpers ────────────────────────────────────────────────────────────

document.querySelectorAll('.dialog-cancel').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});
document.querySelectorAll('.manage-dialog').forEach(dlg => {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
});

// ── USERS TAB ─────────────────────────────────────────────────────────────────

async function loadUsers() {
  const { data } = await supabase
    .from('users')
    .select('id, username, role, created_at, active')
    .order('created_at');

  const users = data ?? [];
  usersEmpty.hidden = users.length > 0;
  userTbody.innerHTML = '';

  for (const u of users) {
    const tr = document.createElement('tr');
    tr.className = u.active === false ? 'user-row--inactive' : '';

    tr.innerHTML = `
      <td class="td-username">${escHtml(u.username)}</td>
      <td><span class="role-tag role-tag--${u.role}">${u.role}</span></td>
      <td class="td-date">${new Date(u.created_at).toLocaleDateString()}</td>
      <td><span class="status-tag ${u.active === false ? 'status-tag--inactive' : 'status-tag--active'}">${u.active === false ? 'Inactive' : 'Active'}</span></td>
      <td class="td-actions"></td>
    `;

    const actionsCell = tr.querySelector('.td-actions');

    if (u.active !== false && u.id !== userId) {
      // Don't show deactivate for self or already-inactive
      const deactivateBtn = document.createElement('button');
      deactivateBtn.type = 'button';
      deactivateBtn.className = 'btn-sm btn-danger';
      deactivateBtn.textContent = 'Deactivate';
      deactivateBtn.addEventListener('click', () => deactivateUser(u.id, u.username));
      actionsCell.appendChild(deactivateBtn);
    }

    if (u.active === false) {
      const reactivateBtn = document.createElement('button');
      reactivateBtn.type = 'button';
      reactivateBtn.className = 'btn-sm btn-ghost';
      reactivateBtn.textContent = 'Reactivate';
      reactivateBtn.addEventListener('click', () => reactivateUser(u.id));
      actionsCell.appendChild(reactivateBtn);
    }

    userTbody.appendChild(tr);
  }
}

// ── Create user ───────────────────────────────────────────────────────────────

createUserForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = newUsernameIn.value.trim();
  const password = newPasswordIn.value;
  const role     = newRoleSel.value;

  if (!username || !password) return;

  createUserBtn.disabled = true;
  createUserBtn.textContent = 'Creating…';
  createUserStatus.textContent = '';

  try {
    // Re-fetch the session token at call time and pass it explicitly.
    // supabase.functions.invoke falls back to sending the anon key as the
    // Bearer token when using sb_publishable_ format keys, which the Edge
    // Functions platform rejects as "Invalid JWT". Passing the JWT directly
    // bypasses this SDK behaviour.
    const { data: { session: liveSession } } = await supabase.auth.getSession();
    if (!liveSession) { window.location.replace('index.html'); return; }

    const { data, error } = await supabase.functions.invoke('admin-create-user', {
      body: { username, password, role },
      headers: { Authorization: `Bearer ${liveSession.access_token}` },
    });

    if (error) {
      // error.message is the generic SDK wrapper text. Extract the real message
      // from the JSON response body and HTTP status for clearer diagnosis.
      let detail = error.message;
      try {
        const status = error.context?.status ?? '';
        const body   = await error.context.json();
        detail = status ? `${status}: ${body?.error ?? JSON.stringify(body)}` : (body?.error ?? detail);
      } catch { /* response body unreadable — fall back to SDK message */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);

    createUserStatus.textContent = `✓ Created ${username} (${role})`;
    createUserStatus.style.color = 'var(--color-teal)';
    newUsernameIn.value = '';
    newPasswordIn.value = '';
    newRoleSel.value = 'user';
    await loadUsers();

  } catch (err) {
    createUserStatus.textContent = `Error: ${err.message}`;
    createUserStatus.style.color = 'var(--color-danger)';
  } finally {
    createUserBtn.disabled = false;
    createUserBtn.textContent = 'Create User';
  }
});

// ── Deactivate / reactivate ───────────────────────────────────────────────────

async function deactivateUser(id, username) {
  if (!confirm(`Deactivate "${username}"? They will be blocked from logging in.`)) return;
  await supabase.from('users').update({ active: false }).eq('id', id);
  await loadUsers();
}

async function reactivateUser(id) {
  await supabase.from('users').update({ active: true }).eq('id', id);
  await loadUsers();
}

// ── REVIEW QUEUE ──────────────────────────────────────────────────────────────

async function loadReviewQueue() {
  reviewList.innerHTML = '';
  reviewEmpty.hidden = true;

  const { data: blocks } = await supabase
    .from('board_library')
    .select('id, trigger, replacement_html, added_by, status')
    .eq('status', 'pending')
    .order('id');

  const pending = blocks ?? [];

  // Update queue badge count
  if (pending.length > 0) {
    queueCount.textContent = String(pending.length);
    queueCount.hidden = false;
  } else {
    queueCount.hidden = true;
  }

  if (!pending.length) {
    reviewEmpty.hidden = false;
    return;
  }

  // Fetch submitter usernames in one query
  const submitterIds = [...new Set(pending.map(b => b.added_by).filter(Boolean))];
  const usernameMap = {};
  if (submitterIds.length) {
    const { data: submitters } = await supabase
      .from('users')
      .select('id, username')
      .in('id', submitterIds);
    for (const u of submitters ?? []) usernameMap[u.id] = u.username;
  }

  for (const b of pending) {
    reviewList.appendChild(makeReviewCard(b, usernameMap[b.added_by] ?? 'unknown'));
  }
}

function makeReviewCard(b, submitterName) {
  const card = document.createElement('div');
  card.className = 'review-card';
  card.id = `review-${b.id}`;

  // Header
  card.innerHTML = `
    <div class="review-card-header">
      <span class="block-card-trigger">::${escHtml(b.trigger)}::</span>
      <span class="review-submitter">Submitted by <strong>${escHtml(submitterName)}</strong></span>
    </div>
  `;

  // Live preview
  const preview = document.createElement('div');
  preview.className = 'block-card-preview output-area review-card-preview';
  preview.innerHTML = b.replacement_html || '<span class="output-placeholder">No HTML</span>';
  card.appendChild(preview);

  // Actions row (no inline textarea for reject note — opens dialog)
  const footer = document.createElement('div');
  footer.className = 'review-card-footer';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn-sm btn-primary';
  approveBtn.textContent = 'Approve';
  approveBtn.addEventListener('click', () => approveBlock(b.id, card));

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'btn-sm btn-danger';
  rejectBtn.textContent = 'Reject';
  rejectBtn.addEventListener('click', () => openRejectDialog(b.id, b.trigger));

  footer.appendChild(approveBtn);
  footer.appendChild(rejectBtn);
  card.appendChild(footer);

  return card;
}

async function approveBlock(id, card) {
  const { error } = await supabase
    .from('board_library')
    .update({ status: 'published' })
    .eq('id', id);

  if (error) { alert(error.message); return; }

  card.classList.add('review-card--done');
  card.querySelector('.review-card-footer').innerHTML =
    '<span class="review-done-label review-done-label--approved">✓ Published</span>';

  // Update badge count
  await loadReviewQueue();
}

function openRejectDialog(id, trigger) {
  _rejectBlockId = id;
  rejectTriggerEl.textContent = `::${trigger}::`;
  rejectNote.value = '';
  rejectDialog.showModal();
  rejectNote.focus();
}

rejectForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (!_rejectBlockId) return;

  const note = rejectNote.value.trim() || null;
  const { error } = await supabase
    .from('board_library')
    .update({ status: 'rejected', rejection_note: note })
    .eq('id', _rejectBlockId);

  if (error) { alert(error.message); return; }

  rejectDialog.close();
  _rejectBlockId = null;
  await loadReviewQueue();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Export all users ──────────────────────────────────────────────────────────

exportAllBtn.addEventListener('click', async () => {
  exportAllBtn.disabled = true;
  exportAllBtn.textContent = 'Exporting…';
  exportAllStatus.textContent = '';

  try {
    const [
      { data: users },
      { data: characters },
      { data: templates },
      { data: userLibrary },
      { data: boardLibrary },
    ] = await Promise.all([
      supabase.from('users').select('id, username, role, created_at, active').order('username'),
      supabase.from('characters').select('id, user_id, name, created_at').order('name'),
      supabase.from('templates').select('id, character_id, name, shell_html, rules_json, active_block_ids, created_at').order('name'),
      supabase.from('user_library').select('id, user_id, trigger, replacement_html, is_global').order('trigger'),
      supabase.from('board_library').select('id, trigger, replacement_html, added_by, status, used_by_count').order('trigger'),
    ]);

    // Nest templates under characters
    const tmplsByChar = {};
    for (const t of templates ?? []) {
      (tmplsByChar[t.character_id] ??= []).push(t);
    }

    const charsByUser = {};
    for (const c of characters ?? []) {
      (charsByUser[c.user_id] ??= []).push({ ...c, templates: tmplsByChar[c.id] ?? [] });
    }

    const libByUser = {};
    for (const b of userLibrary ?? []) {
      (libByUser[b.user_id] ??= []).push(b);
    }

    const snapshot = {
      exported_at:   new Date().toISOString(),
      users: (users ?? []).map(u => ({
        ...u,
        characters:   charsByUser[u.id]  ?? [],
        user_library: libByUser[u.id]    ?? [],
      })),
      board_library: boardLibrary ?? [],
    };

    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `inkform_export_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    exportAllStatus.textContent = '✓ Export downloaded';
    exportAllStatus.style.color = 'var(--color-teal)';
  } catch (err) {
    exportAllStatus.textContent = `Error: ${err.message}`;
    exportAllStatus.style.color = 'var(--color-danger)';
  } finally {
    exportAllBtn.disabled = false;
    exportAllBtn.textContent = 'Export all users (system JSON)';
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.body.style.visibility = '';
await loadUsers();

// Pre-fetch queue count for badge
supabase
  .from('board_library')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'pending')
  .then(({ count }) => {
    if (count) {
      queueCount.textContent = String(count);
      queueCount.hidden = false;
    }
  });
