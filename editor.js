/**
 * editor.js — New character flow with Claude-powered template extraction
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

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
if (_navUsername) _navUsername.textContent = session.user.email.split('@')[0];

// ── State ─────────────────────────────────────────────────────────────────────

// cardStates: array of { id, kind: 'shell'|'rule', data, status: 'pending'|'confirmed'|'skipped', resolvedType }
const cardStates = [];

// ── Load existing character in edit mode ──────────────────────────────────────

if (_editCharId) {
  // Update page chrome for edit mode
  document.title = 'Edit Character — inkform';
  const titleEl = document.querySelector('.editor-title');
  if (titleEl) titleEl.textContent = 'Edit Character';
  saveBtn.textContent = 'Save Changes';

  // Load character name
  const { data: charRow } = await supabase
    .from('characters').select('name').eq('id', _editCharId).single();
  if (charRow) charNameIn.value = charRow.name;

  // Load first template (shell_html + name)
  const { data: tmplRows } = await supabase
    .from('templates').select('id, name, shell_html')
    .eq('character_id', _editCharId).limit(1);
  if (tmplRows?.length) {
    _editTmplId = tmplRows[0].id;
    tmplNameIn.value  = tmplRows[0].name  ?? 'Default';
    templateIn.value  = tmplRows[0].shell_html ?? '';
    if (templateIn.value) {
      extractBtn.disabled = false;
      extractHint.textContent = 'Template loaded — re-extract or save changes.';
    }
  }
  updateSaveBtn();
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
  const sampleHtml = shellHtml.replace('{{content}}',
    '<p style="color:inherit;font-style:italic;opacity:0.6;margin:0">[ post content appears here ]</p>');
  // Renders user's own template HTML intentionally
  preview.innerHTML = sampleHtml;
  card.appendChild(preview);

  // Raw shell HTML (collapsed)
  const rawWrap = document.createElement('details');
  rawWrap.className = 'result-card-raw';
  const summary = document.createElement('summary');
  summary.className = 'field-label';
  summary.textContent = 'Shell HTML source';
  rawWrap.appendChild(summary);
  const pre = document.createElement('pre');
  pre.className = 'raw-code';
  pre.textContent = shellHtml;
  rawWrap.appendChild(pre);
  card.appendChild(rawWrap);

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
  // Allow saving with just a character name (even with no confirmed cards — creates blank template)
  saveBtn.disabled = !hasCharName;
  saveStatus.textContent = hasCharName
    ? (hasAnyConfirmed
        ? `${cardStates.filter(s => s.status === 'confirmed').length} item(s) confirmed.`
        : 'No items confirmed yet — will create a blank template.')
    : 'Enter a character name to save.';
}

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  const characterName = charNameIn.value.trim();
  const templateName  = tmplNameIn.value.trim() || 'Default';
  if (!characterName) return;

  saveBtn.disabled = true;
  saveStatus.textContent = 'Saving…';

  try {
    // 2. Build template payload from confirmed cards (used in both create + edit)
    const confirmed = cardStates.filter(s => s.status === 'confirmed');
    let shellHtml   = templateIn.value.trim() || null;  // fall back to raw textarea value
    const rules     = {};

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

    if (_editCharId) {
      // ── Edit mode: UPDATE existing character + template ─────────────────────
      const { error: charErr } = await supabase
        .from('characters').update({ name: characterName }).eq('id', _editCharId);
      if (charErr) throw charErr;

      const tmplPayload = {
        name:       templateName,
        shell_html: shellHtml,
        rules_json: Object.keys(rules).length ? rules : null,
      };

      if (_editTmplId) {
        const { error: tmplErr } = await supabase
          .from('templates').update(tmplPayload).eq('id', _editTmplId);
        if (tmplErr) throw tmplErr;
      } else {
        // Character had no template — create one
        const { error: tmplErr } = await supabase
          .from('templates').insert({ ...tmplPayload, character_id: _editCharId });
        if (tmplErr) throw tmplErr;
      }

      saveStatus.textContent = `✓ "${characterName}" updated.`;
      saveBtn.textContent = '✓ Saved';
      setTimeout(() => { window.location.href = 'manage.html'; }, 1500);

    } else {
      // ── Create mode: INSERT new character + template ─────────────────────────
      const { data: charRows, error: charErr } = await supabase
        .from('characters')
        .insert({ user_id: userId, name: characterName })
        .select('id');
      if (charErr) throw charErr;
      const characterId = charRows[0].id;

      const { error: tmplErr } = await supabase
        .from('templates')
        .insert({
          character_id: characterId,
          name:         templateName,
          shell_html:   shellHtml,
          rules_json:   Object.keys(rules).length ? rules : null,
        });
      if (tmplErr) throw tmplErr;

      saveStatus.textContent = `✓ Character "${characterName}" and template "${templateName}" created.`;
      saveBtn.textContent = '✓ Saved';
      setTimeout(() => { window.location.href = 'manage.html'; }, 1500);
    }

  } catch {
    saveStatus.textContent = 'Could not save that change. Try again or export a backup from the Library page.';
    saveBtn.disabled = false;
    saveBtn.textContent = _editCharId ? 'Save Changes' : 'Create Character & Template';
  }
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
