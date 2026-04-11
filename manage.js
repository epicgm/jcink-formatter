/**
 * manage.js — Character, template, and library block management
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import {
  checkOnline,
  showOfflineBanner,
  hideOfflineBanner,
  enqueueWrite,
  replayQueue,
  watchOnlineRecovery,
} from './offline.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// ── Auth guard ────────────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = 'index.html'; }
const userId = session.user.id;

const _adminLink = document.getElementById('admin-link');
if (_adminLink && localStorage.getItem('inkform_role') === 'admin') _adminLink.hidden = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

// Tabs
const tabBtns       = document.querySelectorAll('.tab-btn');

// Characters
const charList      = document.getElementById('char-list');
const charEmpty     = document.getElementById('char-empty');
const newCharBtn    = document.getElementById('new-char-btn');
const charDialog    = document.getElementById('char-dialog');
const charForm      = document.getElementById('char-form');
const charNameIn    = document.getElementById('char-name-input');
const charDlgTitle  = document.getElementById('char-dialog-title');

// Templates
const tmplCharSel   = document.getElementById('tmpl-char-select');
const tmplList      = document.getElementById('tmpl-list');
const tmplEmpty     = document.getElementById('tmpl-empty');
const newTmplBtn    = document.getElementById('new-tmpl-btn');
const tmplDialog    = document.getElementById('tmpl-dialog');
const tmplForm      = document.getElementById('tmpl-form');
const tmplDlgTitle  = document.getElementById('tmpl-dialog-title');
const tmplNameIn    = document.getElementById('tmpl-name-input');
const tmplShellIn   = document.getElementById('tmpl-shell-input');
const tmplDlgOpen   = document.getElementById('tmpl-dlg-open');
const tmplDlgClose  = document.getElementById('tmpl-dlg-close');
const tmplThkOpen   = document.getElementById('tmpl-thk-open');
const tmplThkClose  = document.getElementById('tmpl-thk-close');
const tmplBlocksList  = document.getElementById('tmpl-blocks-list');
const tmplBlocksEmpty = document.getElementById('tmpl-blocks-empty');

// Library
const blockList     = document.getElementById('block-list');
const blockEmpty    = document.getElementById('block-empty');
const newBlockBtn   = document.getElementById('new-block-btn');
const blockDialog   = document.getElementById('block-dialog');
const blockForm     = document.getElementById('block-form');
const blockDlgTitle = document.getElementById('block-dialog-title');
const blockTrigIn   = document.getElementById('block-trigger-input');
const blockHtmlIn   = document.getElementById('block-html-input');

// Navbar
const themeToggle   = document.getElementById('theme-toggle');
const logoutBtn     = document.getElementById('logout-btn');

// ── State ─────────────────────────────────────────────────────────────────────

let _editCharId   = null;
let _editTmplId   = null;
let _editBlockId  = null;
let _isOnline     = true;

// ── Theme toggle ──────────────────────────────────────────────────────────────

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('inkform-theme', next);
  themeToggle.querySelector('.theme-toggle-icon').textContent = next === 'dark' ? '☀' : '☽';
});

// Sync icon with current theme on load
if (document.documentElement.getAttribute('data-theme') === 'dark') {
  themeToggle.querySelector('.theme-toggle-icon').textContent = '☀';
}

// ── Logout ────────────────────────────────────────────────────────────────────

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
  });
});

// ── Dialog helpers ────────────────────────────────────────────────────────────

document.querySelectorAll('.dialog-cancel').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

document.querySelectorAll('.manage-dialog').forEach(dlg => {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
});

// ── CHARACTERS ────────────────────────────────────────────────────────────────

async function loadCharacters() {
  const { data } = await supabase
    .from('characters')
    .select('id, name')
    .eq('user_id', userId)
    .order('name');

  const chars = data ?? [];
  renderCharList(chars);
  syncCharDropdown(chars);
}

function renderCharList(chars) {
  charList.innerHTML = '';
  charEmpty.hidden = chars.length > 0;
  for (const c of chars) {
    charList.appendChild(makeItemRow(c.name, [
      { label: 'Edit',   cls: 'btn-ghost',  fn: () => openCharEdit(c) },
      { label: 'Delete', cls: 'btn-danger', fn: () => deleteChar(c.id, c.name) },
    ]));
  }
}

function syncCharDropdown(chars) {
  const prev = tmplCharSel.value;
  tmplCharSel.innerHTML = '<option value="">— Select character —</option>';
  for (const c of chars) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    tmplCharSel.appendChild(opt);
  }
  if (prev) tmplCharSel.value = prev;
}

newCharBtn.addEventListener('click', () => {
  _editCharId = null;
  charDlgTitle.textContent = 'New Character';
  charNameIn.value = '';
  charDialog.showModal();
  charNameIn.focus();
});

function openCharEdit(c) {
  _editCharId = c.id;
  charDlgTitle.textContent = 'Edit Character';
  charNameIn.value = c.name;
  charDialog.showModal();
  charNameIn.focus();
}

charForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = charNameIn.value.trim();
  if (!name) return;

  if (!_isOnline) {
    // Queue simple rename updates; skip new-character inserts (forwardfill can't run offline)
    if (_editCharId) {
      enqueueWrite({ table: 'characters', op: 'update', id: _editCharId, payload: { name } });
      charDialog.close();
      // Optimistic update in the list
      await loadCharacters();
    } else {
      alert('Cannot create a new character while offline. Please reconnect first.');
    }
    return;
  }

  try {
    if (_editCharId) {
      const { error } = await supabase.from('characters').update({ name }).eq('id', _editCharId);
      if (error) throw error;
    } else {
      const { data: newChars, error: insertErr } = await supabase
        .from('characters')
        .insert({ user_id: userId, name })
        .select('id');
      if (insertErr) throw insertErr;

      if (newChars?.length) {
        const { data: autoBlocks } = await supabase
          .from('user_library')
          .select('id')
          .eq('user_id', userId)
          .eq('auto_add_new_chars', true);

        if (autoBlocks?.length) {
          await supabase.from('templates').insert({
            character_id:     newChars[0].id,
            name:             'Default',
            active_block_ids: autoBlocks.map(b => b.id),
          });
        }
      }
    }
  } catch {
    alert('Could not save that change. Try again or export a backup from the Library page.');
    return;
  }

  charDialog.close();
  await loadCharacters();
});

async function deleteChar(id, name) {
  if (!confirm(`Delete "${name}" and all its templates?`)) return;
  await supabase.from('characters').delete().eq('id', id);
  await loadCharacters();
  if (tmplCharSel.value === id) {
    tmplCharSel.value = '';
    renderTemplateList([]);
    tmplEmpty.textContent = 'Select a character to see templates.';
    tmplEmpty.hidden = false;
    newTmplBtn.disabled = true;
  }
}

// ── TEMPLATES ─────────────────────────────────────────────────────────────────

tmplCharSel.addEventListener('change', async () => {
  const charId = tmplCharSel.value;
  newTmplBtn.disabled = !charId;
  await loadTemplates(charId);
});

async function loadTemplates(charId) {
  tmplList.innerHTML = '';
  if (!charId) {
    tmplEmpty.textContent = 'Select a character to see templates.';
    tmplEmpty.hidden = false;
    return;
  }

  const { data } = await supabase
    .from('templates')
    .select('id, name, shell_html, rules_json, active_block_ids')
    .eq('character_id', charId)
    .order('name');

  renderTemplateList(data ?? []);
}

function renderTemplateList(tmpls) {
  tmplList.innerHTML = '';
  tmplEmpty.hidden = tmpls.length > 0;
  tmplEmpty.textContent = 'No templates for this character yet.';
  for (const t of tmpls) {
    tmplList.appendChild(makeItemRow(t.name, [
      { label: 'Edit',   cls: 'btn-ghost',  fn: () => openTmplEdit(t) },
      { label: 'Delete', cls: 'btn-danger', fn: () => deleteTmpl(t.id, t.name) },
    ]));
  }
}

newTmplBtn.addEventListener('click', async () => {
  _editTmplId = null;
  tmplDlgTitle.textContent = 'New Template';
  tmplNameIn.value = '';
  tmplShellIn.value = '';
  tmplDlgOpen.value = '';
  tmplDlgClose.value = '';
  tmplThkOpen.value = '';
  tmplThkClose.value = '';
  await populateBlockChecklist([]);
  tmplDialog.showModal();
  tmplNameIn.focus();
});

async function openTmplEdit(t) {
  _editTmplId = t.id;
  tmplDlgTitle.textContent = 'Edit Template';
  tmplNameIn.value = t.name;
  tmplShellIn.value = t.shell_html ?? '';
  const r = t.rules_json ?? {};
  tmplDlgOpen.value  = r.dialogueOpen  ?? '';
  tmplDlgClose.value = r.dialogueClose ?? '';
  tmplThkOpen.value  = r.thoughtOpen   ?? '';
  tmplThkClose.value = r.thoughtClose  ?? '';
  await populateBlockChecklist(t.active_block_ids ?? []);
  tmplDialog.showModal();
  tmplNameIn.focus();
}

async function populateBlockChecklist(activeIds) {
  const { data } = await supabase
    .from('user_library')
    .select('id, trigger')
    .eq('user_id', userId)
    .order('trigger');

  const blocks = data ?? [];
  tmplBlocksList.innerHTML = '';
  tmplBlocksEmpty.hidden = blocks.length > 0;

  for (const b of blocks) {
    const label = document.createElement('label');
    label.className = 'block-check-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = b.id;
    cb.checked = activeIds.includes(b.id);
    label.appendChild(cb);
    label.append(` ::${b.trigger}::`);
    tmplBlocksList.appendChild(label);
  }
}

tmplForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = tmplNameIn.value.trim();
  if (!name) return;

  if (!_isOnline) {
    if (_editTmplId) {
      const rules = {};
      if (tmplDlgOpen.value.trim())  rules.dialogueOpen  = tmplDlgOpen.value.trim();
      if (tmplDlgClose.value.trim()) rules.dialogueClose = tmplDlgClose.value.trim();
      if (tmplThkOpen.value.trim())  rules.thoughtOpen   = tmplThkOpen.value.trim();
      if (tmplThkClose.value.trim()) rules.thoughtClose  = tmplThkClose.value.trim();
      enqueueWrite({
        table: 'templates',
        op: 'update',
        id: _editTmplId,
        payload: {
          name,
          shell_html: tmplShellIn.value.trim() || null,
          rules_json: Object.keys(rules).length ? rules : null,
        },
      });
      tmplDialog.close();
      await loadTemplates(tmplCharSel.value);
    } else {
      alert('Cannot create a new template while offline. Please reconnect first.');
    }
    return;
  }

  const rules = {};
  if (tmplDlgOpen.value.trim())  rules.dialogueOpen  = tmplDlgOpen.value.trim();
  if (tmplDlgClose.value.trim()) rules.dialogueClose = tmplDlgClose.value.trim();
  if (tmplThkOpen.value.trim())  rules.thoughtOpen   = tmplThkOpen.value.trim();
  if (tmplThkClose.value.trim()) rules.thoughtClose  = tmplThkClose.value.trim();

  // Explicitly checked blocks from the dialog
  const checkedIds = [...tmplBlocksList.querySelectorAll('input[type=checkbox]:checked')]
    .map(cb => cb.value);

  let activeIds = checkedIds;

  // Forwardfill: merge in auto_add_new_templates blocks for new templates
  if (!_editTmplId) {
    const { data: autoBlocks } = await supabase
      .from('user_library')
      .select('id')
      .eq('user_id', userId)
      .eq('auto_add_new_templates', true);

    if (autoBlocks?.length) {
      const autoIds = autoBlocks.map(b => b.id);
      activeIds = [...new Set([...checkedIds, ...autoIds])];
    }
  }

  const payload = {
    name,
    shell_html:       tmplShellIn.value.trim() || null,
    rules_json:       Object.keys(rules).length ? rules : null,
    active_block_ids: activeIds.length ? activeIds : null,
  };

  try {
    if (_editTmplId) {
      const { error } = await supabase.from('templates').update(payload).eq('id', _editTmplId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('templates').insert({ ...payload, character_id: tmplCharSel.value });
      if (error) throw error;
    }
  } catch {
    alert('Could not save that change. Try again or export a backup from the Library page.');
    return;
  }

  tmplDialog.close();
  await loadTemplates(tmplCharSel.value);
});

async function deleteTmpl(id, name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  await supabase.from('templates').delete().eq('id', id);
  await loadTemplates(tmplCharSel.value);
}

// ── LIBRARY ───────────────────────────────────────────────────────────────────

async function loadLibrary() {
  const { data } = await supabase
    .from('user_library')
    .select('id, trigger, replacement_html, is_global')
    .eq('user_id', userId)
    .order('trigger');

  const blocks = data ?? [];
  blockList.innerHTML = '';
  blockEmpty.hidden = blocks.length > 0;

  for (const b of blocks) {
    const label = `::${b.trigger}::${b.is_global ? '  (global)' : ''}`;
    blockList.appendChild(makeItemRow(label, [
      { label: 'Edit',   cls: 'btn-ghost',  fn: () => openBlockEdit(b) },
      { label: 'Delete', cls: 'btn-danger', fn: () => deleteBlock(b.id, b.trigger) },
    ]));
  }
}

newBlockBtn.addEventListener('click', () => {
  _editBlockId = null;
  blockDlgTitle.textContent = 'New Library Block';
  blockTrigIn.value = '';
  blockHtmlIn.value = '';
  blockDialog.showModal();
  blockTrigIn.focus();
});

function openBlockEdit(b) {
  _editBlockId = b.id;
  blockDlgTitle.textContent = 'Edit Library Block';
  blockTrigIn.value = b.trigger;
  blockHtmlIn.value = b.replacement_html ?? '';
  blockDialog.showModal();
  blockTrigIn.focus();
}

blockForm.addEventListener('submit', async e => {
  e.preventDefault();
  const trigger = blockTrigIn.value.trim();
  if (!trigger) return;

  const payload = {
    trigger,
    replacement_html: blockHtmlIn.value.trim() || null,
  };

  if (_editBlockId) {
    await supabase.from('user_library').update(payload).eq('id', _editBlockId);
  } else {
    await supabase.from('user_library').insert({ ...payload, user_id: userId });
  }

  blockDialog.close();
  await loadLibrary();
});

async function deleteBlock(id, trigger) {
  if (!confirm(`Delete library block "::${trigger}::"?`)) return;
  await supabase.from('user_library').delete().eq('id', id);
  await loadLibrary();
}

// ── Shared row builder ────────────────────────────────────────────────────────

function makeItemRow(label, actions) {
  const row = document.createElement('div');
  row.className = 'item-row';

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = label;
  row.appendChild(name);

  const acts = document.createElement('div');
  acts.className = 'item-actions';
  for (const { label: lbl, cls, fn } of actions) {
    const btn = document.createElement('button');
    btn.className = `btn-sm ${cls}`;
    btn.textContent = lbl;
    btn.type = 'button';
    btn.addEventListener('click', fn);
    acts.appendChild(btn);
  }
  row.appendChild(acts);
  return row;
}

// ── Welcome onboarding shortcut ───────────────────────────────────────────────
// manage.html?welcome=1 — auto-open the New Character dialog

function handleWelcomeParam() {
  if (new URLSearchParams(window.location.search).get('welcome') === '1') {
    _editCharId = null;
    charDlgTitle.textContent = 'Create your first character';
    charNameIn.value = '';
    charDialog.showModal();
    charNameIn.focus();
    // Clean URL without reload
    history.replaceState({}, '', window.location.pathname);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

_isOnline = await checkOnline();
if (!_isOnline) {
  showOfflineBanner();
  watchOnlineRecovery(async () => {
    hideOfflineBanner();
    _isOnline = true;
    await replayQueue(supabase);
    await loadCharacters();
    await loadLibrary();
  });
}
await loadCharacters();
await loadLibrary();
handleWelcomeParam();
