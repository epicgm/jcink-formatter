/**
 * home.js — Formatter page
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient }     from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { formatPost }       from './parser.js';
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
if (_adminLink && localStorage.getItem('inkform_role') === 'admin') {
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
const rulesDrawerToggle = document.getElementById('rules-drawer-toggle');
const rulesDrawerBody   = document.getElementById('rules-drawer-body');

// ── State ─────────────────────────────────────────────────────────────────────

let _templates     = {};   // id → full template object
let currentTmpl    = null;
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
  await loadTemplates(characterId);
  updateOutput();
}

async function onTemplateSelect(tmplId) {
  currentTmpl  = _templates[tmplId] ?? null;
  currentRepls = await loadReplacements(currentTmpl);
  updateOutput();
  // Refresh drawer if it's open
  if (!rulesDrawerBody.hidden) renderRulesDrawer();
}

// ── Formatter ─────────────────────────────────────────────────────────────────

function updateOutput() {
  const raw       = rawInput.value;
  const formatted = formatPost(raw, {
    replacements: currentRepls,
    shellHtml:    currentTmpl?.shell_html ?? null,
    rules:        currentTmpl?.rules_json ?? {},
  });

  // Store the full output (including [dohtml] tags) for the copy button.
  // Strip [dohtml]/[/dohtml] only for the visual preview — they are Jcink
  // rendering directives that don't belong in an HTML preview pane.
  _copyContent = formatted;
  const display = formatted
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

// ── Rules drawer ─────────────────────────────────────────────────────────────

const RULE_FIELDS = [
  { key: 'dialogueOpen',  label: 'Dialogue Open',  placeholder: '<span class="dialogue">' },
  { key: 'dialogueClose', label: 'Dialogue Close', placeholder: '</span>' },
  { key: 'thoughtOpen',   label: 'Thought Open',   placeholder: '<span class="thought">' },
  { key: 'thoughtClose',  label: 'Thought Close',  placeholder: '</span>' },
];

function renderRulesDrawer() {
  rulesDrawerBody.innerHTML = '';

  if (!currentTmpl) {
    rulesDrawerBody.innerHTML = '<p class="rules-drawer-hint">Select a template to edit its rules.</p>';
    return;
  }

  const rules = { ...(currentTmpl.rules_json ?? {}) };

  // Rule fields
  const fieldsWrap = document.createElement('div');
  fieldsWrap.className = 'rules-drawer-fields';

  for (const { key, label, placeholder } of RULE_FIELDS) {
    const row = document.createElement('div');
    row.className = 'field rules-drawer-field';

    const lbl = document.createElement('label');
    lbl.className = 'field-label';
    lbl.textContent = label;
    lbl.htmlFor = `rule-${key}`;

    const inp = document.createElement('input');
    inp.type        = 'text';
    inp.id          = `rule-${key}`;
    inp.className   = 'input input--mono';
    inp.placeholder = placeholder;
    inp.value       = rules[key] ?? '';
    inp.dataset.ruleKey = key;

    // Live preview: update output as user edits rules
    inp.addEventListener('input', () => {
      const draft = getDraftRules();
      const preview = formatPost(rawInput.value, {
        replacements: currentRepls,
        shellHtml: currentTmpl?.shell_html ?? null,
        rules: draft,
      });
      _copyContent = preview;
      const display = preview
        .replace(/\[dohtml\]/gi, '')
        .replace(/\[\/dohtml\]/gi, '');
      outputEl.innerHTML = display || '<span class="output-placeholder">Formatted output appears here…</span>';
    });

    row.appendChild(lbl);
    row.appendChild(inp);
    fieldsWrap.appendChild(row);
  }

  rulesDrawerBody.appendChild(fieldsWrap);

  // Footer: save + link
  const footer = document.createElement('div');
  footer.className = 'rules-drawer-footer';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-primary btn-sm';
  saveBtn.textContent = 'Save Rules';
  saveBtn.addEventListener('click', () => saveRules(saveBtn));

  const saveStatus = document.createElement('span');
  saveStatus.className = 'rules-save-status';
  saveStatus.id = 'rules-save-status';

  const link = document.createElement('a');
  link.href = `manage.html`;
  link.className = 'rules-drawer-hint';
  link.textContent = 'Full editor in Characters →';

  footer.appendChild(saveBtn);
  footer.appendChild(saveStatus);
  footer.appendChild(link);
  rulesDrawerBody.appendChild(footer);
}

function getDraftRules() {
  const draft = {};
  rulesDrawerBody.querySelectorAll('[data-rule-key]').forEach(inp => {
    const val = inp.value.trim();
    if (val) draft[inp.dataset.ruleKey] = val;
  });
  return draft;
}

async function saveRules(btn) {
  if (!currentTmpl) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const status = document.getElementById('rules-save-status');

  const rules = getDraftRules();
  const { error } = await supabase
    .from('templates')
    .update({ rules_json: Object.keys(rules).length ? rules : null })
    .eq('id', currentTmpl.id);

  if (error) {
    if (status) { status.textContent = 'Error: ' + error.message; status.style.color = 'var(--color-danger)'; }
  } else {
    // Update in-memory template so future updateOutput calls use the saved rules
    currentTmpl = { ...currentTmpl, rules_json: Object.keys(rules).length ? rules : null };
    _templates[currentTmpl.id] = currentTmpl;
    if (status) { status.textContent = '✓ Saved'; status.style.color = 'var(--color-teal)'; }
    setTimeout(() => { if (status) status.textContent = ''; }, 2500);
  }

  btn.disabled = false;
  btn.textContent = 'Save Rules';
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
  window.location.href = 'index.html';
});

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
updateOutput();
