/**
 * editor.js — New character flow with Claude-powered template extraction
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient }  from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { withFeedback, makeWysiwygGroup, WYSIWYG_RULE_GROUPS } from './utils.js';
import { convertBBCodeToHTML } from './parser.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Hide immediately — revealed only after session confirmed, preventing flash.
document.body.style.visibility = 'hidden';

// ── Auth guard ────────────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;
document.body.style.visibility = '';

// ── Edit-mode detection ───────────────────────────────────────────────────────
// When navigated from manage.html with ?character_id=<uuid>, the editor loads
// the existing character + first template and saves as UPDATE instead of INSERT.

const _editParams  = new URLSearchParams(window.location.search);
const _editCharId  = _editParams.get('character_id');  // null = create mode
let   _editTmplId  = null;                             // set during load if template exists

// ── DOM refs ──────────────────────────────────────────────────────────────────

const charNameIn    = document.getElementById('char-name-input');
const tmplNameIn    = document.getElementById('tmpl-name-input');
const templateIn    = document.getElementById('template-input');
const extractBtn    = document.getElementById('extract-btn');
const extractHint   = document.getElementById('extract-hint');
const resultsSection= document.getElementById('results-section');
const spinner       = document.getElementById('extract-spinner');
const extractError  = document.getElementById('extract-error');
const resultCards   = document.getElementById('result-cards');
const unknownSection= document.getElementById('unknown-section');
const unknownList   = document.getElementById('unknown-list');
const saveBtn       = document.getElementById('save-btn');
const saveStatus    = document.getElementById('save-status');
const themeToggle   = document.getElementById('theme-toggle');
const logoutBtn     = document.getElementById('logout-btn');
const _navUsername  = document.getElementById('nav-username');
const existingRulesSection = document.getElementById('existing-rules-section');
const existingRulesContent = document.getElementById('existing-rules-content');
const reextractBtn  = document.getElementById('reextract-btn');
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// ── State ─────────────────────────────────────────────────────────────────────

// cardStates: array of { id, kind: 'shell'|'rule', data, status: 'pending'|'confirmed'|'skipped', resolvedType }
const cardStates = [];

// In edit mode, holds the live draft from the WYSIWYG rule editor.
// Starts as a copy of the DB value and is written to on every toggle/input.
// The save handler reads this instead of (or in addition to) confirmed cardStates.
let _editedRulesJson = null;

// ── Load existing character in edit mode ──────────────────────────────────────

if (_editCharId) {
  // Update page chrome for edit mode
  document.title = 'Edit Character — inkform';
  const titleEl = document.querySelector('.editor-title');
  if (titleEl) titleEl.textContent = 'Edit Character';
  saveBtn.textContent = 'Save Changes';
  // Renumber template section since rules is now "2"
  const tmplHeading = document.getElementById('template-section-heading');
  if (tmplHeading) tmplHeading.textContent = '3 — Paste existing template';

  // Load character name
  const { data: charRow } = await supabase
    .from('characters').select('name').eq('id', _editCharId).single();
  if (charRow) charNameIn.value = charRow.name;

  // Load first template (shell_html + rules_json + name)
  const { data: tmplRows, error: tmplErr } = await supabase
    .from('templates').select('id, name, shell_html, rules_json')
    .eq('character_id', _editCharId).order('name').limit(1);

  if (tmplErr) console.warn('[editor] template load error:', tmplErr.message);

  const tmpl = tmplRows?.[0] ?? null;
  if (tmpl) {
    _editTmplId       = tmpl.id;
    tmplNameIn.value  = tmpl.name      ?? 'Default';
    templateIn.value  = tmpl.shell_html ?? '';
    if (templateIn.value) {
      extractBtn.disabled = false;
      extractHint.textContent = 'Template loaded — re-extract or save changes.';
    }
  }

  // Always show the rule editor in edit mode.
  showExistingRulesSection(tmpl?.rules_json ?? {});

  updateSaveBtn();
}

// ── New-character mode: also show WYSIWYG rules section (manual entry) ────────

if (!_editCharId) {
  // Update heading + hint for create context
  const h = existingRulesSection?.querySelector('.section-heading');
  if (h) h.textContent = '2 — Formatting rules (optional)';
  const hint = existingRulesSection?.querySelector('.section-hint');
  if (hint) hint.textContent = 'Set dialogue and thought formatting manually, or paste a template below to extract rules automatically.';
  // Hide re-extract row — not relevant when creating
  const reextractRow = existingRulesSection?.querySelector('.existing-rules-actions');
  if (reextractRow) reextractRow.hidden = true;
  // Renumber template section since rules is now "2"
  const tmplHeadingNew = document.getElementById('template-section-heading');
  if (tmplHeadingNew) tmplHeadingNew.textContent = '3 — Paste existing template';
  showExistingRulesSection({});
}

// ── Re-extract button (shown in existing-rules section) ──────────────────────
// Scrolls to the template textarea so the user can trigger a fresh extraction.
// After extraction, renderResults() will populate new rule cards for confirmation.

if (reextractBtn) {
  reextractBtn.addEventListener('click', () => {
    document.getElementById('template-section')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    templateIn.focus();
  });
}

// ── Show existing rules — WYSIWYG editor (edit mode) ─────────────────────────

function showExistingRulesSection(rules) {
  if (!existingRulesSection || !existingRulesContent) return;

  const ruleCount = Object.keys(rules).length;
  console.info('[editor] showExistingRulesSection — rules from DB:', ruleCount, 'keys', rules);

  // Initialise the draft. Empty object means "no rules yet" — toggles start off.
  _editedRulesJson = { ...rules };

  existingRulesSection.hidden = false;
  existingRulesContent.innerHTML = '';

  // Mount one WYSIWYG group per rule type, using the shared utility
  for (const group of WYSIWYG_RULE_GROUPS) {
    const section = makeWysiwygGroup(group, _editedRulesJson, (openKey, openVal, closeKey, closeVal) => {
      // Re-initialise if extraction cleared the draft
      if (_editedRulesJson === null) _editedRulesJson = {};
      _editedRulesJson[openKey]  = openVal;
      _editedRulesJson[closeKey] = closeVal;
      updateSaveBtn();
    });
    existingRulesContent.appendChild(section);
  }
}

// ── Shell HTML section parser / patcher ──────────────────────────────────────

function parseShellSections(html) {
  const raw = html.replace(/\[dohtml\]/gi, '').replace(/\[\/dohtml\]/gi, '').trim();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const body = doc.body;
  const rootEl = body.firstElementChild;

  let bgColor = '', borderColor = '';
  if (rootEl) {
    const style = rootEl.getAttribute('style') ?? '';
    const bgMatch = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/i);
    if (bgMatch) bgColor = bgMatch[1];
    const borderMatch = style.match(/border[^:]*:\s*[^;]*?(#[0-9a-fA-F]{3,8})/i);
    if (borderMatch) borderColor = borderMatch[1];
  }

  // Content text color — find style on element wrapping {{content}}
  const contentColorMatch = raw.match(/color\s*:\s*(#[0-9a-fA-F]{3,8})[^>]*>\s*\{\{content\}\}/i);
  const textColor = contentColorMatch ? contentColorMatch[1] : '';

  return {
    imageUrl:    body.querySelector('img')?.getAttribute('src') ?? '',
    bgColor,
    borderColor,
    lyr1: body.querySelector('.lyr1, [class*=" lyr1"], [class^="lyr1"]')?.textContent.trim() ?? '',
    lyr2: body.querySelector('.lyr2, [class*=" lyr2"], [class^="lyr2"]')?.textContent.trim() ?? '',
    lyr3: body.querySelector('.lyr3, [class*=" lyr3"], [class^="lyr3"]')?.textContent.trim() ?? '',
    textColor,
  };
}

function applyShellPatch(html, patches) {
  let out = html;
  if (patches.imageUrl !== undefined) {
    out = out.replace(/(src=["'])[^"']*(["'])/i, `$1${patches.imageUrl}$2`);
  }
  if (patches.bgColor) {
    out = out.replace(/(background(?:-color)?\s*:\s*)(#[0-9a-fA-F]{3,8})/i, `$1${patches.bgColor}`);
  }
  if (patches.borderColor) {
    out = out.replace(/(border[^:]*:\s*[^;]*?)(#[0-9a-fA-F]{3,8})/i, `$1${patches.borderColor}`);
  }
  if (patches.textColor) {
    out = out.replace(
      /(color\s*:\s*)(#[0-9a-fA-F]{3,8})([^>]*>\s*\{\{content\}\})/i,
      `$1${patches.textColor}$3`,
    );
  }
  for (const key of ['lyr1', 'lyr2', 'lyr3']) {
    if (patches[key] !== undefined) {
      // Replace text content inside class="lyr1/2/3" element (double and single quotes)
      out = out.replace(
        new RegExp(`(class="[^"]*${key}[^"]*"[^>]*>)[^<]*`, 'i'),
        `$1${patches[key]}`,
      );
      out = out.replace(
        new RegExp(`(class='[^']*${key}[^']*'[^>]*>)[^<]*`, 'i'),
        `$1${patches[key]}`,
      );
    }
  }
  return out;
}

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
  window.location.href = 'index.html';
});

// ── Enable extract button when template has content ───────────────────────────

templateIn.addEventListener('input', () => {
  const hasContent = templateIn.value.trim().length > 0;
  extractBtn.disabled = !hasContent;
  extractHint.textContent = hasContent ? 'Ready to extract.' : 'Enter a template to extract rules.';
});

charNameIn.addEventListener('input', updateSaveBtn);

// ── Extract ───────────────────────────────────────────────────────────────────

extractBtn.addEventListener('click', async () => {
  const template = templateIn.value.trim();
  if (!template) return;

  // Show results section + spinner
  resultsSection.hidden = false;
  spinner.hidden = false;
  extractError.classList.remove('visible');
  resultCards.innerHTML = '';
  unknownSection.hidden = true;
  cardStates.length = 0;
  // Extraction flow takes over — WYSIWYG draft no longer drives the save
  _editedRulesJson = null;
  updateSaveBtn();

  extractBtn.disabled = true;
  extractBtn.textContent = 'Extracting…';

  try {
    // Pass the session JWT explicitly — supabase.functions.invoke falls back to
    // the anon key as Bearer when using sb_publishable_ format, which the platform
    // rejects as "Invalid JWT". Passing it directly bypasses this SDK behaviour.
    const { data: { session: liveSession } } = await supabase.auth.getSession();
    if (!liveSession) { window.location.replace('index.html'); return; }

    const { data, error } = await supabase.functions.invoke('extract-template', {
      body: { template },
      headers: { Authorization: `Bearer ${liveSession.access_token}` },
    });

    if (error) {
      let detail = error.message;
      try {
        const body = await error.context.json();
        detail = body?.error ?? JSON.stringify(body);
      } catch { /* ignore */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);

    renderResults(data);

  } catch {
    extractError.textContent = 'Could not read that template. Try building manually instead — fill in the fields below and skip the extraction step.';
    extractError.classList.add('visible');
  } finally {
    spinner.hidden = true;
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Rules';
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ── Render results ────────────────────────────────────────────────────────────

function renderResults(result) {
  resultCards.innerHTML = '';
  cardStates.length = 0;

  // Shell HTML card
  if (result.shell_html) {
    const id = 'card-shell';
    cardStates.push({ id, kind: 'shell', data: result.shell_html, status: 'pending', resolvedType: 'shell' });
    resultCards.appendChild(makeShellCard(id, result.shell_html));
  }

  // Rule cards
  for (let i = 0; i < (result.rules ?? []).length; i++) {
    const rule = result.rules[i];
    const id = `card-rule-${i}`;
    cardStates.push({ id, kind: 'rule', data: rule, status: 'pending', resolvedType: rule.type });
    resultCards.appendChild(makeRuleCard(id, rule));
  }

  // Unknown patterns
  const unknowns = result.unknown_patterns ?? [];
  if (unknowns.length) {
    unknownSection.hidden = false;
    unknownList.innerHTML = '';
    for (const p of unknowns) {
      const li = document.createElement('li');
      li.className = 'unknown-item';
      li.textContent = p;
      unknownList.appendChild(li);
    }
  }

  updateSaveBtn();
}

// ── Shell HTML card ───────────────────────────────────────────────────────────

function makeShellCard(id, shellHtml) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = id;

  // Track current HTML (section editor patches it in place)
  let currentHtml = shellHtml;

  const refreshPreview = () => {
    const sampleHtml = currentHtml.replace('{{content}}',
      '<p style="color:inherit;font-style:italic;opacity:0.6;margin:0">[ post content appears here ]</p>');
    preview.innerHTML = sampleHtml;
    preCode.textContent = currentHtml;
    // Update cardState so save picks up changes
    const state = cardStates.find(s => s.id === id);
    if (state) state.data = currentHtml;
  };

  // Header
  const header = document.createElement('div');
  header.className = 'result-card-header';
  const typeTag = document.createElement('span');
  typeTag.className = 'type-tag type-tag--shell';
  typeTag.textContent = 'Shell HTML';
  header.appendChild(typeTag);
  card.appendChild(header);

  // Preview: replace {{content}} with sample
  const preview = document.createElement('div');
  preview.className = 'result-card-preview output-area';
  card.appendChild(preview);

  // ── Section editor ───────────────────────────────────────
  const sections = parseShellSections(currentHtml);
  const hasDetectedFields = sections.imageUrl || sections.bgColor || sections.borderColor
    || sections.lyr1 || sections.lyr2 || sections.lyr3 || sections.textColor;

  if (hasDetectedFields) {
    const sectionEditor = document.createElement('div');
    sectionEditor.className = 'shell-section-editor';

    const sectionHeading = document.createElement('p');
    sectionHeading.className = 'shell-section-heading';
    sectionHeading.textContent = 'Quick edit';
    sectionEditor.appendChild(sectionHeading);

    const grid = document.createElement('div');
    grid.className = 'shell-fields-grid';

    const addTextField = (label, val, patchKey) => {
      if (!val && patchKey !== 'imageUrl') return;
      const row = document.createElement('div');
      row.className = 'shell-field-row';
      const lbl = document.createElement('label');
      lbl.className = 'field-label';
      lbl.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'input';
      inp.value = val;
      inp.placeholder = patchKey === 'imageUrl' ? 'https://...' : '';
      inp.addEventListener('input', () => {
        currentHtml = applyShellPatch(currentHtml, { [patchKey]: inp.value });
        refreshPreview();
      });
      row.appendChild(lbl);
      row.appendChild(inp);
      grid.appendChild(row);
    };

    const addColorField = (label, val, patchKey) => {
      if (!val) return;
      const row = document.createElement('div');
      row.className = 'shell-field-row';
      const lbl = document.createElement('label');
      lbl.className = 'field-label';
      lbl.textContent = label;
      const wrap = document.createElement('div');
      wrap.className = 'shell-color-wrap';
      const native = document.createElement('input');
      native.type = 'color';
      native.className = 'shell-color-input';
      native.value = /^#[0-9a-fA-F]{6}$/i.test(val) ? val : '#000000';
      const hexIn = document.createElement('input');
      hexIn.type = 'text';
      hexIn.className = 'input input--mono shell-hex-input';
      hexIn.value = val;
      hexIn.placeholder = '#xxxxxx';
      hexIn.maxLength = 7;
      native.addEventListener('input', () => {
        hexIn.value = native.value;
        currentHtml = applyShellPatch(currentHtml, { [patchKey]: native.value });
        refreshPreview();
      });
      hexIn.addEventListener('input', () => {
        const v = hexIn.value.trim();
        if (/^#[0-9a-fA-F]{6}$/i.test(v)) {
          native.value = v;
          currentHtml = applyShellPatch(currentHtml, { [patchKey]: v });
          refreshPreview();
        }
      });
      wrap.appendChild(native);
      wrap.appendChild(hexIn);
      row.appendChild(lbl);
      row.appendChild(wrap);
      grid.appendChild(row);
    };

    addTextField('Header Image URL', sections.imageUrl, 'imageUrl');
    addColorField('Background Color', sections.bgColor, 'bgColor');
    addColorField('Border Color',     sections.borderColor, 'borderColor');
    addTextField('Header Line 1', sections.lyr1, 'lyr1');
    addTextField('Header Line 2', sections.lyr2, 'lyr2');
    addTextField('Header Line 3', sections.lyr3, 'lyr3');
    addColorField('Content Text Color', sections.textColor, 'textColor');

    sectionEditor.appendChild(grid);
    card.appendChild(sectionEditor);
  }

  // Raw shell HTML (collapsed)
  const rawWrap = document.createElement('details');
  rawWrap.className = 'result-card-raw';
  const summary = document.createElement('summary');
  summary.className = 'field-label';
  summary.textContent = 'Edit raw HTML';
  rawWrap.appendChild(summary);
  const preCode = document.createElement('pre');
  preCode.className = 'raw-code';
  preCode.textContent = currentHtml;
  rawWrap.appendChild(preCode);
  card.appendChild(rawWrap);

  // Initial preview render
  refreshPreview();

  card.appendChild(makeCardActions(id));
  return card;
}

// ── Rule card ─────────────────────────────────────────────────────────────────

const RULE_TYPES = ['dialogue', 'thought', 'action', 'narration', 'other'];
const RULE_SAMPLES = {
  dialogue:  '"She said hello."',
  thought:   "'I wonder if they know.'",
  action:    '-- She reached for the door. --',
  narration: 'The room fell silent.',
  other:     'Sample text here.',
};

function makeRuleCard(id, rule) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = id;

  // Header: type tag + type dropdown
  const header = document.createElement('div');
  header.className = 'result-card-header';

  const typeTag = document.createElement('span');
  typeTag.className = `type-tag type-tag--${rule.type}`;
  typeTag.textContent = capitalise(rule.type);
  header.appendChild(typeTag);

  const typeSel = document.createElement('select');
  typeSel.className = 'dropdown rule-type-select';
  typeSel.setAttribute('aria-label', 'Change rule type');
  for (const t of RULE_TYPES) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = capitalise(t);
    opt.selected = t === rule.type;
    typeSel.appendChild(opt);
  }
  typeSel.addEventListener('change', () => {
    const state = cardStates.find(s => s.id === id);
    if (state) state.resolvedType = typeSel.value;
    typeTag.className = `type-tag type-tag--${typeSel.value}`;
    typeTag.textContent = capitalise(typeSel.value);
    updateSamplePreview(id, rule, typeSel.value);
  });
  header.appendChild(typeSel);
  card.appendChild(header);

  // Markers display
  const markers = document.createElement('div');
  markers.className = 'result-card-markers';

  const mkRow = (label, val) => {
    const row = document.createElement('div');
    row.className = 'marker-row';
    const lbl = document.createElement('span');
    lbl.className = 'field-label';
    lbl.textContent = label;
    const code = document.createElement('code');
    code.className = 'marker-code';
    code.textContent = val || '(none)';
    row.appendChild(lbl);
    row.appendChild(code);
    return row;
  };
  markers.appendChild(mkRow('Opening:', rule.opening_marker));
  markers.appendChild(mkRow('Closing:', rule.closing_marker));

  const badges = document.createElement('div');
  badges.className = 'marker-badges';
  if (rule.bold)  badges.appendChild(makeBadge('Bold'));
  if (rule.italic) badges.appendChild(makeBadge('Italic'));
  if (rule.color) badges.appendChild(makeBadge(rule.color, rule.color));
  markers.appendChild(badges);
  card.appendChild(markers);

  // Sample rendered output
  const sampleWrap = document.createElement('div');
  sampleWrap.className = 'result-card-sample';
  const sampleLabel = document.createElement('span');
  sampleLabel.className = 'field-label';
  sampleLabel.textContent = 'Sample output';
  const sampleOut = document.createElement('div');
  sampleOut.className = 'sample-output output-area';
  sampleOut.id = `${id}-sample`;
  sampleOut.textContent = `${rule.opening_marker}${RULE_SAMPLES[rule.type] ?? 'Sample text.'}${rule.closing_marker}`;
  sampleWrap.appendChild(sampleLabel);
  sampleWrap.appendChild(sampleOut);
  card.appendChild(sampleWrap);

  card.appendChild(makeCardActions(id));
  return card;
}

function updateSamplePreview(id, rule, newType) {
  const el = document.getElementById(`${id}-sample`);
  if (el) {
    el.textContent = `${rule.opening_marker}${RULE_SAMPLES[newType] ?? 'Sample text.'}${rule.closing_marker}`;
  }
}

// ── Card action buttons (Confirm / Skip) ──────────────────────────────────────

function makeCardActions(id) {
  const footer = document.createElement('div');
  footer.className = 'result-card-footer';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn-sm btn-primary result-confirm-btn';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.dataset.cardId = id;
  confirmBtn.addEventListener('click', () => setCardStatus(id, 'confirmed'));

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'btn-sm btn-ghost result-skip-btn';
  skipBtn.textContent = 'Skip';
  skipBtn.dataset.cardId = id;
  skipBtn.addEventListener('click', () => setCardStatus(id, 'skipped'));

  footer.appendChild(confirmBtn);
  footer.appendChild(skipBtn);
  return footer;
}

function setCardStatus(id, status) {
  const state = cardStates.find(s => s.id === id);
  if (!state) return;
  state.status = status;

  const card = document.getElementById(id);
  if (card) {
    card.classList.toggle('card--confirmed', status === 'confirmed');
    card.classList.toggle('card--skipped',   status === 'skipped');

    const confirmBtn = card.querySelector('.result-confirm-btn');
    const skipBtn    = card.querySelector('.result-skip-btn');
    if (confirmBtn) {
      confirmBtn.textContent = status === 'confirmed' ? '✓ Confirmed' : 'Confirm';
      confirmBtn.disabled    = status === 'confirmed';
    }
    if (skipBtn) {
      skipBtn.textContent = status === 'skipped' ? 'Skipped' : 'Skip';
      skipBtn.disabled    = status === 'skipped';
    }
  }

  updateSaveBtn();
}

function updateSaveBtn() {
  const hasCharName = charNameIn.value.trim().length > 0;
  const hasAnyConfirmed = cardStates.some(s => s.status === 'confirmed');
  const hasEditedRules  = _editedRulesJson && Object.keys(_editedRulesJson).length > 0;
  saveBtn.disabled = !hasCharName;
  if (!hasCharName) {
    saveStatus.textContent = 'Enter a character name to save.';
  } else if (_editedRulesJson !== null) {
    if (hasEditedRules) {
      saveStatus.textContent = '✎ Rules ready to save.';
    } else if (_editCharId) {
      saveStatus.textContent = 'Rules cleared — will save blank rules.';
    } else {
      saveStatus.textContent = 'No rules set yet — save as-is or paste a template to extract.';
    }
  } else {
    saveStatus.textContent = hasAnyConfirmed
      ? `${cardStates.filter(s => s.status === 'confirmed').length} item(s) confirmed.`
      : 'No items confirmed yet — will create a blank template.';
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const characterName = charNameIn.value.trim();
  const templateName  = tmplNameIn.value.trim() || 'Default';
  if (!characterName) return;

  const successMsg = _editCharId
    ? `✓ "${characterName}" updated.`
    : `✓ Character "${characterName}" and template "${templateName}" created.`;

  await withFeedback(saveBtn, saveStatus, async () => {
    // Build template payload.
    // Priority order for rules:
    //   1. _editedRulesJson (WYSIWYG editor in edit-mode existing-rules section)
    //   2. confirmed cardStates from extraction flow
    //   3. blank (no rules saved)
    const confirmed = cardStates.filter(s => s.status === 'confirmed');
    let shellHtml   = templateIn.value.trim() || null;  // fall back to raw textarea value
    let rules;

    if (_editedRulesJson !== null) {
      // WYSIWYG editor was used — trust it directly (shell comes from textarea)
      rules = { ..._editedRulesJson };
    } else {
      // Extraction flow — build rules + shell from confirmed cards
      rules = {};
      for (const state of confirmed) {
        if (state.kind === 'shell') {
          shellHtml = state.data;
        } else if (state.kind === 'rule') {
          const rule = state.data;
          const type = state.resolvedType;
          if (type === 'dialogue') {
            rules.dialogueOpen  = rule.opening_marker;
            rules.dialogueClose = rule.closing_marker;
          } else if (type === 'thought') {
            rules.thoughtOpen   = rule.opening_marker;
            rules.thoughtClose  = rule.closing_marker;
          }
        }
      }
    }

    if (_editCharId) {
      // ── Edit mode: UPDATE existing character + template ─────────────────────
      const { error: charErr } = await supabase
        .from('characters').update({ name: characterName }).eq('id', _editCharId);
      if (charErr) throw new Error('Could not save that change. Try again or export a backup from the Library page.');

      const tmplPayload = {
        name:       templateName,
        shell_html: shellHtml,
        rules_json: Object.keys(rules).length ? rules : null,
      };

      if (_editTmplId) {
        const { error: tmplErr } = await supabase
          .from('templates').update(tmplPayload).eq('id', _editTmplId);
        if (tmplErr) throw new Error('Could not save that change. Try again or export a backup from the Library page.');
      } else {
        // Character had no template — create one
        const { error: tmplErr } = await supabase
          .from('templates').insert({ ...tmplPayload, character_id: _editCharId });
        if (tmplErr) throw new Error('Could not save that change. Try again or export a backup from the Library page.');
      }

    } else {
      // ── Create mode: INSERT new character + template ─────────────────────────
      const { data: charRows, error: charErr } = await supabase
        .from('characters')
        .insert({ user_id: userId, name: characterName })
        .select('id');
      if (charErr) throw new Error('Could not save that change. Try again or export a backup from the Library page.');
      const characterId = charRows[0].id;

      const { error: tmplErr } = await supabase
        .from('templates')
        .insert({
          character_id: characterId,
          name:         templateName,
          shell_html:   shellHtml,
          rules_json:   Object.keys(rules).length ? rules : null,
        });
      if (tmplErr) throw new Error('Could not save that change. Try again or export a backup from the Library page.');
    }

    setTimeout(() => { window.location.href = 'manage.html'; }, 1500);
  }, {
    loading:    'Saving…',
    btnSuccess: '✓ Saved',
    success:    successMsg,
    clearDelay: 0,
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalise(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : str;
}

function makeBadge(label, color) {
  const span = document.createElement('span');
  span.className = 'marker-badge';
  span.textContent = label;
  if (color) span.style.setProperty('--badge-color', color);
  return span;
}
