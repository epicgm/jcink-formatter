/**
 * library.js — My Library and Board Library management
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient }     from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { mountBlockBuilder } from './block-builder.js';
import {
  checkOnline,
  showOfflineBanner,
  hideOfflineBanner,
  enqueueWrite,
  replayQueue,
  watchOnlineRecovery,
} from './offline.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Hide immediately — revealed only after session confirmed, preventing flash.
document.body.style.visibility = 'hidden';

// ── Auth guard ────────────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;

const _adminLink = document.getElementById('admin-link');
if (_adminLink && localStorage.getItem('inkform_role') === 'admin') _adminLink.hidden = false;

const _navUsername = document.getElementById('nav-username');
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// ── DOM refs ──────────────────────────────────────────────────────────────────

// Tabs
const tabBtns         = document.querySelectorAll('.tab-btn');

// My Library
const newBlockToggle  = document.getElementById('new-block-toggle');
const builderWrap     = document.getElementById('block-builder-wrap');
const myBlocksGrid    = document.getElementById('my-blocks-grid');
const myEmpty         = document.getElementById('my-empty');

// Board Library
const boardBlocksGrid = document.getElementById('board-blocks-grid');
const boardEmpty      = document.getElementById('board-empty');

// Global dialog
const globalDialog    = document.getElementById('global-dialog');
const globalForm      = document.getElementById('global-form');
const globalTriggerEl = document.getElementById('global-dialog-trigger');
const globalCharsWrap = document.getElementById('global-chars-wrap');
const globalCharsLoad = document.getElementById('global-chars-loading');
const backfillRadios  = () => [...globalForm.querySelectorAll('input[name=backfill]')];

// Edit dialog
const editDialog      = document.getElementById('edit-dialog');
const editForm        = document.getElementById('edit-form');
const editTriggerIn   = document.getElementById('edit-trigger');
const editHtmlIn      = document.getElementById('edit-html');

// Export / Import
const exportBtn       = document.getElementById('export-btn');
const importBtn       = document.getElementById('import-btn');
const importFileIn    = document.getElementById('import-file-input');
const importDialog    = document.getElementById('import-dialog');
const importPreview   = document.getElementById('import-preview');
const importConfirmBtn = document.getElementById('import-confirm-btn');

// Navbar
const themeToggle     = document.getElementById('theme-toggle');
const logoutBtn       = document.getElementById('logout-btn');

// Suggest dialog
const suggestDialog     = document.getElementById('suggest-dialog');
const suggestTriggerEl  = document.getElementById('suggest-dialog-trigger');
const suggestConfirmBtn = document.getElementById('suggest-confirm-btn');

// Diff dialog
const diffDialog        = document.getElementById('diff-dialog');
const diffTriggerEl     = document.getElementById('diff-dialog-trigger');
const diffBlock         = document.getElementById('diff-block');
const diffSyncBtn       = document.getElementById('diff-sync-btn');
const diffKeepBtn       = document.getElementById('diff-keep-btn');

// ── State ─────────────────────────────────────────────────────────────────────

let _globalBlock   = null;  // block being made global
let _editBlockId   = null;
let _builderOpen   = false;
let _suggestBlock  = null;  // block pending suggest confirmation
let _diffBlock     = null;  // { userBlockId, boardHtml } pending sync decision
let _isOnline      = true;
let _importData    = null;  // parsed import JSON pending confirmation

// ── Theme toggle ──────────────────────────────────────────────────────────────

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
    if (target === 'board') loadBoardLibrary();
  });
});

// ── Dialog helpers ────────────────────────────────────────────────────────────

document.querySelectorAll('.dialog-cancel').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});
document.querySelectorAll('.manage-dialog').forEach(dlg => {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
});

// ── Inline block builder ──────────────────────────────────────────────────────

newBlockToggle.addEventListener('click', () => {
  _builderOpen = !_builderOpen;
  builderWrap.hidden = !_builderOpen;
  newBlockToggle.textContent = _builderOpen ? '✕ Close' : '+ New Block';
  if (_builderOpen) builderWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

mountBlockBuilder(builderWrap, {
  onSave: async ({ trigger, replacement_html }) => {
    if (!_isOnline) {
      // Queue for later sync; optimistically add to UI
      enqueueWrite({
        table:   'user_library',
        op:      'insert',
        payload: { user_id: userId, trigger, replacement_html },
      });
    } else {
      const { error } = await supabase
        .from('user_library')
        .insert({ user_id: userId, trigger, replacement_html });
      if (error) throw error;
    }
    await loadMyLibrary();
    // Collapse builder after save
    _builderOpen = false;
    builderWrap.hidden = true;
    newBlockToggle.textContent = '+ New Block';
  },
});

// ── MY LIBRARY ────────────────────────────────────────────────────────────────

async function loadMyLibrary() {
  const { data } = await supabase
    .from('user_library')
    .select('id, trigger, replacement_html, is_global, auto_add_new_chars, auto_add_new_templates, forked_from, board_source_id')
    .eq('user_id', userId)
    .order('trigger');

  const blocks = data ?? [];
  myEmpty.hidden = blocks.length > 0;
  myBlocksGrid.innerHTML = '';

  // Batch-fetch board blocks for all "Add" copies to detect updates
  const boardSourceIds = blocks.map(b => b.board_source_id).filter(Boolean);
  const boardHtmlMap = {};
  if (boardSourceIds.length) {
    const { data: boardBlocks } = await supabase
      .from('board_library')
      .select('id, replacement_html')
      .in('id', boardSourceIds);
    for (const bb of boardBlocks ?? []) boardHtmlMap[bb.id] = bb.replacement_html;
  }

  for (const b of blocks) {
    const hasUpdate = b.board_source_id
      && boardHtmlMap[b.board_source_id] !== undefined
      && boardHtmlMap[b.board_source_id] !== b.replacement_html;
    myBlocksGrid.appendChild(makeMyCard(b, hasUpdate ? boardHtmlMap[b.board_source_id] : null));
  }
}

function makeMyCard(b, boardUpdatedHtml = null) {
  const card = document.createElement('div');
  card.className = 'block-card';
  card.dataset.id = b.id;

  // Header: trigger + global chip
  const header = document.createElement('div');
  header.className = 'block-card-header';

  const trigger = document.createElement('span');
  trigger.className = 'block-card-trigger';
  trigger.textContent = `::${b.trigger}::`;
  header.appendChild(trigger);

  const globalChip = document.createElement('button');
  globalChip.type = 'button';
  globalChip.className = `chip block-global-chip${b.is_global ? ' active' : ''}`;
  globalChip.textContent = b.is_global ? 'Global' : 'Personal';
  globalChip.title = b.is_global ? 'Click to remove global status' : 'Click to mark as global';
  globalChip.addEventListener('click', () => openGlobalDialog(b));
  header.appendChild(globalChip);

  card.appendChild(header);

  // Preview
  const preview = document.createElement('div');
  preview.className = 'block-card-preview output-area';
  // Renders user's own HTML intentionally
  preview.innerHTML = b.replacement_html || '<span class="output-placeholder">No HTML set.</span>';
  card.appendChild(preview);

  // Source badge (for board copies) + update badge
  if (b.board_source_id) {
    const badgeRow = document.createElement('div');
    badgeRow.className = 'block-card-badge-row';

    const badge = document.createElement('p');
    badge.className = 'block-card-badge';
    badge.textContent = 'Locked board copy';
    badgeRow.appendChild(badge);

    if (boardUpdatedHtml !== null) {
      const updateBtn = document.createElement('button');
      updateBtn.type = 'button';
      updateBtn.className = 'update-badge';
      updateBtn.textContent = 'Update available';
      updateBtn.addEventListener('click', () => openDiffDialog(b, boardUpdatedHtml));
      badgeRow.appendChild(updateBtn);
    }

    card.appendChild(badgeRow);
  } else if (b.forked_from) {
    const badge = document.createElement('p');
    badge.className = 'block-card-badge';
    badge.textContent = 'Forked from board';
    card.appendChild(badge);
  }

  // Footer: actions
  const footer = document.createElement('div');
  footer.className = 'block-card-footer';

  const editBtn = makeBtn('Edit', 'btn-sm btn-ghost', () => openEditDialog(b));
  const delBtn  = makeBtn('Delete', 'btn-sm btn-danger', () => deleteBlock(b.id, b.trigger));
  footer.appendChild(editBtn);
  footer.appendChild(delBtn);

  // "Suggest to board" — only for personal blocks (not board copies/forks)
  if (!b.board_source_id && !b.forked_from) {
    const suggestBtn = makeBtn('Suggest to board', 'btn-sm btn-ghost', () => suggestToBoard(b));
    footer.appendChild(suggestBtn);
  }

  card.appendChild(footer);
  return card;
}

// ── Global dialog ─────────────────────────────────────────────────────────────

async function openGlobalDialog(b) {
  // If already global, just toggle off immediately
  if (b.is_global) {
    if (!confirm(`Remove global status from ::${b.trigger}::?`)) return;
    await supabase.from('user_library')
      .update({ is_global: false, auto_add_new_chars: false, auto_add_new_templates: false })
      .eq('id', b.id);
    await loadMyLibrary();
    return;
  }

  _globalBlock = b;
  globalTriggerEl.textContent = `::${b.trigger}::`;

  // Reset form
  globalForm.querySelector('input[name=backfill][value=all]').checked = true;
  globalForm.querySelector('input[name=autoChars][value=yes]').checked = true;
  globalForm.querySelector('input[name=autoTmpls][value=yes]').checked = true;
  globalCharsWrap.hidden = true;

  // Pre-load characters into the checklist
  await populateGlobalCharList();

  // Show/hide char checklist on radio change
  backfillRadios().forEach(r => {
    r.onchange = () => {
      globalCharsWrap.hidden = r.value !== 'choose' || !r.checked;
    };
  });

  globalDialog.showModal();
}

async function populateGlobalCharList() {
  const { data } = await supabase
    .from('characters')
    .select('id, name')
    .eq('user_id', userId)
    .order('name');

  globalCharsWrap.innerHTML = '';

  if (!data?.length) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No characters found.';
    globalCharsWrap.appendChild(p);
    return;
  }

  for (const c of data) {
    const label = document.createElement('label');
    label.className = 'block-check-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = true;
    label.appendChild(cb);
    label.append(` ${c.name}`);
    globalCharsWrap.appendChild(label);
  }
}

globalForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (!_globalBlock) return;

  const backfill     = globalForm.querySelector('input[name=backfill]:checked').value;
  const autoChars    = globalForm.querySelector('input[name=autoChars]:checked').value === 'yes';
  const autoTmpls    = globalForm.querySelector('input[name=autoTmpls]:checked').value === 'yes';

  // Update the block
  const { error } = await supabase
    .from('user_library')
    .update({ is_global: true, auto_add_new_chars: autoChars, auto_add_new_templates: autoTmpls })
    .eq('id', _globalBlock.id);
  if (error) { alert(error.message); return; }

  // Backfill
  if (backfill !== 'none') {
    let charIds;

    if (backfill === 'all') {
      const { data: chars } = await supabase
        .from('characters')
        .select('id')
        .eq('user_id', userId);
      charIds = (chars ?? []).map(c => c.id);
    } else {
      // "choose" — read checked boxes
      charIds = [...globalCharsWrap.querySelectorAll('input[type=checkbox]:checked')]
        .map(cb => cb.value);
    }

    if (charIds.length) {
      await backfillBlockToCharacters(_globalBlock.id, charIds);
    }
  }

  globalDialog.close();
  _globalBlock = null;
  await loadMyLibrary();
});

async function backfillBlockToCharacters(blockId, charIds) {
  const { data: tmpls } = await supabase
    .from('templates')
    .select('id, active_block_ids')
    .in('character_id', charIds);

  if (!tmpls?.length) return;

  const updates = tmpls
    .filter(t => !(t.active_block_ids ?? []).includes(blockId))
    .map(t => supabase.from('templates').update({
      active_block_ids: [...(t.active_block_ids ?? []), blockId],
    }).eq('id', t.id));

  await Promise.all(updates);
}

// ── Edit dialog ───────────────────────────────────────────────────────────────

function openEditDialog(b) {
  _editBlockId = b.id;
  editTriggerIn.value = b.trigger;
  editHtmlIn.value    = b.replacement_html ?? '';
  editDialog.showModal();
  editTriggerIn.focus();
}

editForm.addEventListener('submit', async e => {
  e.preventDefault();
  const trigger = editTriggerIn.value.trim();
  if (!trigger) return;

  await supabase.from('user_library').update({
    trigger,
    replacement_html: editHtmlIn.value.trim() || null,
  }).eq('id', _editBlockId);

  editDialog.close();
  await loadMyLibrary();
});

async function deleteBlock(id, trigger) {
  if (!confirm(`Delete library block "::${trigger}::"?\n\nIt will be removed from all templates that use it.`)) return;
  await supabase.from('user_library').delete().eq('id', id);
  await loadMyLibrary();
}

// ── Suggest to board ──────────────────────────────────────────────────────────

function suggestToBoard(b) {
  _suggestBlock = b;
  suggestTriggerEl.textContent = `::${b.trigger}::`;
  suggestDialog.showModal();
  suggestConfirmBtn.focus();
}

suggestConfirmBtn.addEventListener('click', async () => {
  if (!_suggestBlock) return;
  suggestConfirmBtn.disabled = true;
  suggestConfirmBtn.textContent = 'Submitting…';

  const { error } = await supabase.from('board_library').insert({
    trigger:          _suggestBlock.trigger,
    replacement_html: _suggestBlock.replacement_html,
    added_by:         userId,
    status:           'pending',
  });

  suggestConfirmBtn.disabled = false;
  suggestConfirmBtn.textContent = 'Submit for review';
  suggestDialog.close();
  _suggestBlock = null;

  if (error) {
    alert(`Could not suggest block: ${error.message}`);
  }
});

// ── Diff / update propagation ─────────────────────────────────────────────────

function openDiffDialog(b, boardHtml) {
  _diffBlock = { userBlockId: b.id, boardHtml };
  diffTriggerEl.textContent = `::${b.trigger}::`;
  diffBlock.innerHTML = '';

  const mine   = (b.replacement_html ?? '').split('\n');
  const theirs = (boardHtml ?? '').split('\n');
  const maxLen = Math.max(mine.length, theirs.length);

  for (let i = 0; i < maxLen; i++) {
    const mLine = mine[i]   ?? null;
    const tLine = theirs[i] ?? null;

    if (mLine === tLine) {
      diffBlock.appendChild(makeDiffLine(mLine, 'same'));
    } else {
      if (mLine !== null) diffBlock.appendChild(makeDiffLine(mLine,  'removed'));
      if (tLine !== null) diffBlock.appendChild(makeDiffLine(tLine,  'added'));
    }
  }

  diffDialog.showModal();
}

function makeDiffLine(text, type) {
  const el = document.createElement('div');
  el.className = `diff-line diff-line--${type}`;
  const prefix = type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
  el.textContent = `${prefix} ${text}`;
  return el;
}

diffSyncBtn.addEventListener('click', async () => {
  if (!_diffBlock) return;
  diffSyncBtn.disabled = true;
  diffSyncBtn.textContent = 'Syncing…';

  await supabase.from('user_library')
    .update({ replacement_html: _diffBlock.boardHtml })
    .eq('id', _diffBlock.userBlockId);

  diffSyncBtn.disabled = false;
  diffSyncBtn.textContent = 'Sync to board version';
  diffDialog.close();
  _diffBlock = null;
  await loadMyLibrary();
});

diffKeepBtn.addEventListener('click', () => {
  diffDialog.close();
  _diffBlock = null;
});

// ── BOARD LIBRARY ─────────────────────────────────────────────────────────────

async function loadBoardLibrary() {
  boardBlocksGrid.innerHTML = '<p class="empty-state">Loading…</p>';
  boardEmpty.hidden = true;

  const { data } = await supabase
    .from('board_library')
    .select('id, trigger, replacement_html, used_by_count')
    .eq('status', 'published')
    .order('trigger');

  const blocks = data ?? [];
  boardBlocksGrid.innerHTML = '';
  boardEmpty.hidden = blocks.length > 0;

  for (const b of blocks) {
    boardBlocksGrid.appendChild(makeBoardCard(b));
  }
}

function makeBoardCard(b) {
  const card = document.createElement('div');
  card.className = 'block-card';

  // Header
  const header = document.createElement('div');
  header.className = 'block-card-header';

  const trigger = document.createElement('span');
  trigger.className = 'block-card-trigger';
  trigger.textContent = `::${b.trigger}::`;
  header.appendChild(trigger);

  if (b.used_by_count > 0) {
    const badge = document.createElement('span');
    badge.className = 'chip';
    badge.style.fontSize = '11px';
    badge.textContent = `${b.used_by_count} using`;
    header.appendChild(badge);
  }

  card.appendChild(header);

  // Preview
  const preview = document.createElement('div');
  preview.className = 'block-card-preview output-area';
  preview.innerHTML = b.replacement_html || '<span class="output-placeholder">No HTML set.</span>';
  card.appendChild(preview);

  // Footer: Add + Fork
  const footer = document.createElement('div');
  footer.className = 'block-card-footer';

  const addBtn  = makeBtn('Add to my library',  'btn-sm btn-secondary', () => addFromBoard(b));
  const forkBtn = makeBtn('Fork to my library', 'btn-sm btn-ghost',     () => forkFromBoard(b));
  footer.appendChild(addBtn);
  footer.appendChild(forkBtn);
  card.appendChild(footer);

  return card;
}

async function addFromBoard(b) {
  // Locked copy — tracks board version; forked_from stays null per spec
  const { error } = await supabase.from('user_library').insert({
    user_id:          userId,
    trigger:          b.trigger,
    replacement_html: b.replacement_html,
    board_source_id:  b.id,   // tracks the board block for future updates
    forked_from:      null,
  });

  if (error) { alert(error.message); return; }

  // Increment board used_by_count
  await supabase.rpc('board_library_increment_used_by', { block_id: b.id });

  alert(`"::${b.trigger}::" added to your library as a locked board copy.`);
  await loadBoardLibrary();
}

async function forkFromBoard(b) {
  // Personal editable copy — forked_from = board block id per spec
  const { error } = await supabase.from('user_library').insert({
    user_id:          userId,
    trigger:          b.trigger,
    replacement_html: b.replacement_html,
    board_source_id:  null,
    forked_from:      b.id,   // records which board block this was forked from
  });

  if (error) { alert(error.message); return; }

  await supabase.rpc('board_library_increment_used_by', { block_id: b.id });

  alert(`"::${b.trigger}::" forked to your library. You can edit it freely.`);
  await loadBoardLibrary();
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function makeBtn(label, cls, fn) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener('click', fn);
  return btn;
}

// ── Export my characters ──────────────────────────────────────────────────────

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';

  try {
    // Fetch user profile for username
    const { data: profile } = await supabase
      .from('users')
      .select('username')
      .eq('id', userId)
      .single();

    // Fetch characters
    const { data: chars } = await supabase
      .from('characters')
      .select('id, name')
      .eq('user_id', userId)
      .order('name');

    // Fetch all templates for those characters
    const charIds = (chars ?? []).map(c => c.id);
    let tmplsByChar = {};
    if (charIds.length) {
      const { data: tmpls } = await supabase
        .from('templates')
        .select('id, character_id, name, shell_html, rules_json, active_block_ids')
        .in('character_id', charIds)
        .order('name');
      for (const t of tmpls ?? []) {
        (tmplsByChar[t.character_id] ??= []).push(t);
      }
    }

    // Fetch user_library
    const { data: library } = await supabase
      .from('user_library')
      .select('id, trigger, replacement_html, is_global')
      .eq('user_id', userId)
      .order('trigger');

    const payload = {
      exported_at:  new Date().toISOString(),
      version:      '1',
      user:         { username: profile?.username ?? '' },
      characters:   (chars ?? []).map(c => ({
        id:        c.id,
        name:      c.name,
        templates: tmplsByChar[c.id] ?? [],
      })),
      user_library: library ?? [],
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `characters_${(profile?.username ?? 'export').replace(/[^a-z0-9]/gi, '_')}_${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export my characters';
  }
});

// ── Import characters ─────────────────────────────────────────────────────────

importBtn.addEventListener('click', () => importFileIn.click());

importFileIn.addEventListener('change', () => {
  const file = importFileIn.files?.[0];
  if (!file) return;
  importFileIn.value = '';  // reset so same file can be re-selected

  const reader = new FileReader();
  reader.onload = e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      alert('Could not parse file — make sure it is a valid inkform export JSON.');
      return;
    }
    if (!Array.isArray(parsed?.characters)) {
      alert('Invalid export file: missing "characters" array.');
      return;
    }
    _importData = parsed;
    showImportPreview(parsed);
  };
  reader.readAsText(file);
});

function showImportPreview(data) {
  importPreview.innerHTML = '';

  const totalTemplates = data.characters.reduce((n, c) => n + (c.templates?.length ?? 0), 0);
  const totalBlocks    = data.user_library?.length ?? 0;

  const summary = document.createElement('p');
  summary.className = 'import-summary';
  summary.innerHTML =
    `<strong>${data.characters.length}</strong> character${data.characters.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ` +
    `<strong>${totalTemplates}</strong> template${totalTemplates !== 1 ? 's' : ''} &nbsp;·&nbsp; ` +
    `<strong>${totalBlocks}</strong> library block${totalBlocks !== 1 ? 's' : ''}`;
  importPreview.appendChild(summary);

  if (data.characters.length) {
    const ul = document.createElement('ul');
    ul.className = 'import-char-list';
    for (const c of data.characters) {
      const li = document.createElement('li');
      const count = c.templates?.length ?? 0;
      li.textContent = `${c.name} (${count} template${count !== 1 ? 's' : ''})`;
      ul.appendChild(li);
    }
    importPreview.appendChild(ul);
  }

  importDialog.showModal();
}

importConfirmBtn.addEventListener('click', async () => {
  if (!_importData) return;
  importConfirmBtn.disabled = true;
  importConfirmBtn.textContent = 'Importing…';

  try {
    // Step 1: Insert user_library blocks, build old_id → new_id map
    const idMap = {};
    for (const block of _importData.user_library ?? []) {
      const { data: inserted } = await supabase
        .from('user_library')
        .insert({
          user_id:         userId,
          trigger:         block.trigger,
          replacement_html: block.replacement_html,
          is_global:       block.is_global ?? false,
        })
        .select('id')
        .single();
      if (inserted) idMap[block.id] = inserted.id;
    }

    // Step 2: Insert characters + their templates
    for (const char of _importData.characters) {
      const { data: newChar } = await supabase
        .from('characters')
        .insert({ user_id: userId, name: char.name })
        .select('id')
        .single();
      if (!newChar) continue;

      for (const tmpl of char.templates ?? []) {
        const remappedIds = (tmpl.active_block_ids ?? [])
          .map(id => idMap[id])
          .filter(Boolean);

        await supabase.from('templates').insert({
          character_id:    newChar.id,
          name:            tmpl.name,
          shell_html:      tmpl.shell_html,
          rules_json:      tmpl.rules_json,
          active_block_ids: remappedIds.length ? remappedIds : null,
        });
      }
    }

    importDialog.close();
    _importData = null;
    await loadMyLibrary();
  } catch (err) {
    alert('Import failed. Make sure the file is a valid inkform export.');
  } finally {
    importConfirmBtn.disabled = false;
    importConfirmBtn.textContent = 'Import';
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.body.style.visibility = '';
_isOnline = await checkOnline();
if (!_isOnline) {
  showOfflineBanner();
  watchOnlineRecovery(async () => {
    hideOfflineBanner();
    _isOnline = true;
    await replayQueue(supabase);
    await loadMyLibrary();
  });
}
await loadMyLibrary();

// Auto-trigger import if navigated here from onboarding with ?import=1
if (new URLSearchParams(window.location.search).get('import') === '1') {
  history.replaceState({}, '', window.location.pathname);
  importFileIn.click();
}
