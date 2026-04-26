/**
 * home.js — Formatter page
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient }     from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { formatPost, convertBBCodeToHTML } from './parser.js';
import { withFeedback, makeWysiwygGroup, WYSIWYG_RULE_GROUPS } from './utils.js';
import { mountBlockBuilder } from './block-builder.js';
import {
  checkOnline,
  showOfflineBanner,
  hideOfflineBanner,
  watchOnlineRecovery,
  replayQueue,
} from './offline.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Hide immediately — revealed only after session confirmed, preventing flash.
document.body.style.visibility = 'hidden';

// ── Auth guard ────────────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;

// Show Admin nav link for admin users
const _adminLink = document.getElementById('admin-link');
if (_adminLink && (sessionStorage.getItem('userRole') ?? localStorage.getItem('inkform_role')) === 'admin') {
  _adminLink.hidden = false;
}

// Show logged-in username in nav
const _navUsername = document.getElementById('nav-username');
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const charCardRow     = document.getElementById('character-card-row');
const tmplCardRow     = document.getElementById('template-card-row');
const templateField   = document.getElementById('template-field');
const rawInput        = document.getElementById('raw-input');
const outputEl        = document.getElementById('formatted-output');
const copyBtn         = document.getElementById('copy-btn');
const logoutBtn       = document.getElementById('logout-btn');
const rulesDrawerToggle  = document.getElementById('rules-drawer-toggle');
const rulesDrawerBody    = document.getElementById('rules-drawer-body');
const shellWarningBanner = document.getElementById('shell-warning-banner');

// ── State ─────────────────────────────────────────────────────────────────────

let _templates     = {};   // id → full template object
let currentTmpl    = null;
let currentCharId  = null; // currently selected character id (for edit link)
let currentRepls   = [];
let _isOnline      = true;
let _copyContent   = '';   // formatted output WITH [dohtml] tags, used by copy btn

// ── localStorage helpers ──────────────────────────────────────────────────────

const CKEY_CHARS = (uid) => `jcink_chars_${uid}`;
const CKEY_TMPLS = (cid) => `jcink_tmpls_${cid}`;
const CKEY_REPLS = (tid) => `jcink_repls_${tid}`;

function cacheWrite(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
function cacheRead(key) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r).data : null; }
  catch { return null; }
}

// ── Card row builders ─────────────────────────────────────────────────────────

function buildCharCards(chars) {
  charCardRow.innerHTML = '';

  for (const c of chars) {
    const id  = `char-${c.id}`;
    const inp = document.createElement('input');
    inp.type  = 'radio';
    inp.name  = 'character';
    inp.id    = id;
    inp.value = c.id;
    inp.className = 'sr-only';
    inp.addEventListener('change', () => onCharacterSelect(c.id));

    const lbl = document.createElement('label');
    lbl.htmlFor   = id;
    lbl.className = 'character-card';
    lbl.textContent = c.name;

    charCardRow.appendChild(inp);
    charCardRow.appendChild(lbl);
  }

  // + New Character pill at end of row
  const addLink = document.createElement('a');
  addLink.href      = 'editor.html';
  addLink.className = 'character-card character-card--add';
  addLink.textContent = '+';
  addLink.title     = 'New character';
  charCardRow.appendChild(addLink);
}

function buildTmplCards(tmpls) {
  tmplCardRow.innerHTML = '';

  for (const t of tmpls) {
    const id  = `tmpl-${t.id}`;
    const inp = document.createElement('input');
    inp.type  = 'radio';
    inp.name  = 'template';
    inp.id    = id;
    inp.value = t.id;
    inp.className = 'sr-only';
    inp.addEventListener('change', () => onTemplateSelect(t.id));

    const lbl = document.createElement('label');
    lbl.htmlFor   = id;
    lbl.className = 'character-card';
    lbl.textContent = t.name;

    tmplCardRow.appendChild(inp);
    tmplCardRow.appendChild(lbl);
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadCharacters() {
  let chars;
  if (_isOnline) {
    const { data, error } = await supabase
      .from('characters')
      .select('id, name')
      .eq('user_id', userId)
      .order('name');
    if (error) console.warn('char load error', error.message);
    chars = data ?? cacheRead(CKEY_CHARS(userId)) ?? [];
    if (data) cacheWrite(CKEY_CHARS(userId), chars);
  } else {
    chars = cacheRead(CKEY_CHARS(userId)) ?? [];
  }

  // Zero characters → send to onboarding (editor)
  if (chars.length === 0) {
    window.location.replace('editor.html');
    throw 0;
  }

  buildCharCards(chars);

  // Auto-select first character
  const firstInput = charCardRow.querySelector('input[type=radio]');
  if (firstInput) {
    firstInput.checked = true;
    await onCharacterSelect(firstInput.value);
  }
}

async function loadTemplates(characterId) {
  _templates   = {};
  currentTmpl  = null;
  currentRepls = [];
  tmplCardRow.innerHTML = '';
  templateField.hidden  = true;
  templateField.classList.remove('template-field--visible');

  if (!characterId) return;

  let tmpls;
  if (_isOnline) {
    const { data } = await supabase
      .from('templates')
      .select('id, name, shell_html, rules_json, active_block_ids')
      .eq('character_id', characterId)
      .order('name');
    tmpls = data ?? cacheRead(CKEY_TMPLS(characterId)) ?? [];
    if (data) cacheWrite(CKEY_TMPLS(characterId), tmpls);
  } else {
    tmpls = cacheRead(CKEY_TMPLS(characterId)) ?? [];
  }

  for (const t of tmpls) _templates[t.id] = t;

  if (tmpls.length === 0) return;

  buildTmplCards(tmpls);
  templateField.hidden = false;
  // Trigger transition on next frame
  requestAnimationFrame(() => templateField.classList.add('template-field--visible'));

  // Auto-select first template
  const firstInput = tmplCardRow.querySelector('input[type=radio]');
  if (firstInput) {
    firstInput.checked = true;
    await onTemplateSelect(firstInput.value);
  }
}

async function loadReplacements(tmpl) {
  if (!tmpl?.active_block_ids?.length) return [];
  if (!_isOnline) return cacheRead(CKEY_REPLS(tmpl.id)) ?? [];

  const ids = tmpl.active_block_ids;
  const [{ data: userBlocks }, { data: boardBlocks }] = await Promise.all([
    supabase.from('user_library').select('trigger, replacement_html').in('id', ids),
    supabase.from('board_library').select('trigger, replacement_html').in('id', ids),
  ]);

  const repls = [...(userBlocks ?? []), ...(boardBlocks ?? [])];
  cacheWrite(CKEY_REPLS(tmpl.id), repls);
  return repls;
}

// ── Selection handlers ────────────────────────────────────────────────────────

async function onCharacterSelect(characterId) {
  currentCharId = characterId;
  await loadTemplates(characterId);
  updateOutput();
}

async function onTemplateSelect(tmplId) {
  currentTmpl  = _templates[tmplId] ?? null;
  currentRepls = await loadReplacements(currentTmpl);
  updateOutput();
  // Show amber warning when selected template has no shell HTML
  if (shellWarningBanner) {
    shellWarningBanner.hidden = !!(currentTmpl?.shell_html);
  }
  // Refresh drawer if it's open
  if (!rulesDrawerBody.hidden) renderRulesDrawer();
}

// ── Formatter ─────────────────────────────────────────────────────────────────

function updateOutput() {
  const raw      = rawInput.value;
  const shell    = currentTmpl?.shell_html ?? null;
  const rules    = currentTmpl?.rules_json ?? {};

  // Step 1: format content only (no shell) → raw BBCode string
  const bbContent = formatPost(raw, { replacements: currentRepls, rules });

  // Step 2: copy buffer gets BBCode content injected into shell as-is,
  //         preserving [dohtml] so it pastes correctly into Jcink.
  _copyContent = shell ? shell.replace('{{content}}', bbContent) : bbContent;

  // Step 3: convert ONLY the content BBCode to HTML (shell is real HTML —
  //         running BBCode conversion on it would corrupt CSS classes/styles).
  const htmlContent = convertBBCodeToHTML(bbContent);

  // Step 4: inject HTML content into shell, then strip [dohtml] wrappers
  //         (they are Jcink render directives, meaningless in a browser pane).
  const display = (shell ? shell.replace('{{content}}', htmlContent) : htmlContent)
    .replace(/\[dohtml\]/gi, '')
    .replace(/\[\/dohtml\]/gi, '');

  outputEl.innerHTML = display || '<span class="output-placeholder">Formatted output appears here…</span>';
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { return document.execCommand('copy'); }
  finally { document.body.removeChild(ta); }
}

// ── Events ────────────────────────────────────────────────────────────────────

rawInput.addEventListener('input', updateOutput);

copyBtn.addEventListener('click', async () => {
  const content = _copyContent;
  if (!content) return;

  const ok = await copyToClipboard(content);
  if (ok) {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('btn--copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('btn--copied');
    }, 2000);
  } else {
    copyBtn.textContent = 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
  }
});

// ── Rules drawer — WYSIWYG ────────────────────────────────────────────────────
// makeWysiwygGroup + WYSIWYG_RULE_GROUPS are imported from utils.js

function renderRulesDrawer() {
  rulesDrawerBody.innerHTML = '';

  if (!currentTmpl) {
    rulesDrawerBody.innerHTML = '<p class="rules-drawer-hint">Select a template to edit its rules.</p>';
    return;
  }

  // Working copy — WYSIWYG groups write into this as user edits
  const draftRules = { ...(currentTmpl.rules_json ?? {}) };

  // Hint — link to the actual edit-character page for this character
  const editUrl = currentCharId
    ? `editor.html?character_id=${currentCharId}`
    : 'manage.html';
  const hint = document.createElement('p');
  hint.className = 'rules-drawer-hint';
  hint.innerHTML = `Quick rule overrides for the selected template. <a href="${editUrl}">Edit character →</a>`;
  rulesDrawerBody.appendChild(hint);

  // WYSIWYG groups
  for (const group of WYSIWYG_RULE_GROUPS) {
    const section = makeWysiwygGroup(group, draftRules, (openKey, openVal, closeKey, closeVal) => {
      draftRules[openKey]  = openVal;
      draftRules[closeKey] = closeVal;
      livePreviewRules(draftRules);
    });
    rulesDrawerBody.appendChild(section);
  }

  // Footer: save button
  const footer = document.createElement('div');
  footer.className = 'rules-drawer-footer';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-primary btn-sm';
  saveBtn.textContent = 'Save Rules';
  saveBtn.addEventListener('click', () => saveRules(saveBtn, draftRules));

  const saveStatus = document.createElement('span');
  saveStatus.className = 'rules-save-status';
  saveStatus.id = 'rules-save-status';

  footer.appendChild(saveBtn);
  footer.appendChild(saveStatus);
  rulesDrawerBody.appendChild(footer);
}

function livePreviewRules(draftRules) {
  const shell    = currentTmpl?.shell_html ?? null;
  const bbCont   = formatPost(rawInput.value, { replacements: currentRepls, rules: draftRules });
  _copyContent   = shell ? shell.replace('{{content}}', bbCont) : bbCont;
  const htmlCont = convertBBCodeToHTML(bbCont);
  const display  = (shell ? shell.replace('{{content}}', htmlCont) : htmlCont)
    .replace(/\[dohtml\]/gi, '').replace(/\[\/dohtml\]/gi, '');
  outputEl.innerHTML = display || '<span class="output-placeholder">Formatted output appears here…</span>';
}

function getDraftRules() {
  // Collect from raw BBCode inputs visible in the drawer
  const draft = {};
  rulesDrawerBody.querySelectorAll('[data-rule-key]').forEach(inp => {
    const val = inp.value.trim();
    if (val) draft[inp.dataset.ruleKey] = val;
  });
  return draft;
}

async function saveRules(btn, draftRules) {
  if (!currentTmpl) return;
  const status = document.getElementById('rules-save-status');

  // Use the passed draftRules if available; fall back to reading raw inputs
  const rules = draftRules ?? getDraftRules();

  await withFeedback(btn, status, async () => {
    const { error } = await supabase
      .from('templates')
      .update({ rules_json: Object.keys(rules).length ? rules : null })
      .eq('id', currentTmpl.id);
    if (error) throw error;

    // Update in-memory template so future updateOutput calls use the saved rules
    currentTmpl = { ...currentTmpl, rules_json: Object.keys(rules).length ? rules : null };
    _templates[currentTmpl.id] = currentTmpl;
  }, {
    loading:    'Saving…',
    success:    '✓ Saved',
    clearDelay: 2500,
  });
}

rulesDrawerToggle.addEventListener('click', () => {
  const isOpen = !rulesDrawerBody.hidden;
  rulesDrawerBody.hidden = isOpen;
  rulesDrawerToggle.querySelector('.rules-drawer-arrow').textContent = isOpen ? '▾' : '▴';
  if (!isOpen) renderRulesDrawer();
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  localStorage.removeItem('inkform_role');
  sessionStorage.removeItem('userRole');
  window.location.href = 'index.html';
});

// ── Insert Block panel ────────────────────────────────────────────────────────

const insertBlockChips = document.getElementById('insert-block-chips');

function insertBlock(trigger) {
  const token = `::${trigger}::`;
  const start  = rawInput.selectionStart ?? rawInput.value.length;
  const end    = rawInput.selectionEnd   ?? start;
  const before = rawInput.value.substring(0, start);
  const after  = rawInput.value.substring(end);
  rawInput.value = before + token + after;
  const cursor = start + token.length;
  rawInput.selectionStart = cursor;
  rawInput.selectionEnd   = cursor;
  rawInput.focus();
  updateOutput();
}

async function loadInsertPanel() {
  if (!insertBlockChips) return;

  const { data } = await supabase
    .from('user_library')
    .select('id, trigger, display_name')
    .eq('user_id', userId)
    .order('trigger');

  const blocks = data ?? [];
  insertBlockChips.innerHTML = '';

  if (!blocks.length) {
    const empty = document.createElement('span');
    empty.className = 'insert-block-empty';
    empty.innerHTML = 'No blocks yet — add some in <a href="library.html">My Library</a>';
    insertBlockChips.appendChild(empty);
    return;
  }

  for (const b of blocks) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'insert-block-chip';
    chip.textContent = b.display_name || b.trigger;
    chip.title = `Insert ::${b.trigger}::`;
    chip.addEventListener('click', () => insertBlock(b.trigger));
    insertBlockChips.appendChild(chip);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.body.style.visibility = '';
_isOnline = await checkOnline();
if (!_isOnline) {
  showOfflineBanner();
  watchOnlineRecovery(async () => {
    hideOfflineBanner();
    _isOnline = true;
    const synced = await replayQueue(supabase);
    await loadCharacters();
    if (synced > 0) console.info(`[offline] replayed ${synced} queued writes`);
  });
}
await loadCharacters();
await loadInsertPanel();
updateOutput();
