/**
 * editor.js — Tabbed character editor
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { withFeedback, makeWysiwygGroup, WYSIWYG_RULE_GROUPS } from './utils.js';
import { formatPost, convertBBCodeToHTML } from './parser.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

document.body.style.visibility = 'hidden';

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;
document.body.style.visibility = '';

// ── Admin nav + username ──────────────────────────────────────────────────────
const _adminLink = document.getElementById('admin-link');
if (_adminLink && (sessionStorage.getItem('userRole') ?? localStorage.getItem('inkform_role')) === 'admin') {
  _adminLink.hidden = false;
}
const _navUsername = document.getElementById('nav-username');
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// ── Edit-mode detection ───────────────────────────────────────────────────────
const _params    = new URLSearchParams(window.location.search);
const _editCharId = _params.get('character_id');   // null = create mode

// ── DOM refs ──────────────────────────────────────────────────────────────────
const charNameIn    = document.getElementById('char-name-input');
const tmplChipsEl   = document.getElementById('ce-tmpl-chips');
const addTmplBtn    = document.getElementById('add-tmpl-btn');
const saveBtn       = document.getElementById('save-btn');
const saveStatus    = document.getElementById('save-status');
const themeToggle   = document.getElementById('theme-toggle');
const logoutBtn     = document.getElementById('logout-btn');

// Tabs
const tabBtns       = document.querySelectorAll('.ce-tab');
const panelRules    = document.getElementById('tab-rules');
const panelShell    = document.getElementById('tab-shell');
const panelBlocks   = document.getElementById('tab-blocks');

// Rules tab
const rulesContent  = document.getElementById('rules-content');
const addRuleBtn    = document.getElementById('add-rule-btn');
const reextractDet  = document.getElementById('reextract-details');
const templateIn    = document.getElementById('template-input');
const extractBtn    = document.getElementById('extract-btn');
const extractHint   = document.getElementById('extract-hint');
const extractSpinner= document.getElementById('extract-spinner');
const extractError  = document.getElementById('extract-error');
const resultCards   = document.getElementById('result-cards');
const unknownSection= document.getElementById('unknown-section');
const unknownList   = document.getElementById('unknown-list');

// Shell + Blocks + Preview
const shellContent  = document.getElementById('shell-content');
const blocksContent = document.getElementById('blocks-content');
const livePreview   = document.getElementById('live-preview');

// Context menu
const ctxMenu       = document.getElementById('tmpl-context-menu');
const ctxRename     = document.getElementById('ctx-rename');
const ctxDuplicate  = document.getElementById('ctx-duplicate');
const ctxDelete     = document.getElementById('ctx-delete');

// Rename dialog
const renameDialog  = document.getElementById('rename-dialog');
const renameInput   = document.getElementById('rename-input');
const renameConfirm = document.getElementById('rename-confirm-btn');
const renameStatus  = document.getElementById('rename-status');

// Duplicate dialog
const dupDialog     = document.getElementById('duplicate-dialog');
const dupCharLabel  = document.getElementById('dup-char-label');
const dupNamePrev   = document.getElementById('dup-name-preview');
const dupDestSame   = document.getElementById('dup-dest-same');
const dupDestOther  = document.getElementById('dup-dest-other');
const dupCharGrid   = document.getElementById('dup-char-grid');
const dupConfirm    = document.getElementById('dup-confirm-btn');
const dupStatus     = document.getElementById('dup-status');

// New template dialog
const newTmplDialog = document.getElementById('new-tmpl-dialog');
const newTmplName   = document.getElementById('new-tmpl-name');
const newTmplConfirm= document.getElementById('new-tmpl-confirm');
const newTmplStatus = document.getElementById('new-tmpl-status');

// Add rule dialog
const addRuleDialog = document.getElementById('add-rule-dialog');
const ruleTypeOpts  = document.getElementById('rule-type-options');

// ── State ─────────────────────────────────────────────────────────────────────
let _templates      = [];     // all templates for this character
let _currentTmpl    = null;   // selected template object
let _userLibrary    = [];     // user's library blocks
let _ctxTmpl        = null;   // template targeted by context menu
let _renamingTmpl   = null;   // template being renamed
let _dupTmpl        = null;   // template being duplicated
let _shownRuleKeys  = new Set();
let _cardStates     = [];

// Live drafts — each tab writes here; Save reads from here
let _draftRules     = null;   // rules_json object or null
let _draftShell     = null;   // shell HTML string or null
let _draftBlocks    = [];     // active_block_ids array

// ── Full rule group definitions ───────────────────────────────────────────────
const ALL_RULE_GROUPS = [
  ...WYSIWYG_RULE_GROUPS,
  { label: 'Action',    openKey: 'actionOpen',    closeKey: 'actionClose',    sample: 'She reached for the door.' },
  { label: 'Narration', openKey: 'narrationOpen', closeKey: 'narrationClose', sample: 'The room fell silent.' },
];

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
  sessionStorage.removeItem('userRole');
  window.location.href = 'index.html';
});

// ── Init ──────────────────────────────────────────────────────────────────────
await init();

async function init() {
  charNameIn.addEventListener('input', updateSaveBtn);

  if (!_editCharId) {
    document.title = 'New Character — inkform';
    rulesContent.innerHTML = '<p class="section-hint" style="padding:12px 0">Enter a character name above and click Save to get started. You can add templates and rules afterwards.</p>';
    updateSaveBtn();
    return;
  }

  document.title = 'Edit Character — inkform';

  // Load character
  const { data: charRow } = await supabase
    .from('characters').select('name').eq('id', _editCharId).single();
  if (charRow) charNameIn.value = charRow.name;

  // Load templates
  const { data: tmplRows, error: tmplErr } = await supabase
    .from('templates')
    .select('id, name, shell_html, rules_json, active_block_ids')
    .eq('character_id', _editCharId)
    .order('name');
  if (tmplErr) console.warn('[editor] template load error:', tmplErr.message);
  _templates = tmplRows ?? [];

  // Load user library for Blocks tab
  const { data: libRows } = await supabase
    .from('user_library')
    .select('id, trigger, display_name, replacement_html')
    .eq('user_id', userId)
    .order('trigger');
  _userLibrary = libRows ?? [];

  buildTemplateChips();
  if (_templates.length > 0) selectTemplate(_templates[0].id);
  updateSaveBtn();
}

// ── Template chips ────────────────────────────────────────────────────────────
function buildTemplateChips() {
  tmplChipsEl.querySelectorAll('.ce-tmpl-chip-wrap').forEach(el => el.remove());

  for (const tmpl of _templates) {
    const wrap = document.createElement('div');
    wrap.className = 'ce-tmpl-chip-wrap';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `ce-tmpl-chip${_currentTmpl?.id === tmpl.id ? ' active' : ''}`;
    chip.textContent = tmpl.name;
    chip.dataset.tmplId = tmpl.id;

    chip.addEventListener('click', () => selectTemplate(tmpl.id));

    // Right-click context menu
    chip.addEventListener('contextmenu', e => {
      e.preventDefault();
      openCtxMenu(tmpl, e.clientX, e.clientY);
    });

    // Long-press (mobile)
    let pressTimer;
    chip.addEventListener('touchstart', e => {
      pressTimer = setTimeout(() => {
        const t = e.touches[0];
        openCtxMenu(tmpl, t.clientX, t.clientY);
      }, 600);
    }, { passive: true });
    chip.addEventListener('touchend',  () => clearTimeout(pressTimer));
    chip.addEventListener('touchmove', () => clearTimeout(pressTimer));

    wrap.appendChild(chip);
    tmplChipsEl.insertBefore(wrap, addTmplBtn);
  }
}

function selectTemplate(tmplId) {
  _currentTmpl = _templates.find(t => t.id === tmplId) ?? null;

  // Update chip active states
  tmplChipsEl.querySelectorAll('.ce-tmpl-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.tmplId === tmplId);
  });

  // Reset drafts from template data
  _draftRules  = _currentTmpl?.rules_json  ? { ..._currentTmpl.rules_json }         : null;
  _draftShell  = _currentTmpl?.shell_html  ?? null;
  _draftBlocks = [...(_currentTmpl?.active_block_ids ?? [])];

  renderRulesTab();
  renderShellTab();
  renderBlocksTab();
  updatePreview();
  updateSaveBtn();
}

// ── + New template ────────────────────────────────────────────────────────────
addTmplBtn.addEventListener('click', () => {
  if (!_editCharId) {
    saveStatus.textContent = 'Save the character first, then add templates.';
    return;
  }
  newTmplName.value = '';
  newTmplStatus.textContent = '';
  newTmplDialog.showModal();
});

newTmplConfirm.addEventListener('click', async () => {
  const name = newTmplName.value.trim();
  if (!name) { newTmplStatus.textContent = 'Enter a name.'; return; }
  newTmplConfirm.disabled = true;
  newTmplStatus.textContent = 'Creating…';
  const { data, error } = await supabase
    .from('templates')
    .insert({ character_id: _editCharId, name, shell_html: null, rules_json: null })
    .select('id, name, shell_html, rules_json, active_block_ids')
    .single();
  newTmplConfirm.disabled = false;
  if (error) { newTmplStatus.textContent = `Error: ${error.message}`; return; }
  _templates.push(data);
  buildTemplateChips();
  selectTemplate(data.id);
  newTmplDialog.close();
});

// ── Context menu ──────────────────────────────────────────────────────────────
function openCtxMenu(tmpl, x, y) {
  _ctxTmpl = tmpl;
  ctxMenu.hidden = false;
  const mw = 160, mh = 116;
  ctxMenu.style.left = `${Math.min(x, window.innerWidth  - mw - 8)}px`;
  ctxMenu.style.top  = `${Math.min(y, window.innerHeight - mh - 8)}px`;
}
function closeCtxMenu() {
  ctxMenu.hidden = true;
  _ctxTmpl = null;
}
document.addEventListener('click', e => {
  if (!ctxMenu.hidden && !ctxMenu.contains(e.target)) closeCtxMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

ctxRename.addEventListener('click', () => {
  if (!_ctxTmpl) return;
  _renamingTmpl = _ctxTmpl;
  renameInput.value = _renamingTmpl.name;
  renameStatus.textContent = '';
  closeCtxMenu();
  renameDialog.showModal();
  setTimeout(() => { renameInput.select(); }, 50);
});

ctxDuplicate.addEventListener('click', () => {
  if (!_ctxTmpl) return;
  _dupTmpl = _ctxTmpl;
  closeCtxMenu();
  openDupDialog();
});

ctxDelete.addEventListener('click', async () => {
  if (!_ctxTmpl) return;
  const tmpl = _ctxTmpl;
  closeCtxMenu();
  if (!confirm(`Delete template "${tmpl.name}"? This cannot be undone.`)) return;
  const { error } = await supabase.from('templates').delete().eq('id', tmpl.id);
  if (error) { alert(`Delete failed: ${error.message}`); return; }
  _templates = _templates.filter(t => t.id !== tmpl.id);
  if (_currentTmpl?.id === tmpl.id) {
    _currentTmpl = null;
    _draftRules = null; _draftShell = null; _draftBlocks = [];
  }
  buildTemplateChips();
  if (_templates.length > 0 && !_currentTmpl) {
    selectTemplate(_templates[0].id);
  } else {
    renderRulesTab(); renderShellTab(); renderBlocksTab(); updatePreview();
  }
});

// ── Rename dialog ─────────────────────────────────────────────────────────────
renameConfirm.addEventListener('click', async () => {
  const name = renameInput.value.trim();
  if (!name) { renameStatus.textContent = 'Enter a name.'; return; }
  const tmpl = _templates.find(t => t.id === _renamingTmpl?.id);
  if (!tmpl) return;
  renameConfirm.disabled = true;
  renameStatus.textContent = 'Saving…';
  const { error } = await supabase.from('templates').update({ name }).eq('id', tmpl.id);
  renameConfirm.disabled = false;
  if (error) { renameStatus.textContent = `Error: ${error.message}`; return; }
  tmpl.name = name;
  if (_currentTmpl?.id === tmpl.id) _currentTmpl.name = name;
  buildTemplateChips();
  renameDialog.close();
});

// ── Duplicate dialog ──────────────────────────────────────────────────────────
function openDupDialog() {
  if (!_dupTmpl) return;
  dupCharLabel.textContent  = charNameIn.value.trim() || 'this character';
  dupNamePrev.textContent   = `${_dupTmpl.name} (copy)`;
  dupStatus.textContent     = '';
  dupDestSame.checked       = true;
  dupCharGrid.hidden        = true;
  dupDialog.showModal();
}

dupDestOther.addEventListener('change', async () => {
  if (!dupDestOther.checked) return;
  dupCharGrid.hidden  = false;
  dupCharGrid.innerHTML = '<p class="section-hint">Loading…</p>';
  const { data } = await supabase
    .from('characters')
    .select('id, name')
    .eq('user_id', userId)
    .neq('id', _editCharId ?? '')
    .order('name');
  dupCharGrid.innerHTML = '';
  if (!data?.length) {
    dupCharGrid.innerHTML = '<p class="section-hint">No other characters.</p>';
    return;
  }
  for (const c of data) {
    const lbl = document.createElement('label');
    lbl.className = 'radio-option';
    const inp = document.createElement('input');
    inp.type = 'radio'; inp.name = 'dup-char'; inp.value = c.id;
    lbl.appendChild(inp);
    lbl.append(' ' + c.name);
    dupCharGrid.appendChild(lbl);
  }
});
dupDestSame.addEventListener('change', () => { dupCharGrid.hidden = true; });

dupConfirm.addEventListener('click', async () => {
  if (!_dupTmpl) return;
  let targetCharId = _editCharId;
  if (dupDestOther.checked) {
    const picked = dupCharGrid.querySelector('input[name=dup-char]:checked');
    if (!picked) { dupStatus.textContent = 'Pick a character.'; return; }
    targetCharId = picked.value;
  }
  dupConfirm.disabled = true;
  dupStatus.textContent = 'Duplicating…';
  const payload = {
    character_id:     targetCharId,
    name:             `${_dupTmpl.name} (copy)`,
    shell_html:       _dupTmpl.shell_html,
    rules_json:       _dupTmpl.rules_json,
    active_block_ids: _dupTmpl.active_block_ids,
  };
  const { data, error } = await supabase
    .from('templates')
    .insert(payload)
    .select('id, name, shell_html, rules_json, active_block_ids')
    .single();
  dupConfirm.disabled = false;
  if (error) { dupStatus.textContent = `Error: ${error.message}`; return; }
  if (targetCharId === _editCharId) {
    _templates.push(data);
    buildTemplateChips();
  }
  dupDialog.close();
});

// ── Dialog helpers ────────────────────────────────────────────────────────────
document.querySelectorAll('.dialog-cancel').forEach(btn =>
  btn.addEventListener('click', () => btn.closest('dialog').close()));
document.querySelectorAll('.manage-dialog').forEach(dlg =>
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }));

// ── Tab switching ─────────────────────────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    tabBtns.forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    panelRules.hidden  = tab !== 'rules';
    panelShell.hidden  = tab !== 'shell';
    panelBlocks.hidden = tab !== 'blocks';
  });
});

// ── Rules tab ─────────────────────────────────────────────────────────────────
function renderRulesTab() {
  rulesContent.innerHTML = '';
  _shownRuleKeys = new Set();

  if (!_currentTmpl && _editCharId) {
    rulesContent.innerHTML = '<p class="section-hint" style="padding:12px 0">No template selected.</p>';
    updateAddRuleVisibility();
    return;
  }

  const rules = _draftRules ?? {};

  // Show groups that have saved data
  let hasAny = false;
  for (const group of ALL_RULE_GROUPS) {
    if (rules[group.openKey] || rules[group.closeKey]) {
      mountRuleGroup(group, rules);
      hasAny = true;
    }
  }

  if (!hasAny) {
    const msg = document.createElement('p');
    msg.className = 'section-hint';
    msg.style.padding = '12px 0';
    msg.textContent = 'No formatting rules yet. Click "+ Add rule" or use re-extract below.';
    rulesContent.appendChild(msg);
  }

  updateAddRuleVisibility();
}

function mountRuleGroup(group, rules) {
  if (!_draftRules) _draftRules = {};
  _shownRuleKeys.add(group.openKey);

  const el = makeWysiwygGroup(group, rules, (openKey, openVal, closeKey, closeVal) => {
    if (!_draftRules) _draftRules = {};
    _draftRules[openKey]  = openVal;
    _draftRules[closeKey] = closeVal;
    updatePreview();
    updateSaveBtn();
  });
  rulesContent.appendChild(el);
}

function updateAddRuleVisibility() {
  const available = ALL_RULE_GROUPS.filter(g => !_shownRuleKeys.has(g.openKey));
  if (addRuleBtn) addRuleBtn.style.display = (available.length && _currentTmpl) ? '' : 'none';
}

addRuleBtn.addEventListener('click', () => {
  const available = ALL_RULE_GROUPS.filter(g => !_shownRuleKeys.has(g.openKey));
  if (!available.length) return;
  ruleTypeOpts.innerHTML = '';
  for (const group of available) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rule-type-pick-btn btn-ghost';
    btn.textContent = group.label;
    btn.addEventListener('click', () => {
      if (!_draftRules) _draftRules = {};
      mountRuleGroup(group, _draftRules);
      updateAddRuleVisibility();
      updateSaveBtn();
      addRuleDialog.close();
    });
    ruleTypeOpts.appendChild(btn);
  }
  addRuleDialog.showModal();
});

// ── Re-extract flow ───────────────────────────────────────────────────────────
templateIn.addEventListener('input', () => {
  const has = templateIn.value.trim().length > 0;
  extractBtn.disabled = !has;
  extractHint.textContent = has ? 'Ready to extract.' : 'Enter a template to extract rules.';
});

extractBtn.addEventListener('click', async () => {
  const template = templateIn.value.trim();
  if (!template) return;

  extractSpinner.hidden = false;
  extractError.hidden   = true;
  resultCards.innerHTML = '';
  unknownSection.hidden = true;
  _cardStates.length    = 0;
  extractBtn.disabled   = true;
  extractBtn.textContent = 'Extracting…';

  try {
    const { data: { session: live } } = await supabase.auth.getSession();
    if (!live) { window.location.replace('index.html'); return; }

    const resp = await supabase.functions.invoke('extract-template', {
      body:    { template },
      headers: { Authorization: `Bearer ${live.access_token}` },
    });
    if (resp.error) throw new Error(resp.error.message);

    renderExtractedCards(resp.data);
  } catch (err) {
    extractError.textContent = `Extraction failed: ${err.message}`;
    extractError.hidden = false;
  } finally {
    extractSpinner.hidden  = true;
    extractBtn.disabled    = false;
    extractBtn.textContent = 'Extract Rules';
  }
});

function renderExtractedCards(extracted) {
  const items = extracted?.items ?? [];
  if (!items.length) {
    resultCards.innerHTML = '<p class="section-hint">Nothing found to extract.</p>';
    return;
  }
  for (const item of items) {
    const id    = `card-${Math.random().toString(36).slice(2)}`;
    const state = { id, kind: item.type === 'shell' ? 'shell' : 'rule', data: item.type === 'shell' ? (item.html ?? item) : item, status: 'pending', resolvedType: item.type };
    _cardStates.push(state);
    resultCards.appendChild(
      state.kind === 'shell'
        ? makeExtractionShellCard(id, state.data, state)
        : makeExtractionRuleCard(id, item, state),
    );
  }
  const unknowns = extracted?.unknown ?? [];
  if (unknowns.length) {
    unknownSection.hidden = false;
    unknownList.innerHTML = '';
    for (const u of unknowns) {
      const li = document.createElement('li');
      li.textContent = u;
      unknownList.appendChild(li);
    }
  }
}

function makeExtractionShellCard(id, html, state) {
  const card = document.createElement('div');
  card.className = 'result-card'; card.id = id;
  const hdr = document.createElement('div');
  hdr.className = 'result-card-header';
  const tag = document.createElement('span');
  tag.className = 'type-tag type-tag--shell'; tag.textContent = 'Shell HTML';
  hdr.appendChild(tag); card.appendChild(hdr);
  const pre = document.createElement('pre');
  pre.className = 'raw-code';
  pre.style.cssText = 'max-height:100px;overflow:auto;margin:8px 0;font-size:11px';
  pre.textContent = (typeof html === 'string' ? html : '').slice(0, 500);
  card.appendChild(pre);
  card.appendChild(makeExtractionActions(id, state));
  return card;
}

function makeExtractionRuleCard(id, rule, state) {
  const card = document.createElement('div');
  card.className = 'result-card'; card.id = id;
  const hdr = document.createElement('div');
  hdr.className = 'result-card-header';
  const tag = document.createElement('span');
  tag.className = `type-tag type-tag--${rule.type}`; tag.textContent = capitalise(rule.type);
  hdr.appendChild(tag); card.appendChild(hdr);
  const mkRow = (lbl, val) => {
    const row = document.createElement('div'); row.className = 'marker-row';
    const l = document.createElement('span'); l.className = 'field-label'; l.textContent = lbl;
    const c = document.createElement('code'); c.className = 'marker-code'; c.textContent = val || '(none)';
    row.appendChild(l); row.appendChild(c); return row;
  };
  const markers = document.createElement('div'); markers.className = 'result-card-markers';
  markers.appendChild(mkRow('Opening:', rule.opening_marker));
  markers.appendChild(mkRow('Closing:', rule.closing_marker));
  card.appendChild(markers);
  card.appendChild(makeExtractionActions(id, state));
  return card;
}

function makeExtractionActions(id, state) {
  const footer = document.createElement('div');
  footer.className = 'result-card-footer';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn-sm btn-primary result-confirm-btn';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.addEventListener('click', () => {
    state.status = 'confirmed';
    const card = document.getElementById(id);
    if (card) { card.classList.add('card--confirmed'); confirmBtn.textContent = '✓ Confirmed'; confirmBtn.disabled = true; }
    applyConfirmedCard(state);
    updatePreview();
    updateSaveBtn();
  });

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'btn-sm btn-ghost';
  skipBtn.textContent = 'Skip';
  skipBtn.addEventListener('click', () => {
    state.status = 'skipped';
    const card = document.getElementById(id);
    if (card) { card.classList.add('card--skipped'); skipBtn.textContent = 'Skipped'; skipBtn.disabled = true; }
    updateSaveBtn();
  });

  footer.appendChild(confirmBtn);
  footer.appendChild(skipBtn);
  return footer;
}

function applyConfirmedCard(state) {
  if (!_draftRules) _draftRules = {};
  if (state.kind === 'shell') {
    _draftShell = typeof state.data === 'string' ? state.data : (state.data?.html ?? null);
    renderShellTab();
  } else {
    const rule = state.data, type = state.resolvedType ?? rule.type;
    if (type === 'dialogue')  { _draftRules.dialogueOpen  = rule.opening_marker; _draftRules.dialogueClose  = rule.closing_marker; }
    if (type === 'thought')   { _draftRules.thoughtOpen   = rule.opening_marker; _draftRules.thoughtClose   = rule.closing_marker; }
    if (type === 'action')    { _draftRules.actionOpen    = rule.opening_marker; _draftRules.actionClose    = rule.closing_marker; }
    if (type === 'narration') { _draftRules.narrationOpen = rule.opening_marker; _draftRules.narrationClose = rule.closing_marker; }
    renderRulesTab();
  }
}

// ── Shell tab ─────────────────────────────────────────────────────────────────
function renderShellTab() {
  shellContent.innerHTML = '';

  if (!_currentTmpl) {
    shellContent.innerHTML = '<p class="section-hint" style="padding:12px 0">Select a template to edit its shell.</p>';
    return;
  }

  const shell = _draftShell;

  if (!shell) {
    shellContent.innerHTML = '<p class="section-hint">No shell template yet.</p>';
    const pasteBtn = document.createElement('button');
    pasteBtn.type = 'button';
    pasteBtn.className = 'btn-ghost btn-sm';
    pasteBtn.style.marginTop = '12px';
    pasteBtn.textContent = '↓ Paste existing Jcink template';
    pasteBtn.addEventListener('click', () => {
      // Switch to Rules tab, open re-extract
      tabBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.tab === 'rules');
        b.setAttribute('aria-selected', String(b.dataset.tab === 'rules'));
      });
      panelRules.hidden = false; panelShell.hidden = true; panelBlocks.hidden = true;
      reextractDet.open = true;
      templateIn.focus();
    });
    shellContent.appendChild(pasteBtn);
    return;
  }

  const sections = parseShellSections(shell);
  const grid = document.createElement('div');
  grid.className = 'shell-fields-grid';

  const addTextField = (label, val, patchKey) => {
    if (!val && patchKey !== 'imageUrl') return;
    const row = document.createElement('div'); row.className = 'shell-field-row';
    const lbl = document.createElement('label'); lbl.className = 'field-label'; lbl.textContent = label;
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input'; inp.value = val;
    inp.placeholder = patchKey === 'imageUrl' ? 'https://…' : '';
    inp.addEventListener('input', () => {
      _draftShell = applyShellPatch(_draftShell ?? shell, { [patchKey]: inp.value });
      updatePreview();
    });
    row.appendChild(lbl); row.appendChild(inp); grid.appendChild(row);
  };

  const addColorField = (label, val, patchKey) => {
    if (!val) return;
    const row = document.createElement('div'); row.className = 'shell-field-row';
    const lbl = document.createElement('label'); lbl.className = 'field-label'; lbl.textContent = label;
    const wrap = document.createElement('div'); wrap.className = 'shell-color-wrap';
    const native = document.createElement('input'); native.type = 'color'; native.className = 'shell-color-input';
    native.value = /^#[0-9a-fA-F]{6}$/i.test(val) ? val : '#000000';
    const hexIn = document.createElement('input'); hexIn.type = 'text';
    hexIn.className = 'input input--mono shell-hex-input'; hexIn.value = val; hexIn.maxLength = 7;
    native.addEventListener('input', () => {
      hexIn.value = native.value;
      _draftShell = applyShellPatch(_draftShell ?? shell, { [patchKey]: native.value });
      updatePreview();
    });
    hexIn.addEventListener('input', () => {
      const v = hexIn.value.trim();
      if (/^#[0-9a-fA-F]{6}$/i.test(v)) {
        native.value = v;
        _draftShell = applyShellPatch(_draftShell ?? shell, { [patchKey]: v });
        updatePreview();
      }
    });
    wrap.appendChild(native); wrap.appendChild(hexIn);
    row.appendChild(lbl); row.appendChild(wrap); grid.appendChild(row);
  };

  addTextField('Header Image URL', sections.imageUrl, 'imageUrl');
  addColorField('Background Color', sections.bgColor,    'bgColor');
  addColorField('Border Color',     sections.borderColor,'borderColor');
  addTextField('Header Line 1',     sections.lyr1,       'lyr1');
  addTextField('Header Line 2',     sections.lyr2,       'lyr2');
  addTextField('Header Line 3',     sections.lyr3,       'lyr3');
  addColorField('Content Text Color', sections.textColor,'textColor');
  shellContent.appendChild(grid);

  // Raw HTML (collapsed)
  const det = document.createElement('details'); det.className = 'shell-raw-details';
  const sum = document.createElement('summary'); sum.className = 'shell-raw-summary field-label'; sum.textContent = '▶ Edit raw HTML (advanced)';
  det.appendChild(sum);
  const rawTa = document.createElement('textarea');
  rawTa.className = 'textarea-input textarea--mono'; rawTa.rows = 10; rawTa.value = shell; rawTa.spellcheck = false;
  rawTa.addEventListener('input', () => { _draftShell = rawTa.value; updatePreview(); });
  det.appendChild(rawTa);
  shellContent.appendChild(det);
}

// ── Blocks tab ────────────────────────────────────────────────────────────────
function renderBlocksTab() {
  blocksContent.innerHTML = '';

  if (!_currentTmpl) {
    blocksContent.innerHTML = '<p class="section-hint" style="padding:12px 0">Select a template to manage blocks.</p>';
    return;
  }
  if (!_userLibrary.length) {
    blocksContent.innerHTML = '<p class="section-hint" style="padding:12px 0">No blocks in your library yet. <a href="library.html">Add some in My Library →</a></p>';
    return;
  }

  const grid = document.createElement('div'); grid.className = 'block-toggle-grid';

  for (const block of _userLibrary) {
    const isActive = _draftBlocks.includes(block.id);

    const wrap = document.createElement('div');
    wrap.className = `block-toggle-wrap${isActive ? ' active' : ''}`;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `block-toggle-chip${isActive ? ' active' : ''}`;
    chip.textContent = block.display_name || block.trigger;
    chip.title = `::${block.trigger}::`;

    const sub = document.createElement('span');
    sub.className = 'block-toggle-sub';
    sub.textContent = `::${block.trigger}::`;
    sub.hidden = !isActive;

    chip.addEventListener('click', () => {
      const idx = _draftBlocks.indexOf(block.id);
      if (idx === -1) {
        _draftBlocks.push(block.id);
        chip.classList.add('active'); wrap.classList.add('active'); sub.hidden = false;
      } else {
        _draftBlocks.splice(idx, 1);
        chip.classList.remove('active'); wrap.classList.remove('active'); sub.hidden = true;
      }
      updateSaveBtn();
    });

    wrap.appendChild(chip); wrap.appendChild(sub);
    grid.appendChild(wrap);
  }

  blocksContent.appendChild(grid);

  const libLink = document.createElement('p');
  libLink.className = 'blocks-lib-link';
  libLink.innerHTML = '<a href="library.html">+ Browse My Library</a>';
  blocksContent.appendChild(libLink);
}

// ── Live preview ──────────────────────────────────────────────────────────────
const SAMPLE_POST = `"She said hello."\n'I wonder if they know.'\nThe room fell silent.`;

function updatePreview() {
  const rules = _draftRules ?? _currentTmpl?.rules_json ?? {};
  const shell = _draftShell ?? _currentTmpl?.shell_html ?? null;

  try {
    const bbContent   = formatPost(SAMPLE_POST, { rules, replacements: [] });
    const htmlContent = convertBBCodeToHTML(bbContent);
    const display     = (shell
      ? shell.replace('{{content}}', htmlContent)
      : htmlContent)
      .replace(/\[dohtml\]/gi, '')
      .replace(/\[\/dohtml\]/gi, '');
    livePreview.innerHTML = display || '<span class="output-placeholder">Preview appears here…</span>';
  } catch {
    livePreview.innerHTML = '<span class="output-placeholder">Preview unavailable.</span>';
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
function updateSaveBtn() {
  const hasName = charNameIn.value.trim().length > 0;
  saveBtn.disabled = !hasName;
  if (!hasName) { saveStatus.textContent = 'Enter a character name.'; return; }
  if (!_editCharId) { saveStatus.textContent = ''; return; }
  saveStatus.textContent = '';
}

saveBtn.addEventListener('click', async () => {
  const characterName = charNameIn.value.trim();
  if (!characterName) return;

  await withFeedback(saveBtn, saveStatus, async () => {
    if (!_editCharId) {
      // Create mode — insert character, redirect to edit mode
      const { data: rows, error } = await supabase
        .from('characters')
        .insert({ user_id: userId, name: characterName })
        .select('id');
      if (error) throw new Error('Could not create character.');
      setTimeout(() => { window.location.href = `editor.html?character_id=${rows[0].id}`; }, 800);
      return;
    }

    // Update character name
    const { error: charErr } = await supabase
      .from('characters').update({ name: characterName }).eq('id', _editCharId);
    if (charErr) throw new Error('Could not update character name.');

    if (!_currentTmpl) return;

    // Build payload from drafts
    const rules  = (_draftRules  && Object.keys(_draftRules).length)  ? _draftRules  : null;
    const shell  = _draftShell  || null;
    const blocks = _draftBlocks.length ? _draftBlocks : null;

    const { error: tmplErr } = await supabase
      .from('templates')
      .update({ rules_json: rules, shell_html: shell, active_block_ids: blocks })
      .eq('id', _currentTmpl.id);
    if (tmplErr) throw new Error('Could not save template.');

    // Sync local state
    Object.assign(_currentTmpl, { rules_json: rules, shell_html: shell, active_block_ids: blocks });
    const local = _templates.find(t => t.id === _currentTmpl.id);
    if (local) Object.assign(local, _currentTmpl);
  }, {
    loading:    'Saving…',
    btnSuccess: '✓ Saved',
    success:    '✓ Saved.',
    clearDelay: 2500,
  });
});

// ── Shell section parser / patcher ────────────────────────────────────────────
function parseShellSections(html) {
  const raw = html.replace(/\[dohtml\]/gi, '').replace(/\[\/dohtml\]/gi, '').trim();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const body = doc.body;
  const rootEl = body.firstElementChild;
  let bgColor = '', borderColor = '';
  if (rootEl) {
    const style = rootEl.getAttribute('style') ?? '';
    const bg = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/i);
    if (bg) bgColor = bg[1];
    const bd = style.match(/border[^:]*:\s*[^;]*?(#[0-9a-fA-F]{3,8})/i);
    if (bd) borderColor = bd[1];
  }
  const tcM = raw.match(/color\s*:\s*(#[0-9a-fA-F]{3,8})[^>]*>\s*\{\{content\}\}/i);
  return {
    imageUrl:    body.querySelector('img')?.getAttribute('src') ?? '',
    bgColor, borderColor,
    lyr1: body.querySelector('.lyr1, [class*=" lyr1"], [class^="lyr1"]')?.textContent.trim() ?? '',
    lyr2: body.querySelector('.lyr2, [class*=" lyr2"], [class^="lyr2"]')?.textContent.trim() ?? '',
    lyr3: body.querySelector('.lyr3, [class*=" lyr3"], [class^="lyr3"]')?.textContent.trim() ?? '',
    textColor: tcM ? tcM[1] : '',
  };
}

function applyShellPatch(html, patches) {
  let out = html;
  if (patches.imageUrl !== undefined)
    out = out.replace(/(src=["'])[^"']*(["'])/i, `$1${patches.imageUrl}$2`);
  if (patches.bgColor)
    out = out.replace(/(background(?:-color)?\s*:\s*)(#[0-9a-fA-F]{3,8})/i, `$1${patches.bgColor}`);
  if (patches.borderColor)
    out = out.replace(/(border[^:]*:\s*[^;]*?)(#[0-9a-fA-F]{3,8})/i, `$1${patches.borderColor}`);
  if (patches.textColor)
    out = out.replace(/(color\s*:\s*)(#[0-9a-fA-F]{3,8})([^>]*>\s*\{\{content\}\})/i, `$1${patches.textColor}$3`);
  for (const key of ['lyr1', 'lyr2', 'lyr3']) {
    if (patches[key] !== undefined) {
      out = out.replace(new RegExp(`(class="[^"]*${key}[^"]*"[^>]*>)[^<]*`, 'i'), `$1${patches[key]}`);
      out = out.replace(new RegExp(`(class='[^']*${key}[^']*'[^>]*>)[^<]*`, 'i'), `$1${patches[key]}`);
    }
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function capitalise(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}
