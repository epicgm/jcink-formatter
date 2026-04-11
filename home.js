/**
 * home.js — Main formatter page logic
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

// ── Auth guard + role ─────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.replace('index.html'); throw 0; }
const userId = session.user.id;

// Show Admin nav link for admin users
const _adminLink = document.getElementById('admin-link');
if (_adminLink && localStorage.getItem('inkform_role') === 'admin') {
  _adminLink.hidden = false;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const charSelect      = document.getElementById('character-select');
const tmplSelect      = document.getElementById('template-select');
const rawInput        = document.getElementById('raw-input');
const outputEl        = document.getElementById('formatted-output');
const copyBtn         = document.getElementById('copy-btn');
const logoutBtn       = document.getElementById('logout-btn');
const charStatus      = document.getElementById('char-status');
const drawerToggle    = document.getElementById('drawer-toggle');
const drawerClose     = document.getElementById('drawer-close');
const builderDrawer   = document.getElementById('builder-drawer');
const drawerBody      = document.getElementById('builder-drawer-body');
const formatterControls = document.getElementById('formatter-controls');
const formatterMain   = document.getElementById('formatter-main');
const onboarding      = document.getElementById('onboarding');
const paneTabWrite    = document.getElementById('pane-tab-write');
const paneTabPreview  = document.getElementById('pane-tab-preview');
const paneInput       = document.querySelector('.pane--input');
const paneOutput      = document.querySelector('.pane--output');

// ── State ─────────────────────────────────────────────────────────────────────

let _templates     = {};   // id → full template object
let currentTmpl    = null;
let currentRepls   = [];
let _isOnline      = true;

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

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadCharacters() {
  charSelect.disabled = true;
  charStatus.textContent = 'Loading…';

  let chars;
  if (_isOnline) {
    const { data, error } = await supabase
      .from('characters')
      .select('id, name')
      .eq('user_id', userId)
      .order('name');
    if (error) {
      charStatus.textContent = 'Having trouble connecting. Your work is saved locally.';
    }
    chars = data ?? cacheRead(CKEY_CHARS(userId)) ?? [];
    if (data) cacheWrite(CKEY_CHARS(userId), chars);
  } else {
    chars = cacheRead(CKEY_CHARS(userId)) ?? [];
  }

  charSelect.innerHTML = '<option value="">— Select character —</option>';

  // Show onboarding for brand-new users; show formatter for everyone else
  if (chars.length === 0) {
    onboarding.hidden = false;
    formatterControls.hidden = true;
    formatterMain.hidden = true;
    charStatus.textContent = '';
    charSelect.disabled = false;
    return;
  }

  onboarding.hidden = true;
  formatterControls.hidden = false;
  formatterMain.hidden = false;

  charStatus.textContent = '';
  for (const c of chars) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    charSelect.appendChild(opt);
  }

  charSelect.disabled = false;
}

async function loadTemplates(characterId) {
  _templates    = {};
  currentTmpl   = null;
  currentRepls  = [];
  tmplSelect.innerHTML = '<option value="">— Select template —</option>';
  tmplSelect.disabled  = true;

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

  for (const tmpl of tmpls) {
    _templates[tmpl.id] = tmpl;
    const opt = document.createElement('option');
    opt.value = tmpl.id;
    opt.textContent = tmpl.name;
    tmplSelect.appendChild(opt);
  }

  tmplSelect.disabled = (tmpls.length === 0);
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

// ── Formatter ─────────────────────────────────────────────────────────────────

function updateOutput() {
  const raw       = rawInput.value;
  const formatted = formatPost(raw, {
    replacements: currentRepls,
    shellHtml:    currentTmpl?.shell_html ?? null,
    rules:        currentTmpl?.rules_json ?? {},
  });
  outputEl.innerHTML = formatted || '<span class="output-placeholder">Formatted output appears here…</span>';
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

async function copyToClipboard(text) {
  // Primary: Clipboard API (requires HTTPS — works on GitHub Pages)
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  // Fallback: execCommand (iOS Safari < 13.4, older browsers)
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

charSelect.addEventListener('change', async () => {
  await loadTemplates(charSelect.value);
  updateOutput();
});

tmplSelect.addEventListener('change', async () => {
  currentTmpl  = _templates[tmplSelect.value] ?? null;
  currentRepls = await loadReplacements(currentTmpl);
  updateOutput();
});

rawInput.addEventListener('input', updateOutput);

copyBtn.addEventListener('click', async () => {
  const content = outputEl.innerHTML.includes('output-placeholder')
    ? ''
    : outputEl.innerHTML;
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

// ── Mobile pane tabs ──────────────────────────────────────────────────────────

function activatePaneTab(active) {
  const isWrite = active === 'input';
  paneTabWrite.classList.toggle('active', isWrite);
  paneTabWrite.setAttribute('aria-pressed', String(isWrite));
  paneTabPreview.classList.toggle('active', !isWrite);
  paneTabPreview.setAttribute('aria-pressed', String(!isWrite));
  paneInput.classList.toggle('pane--mobile-hidden', !isWrite);
  paneOutput.classList.toggle('pane--mobile-hidden', isWrite);
}

paneTabWrite.addEventListener('click', () => activatePaneTab('input'));
paneTabPreview.addEventListener('click', () => {
  activatePaneTab('output');
  // Auto-switch to preview when user clicks — scroll output into view on mobile
  paneOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  localStorage.removeItem('inkform_role');
  window.location.href = 'index.html';
});

// ── Block builder drawer ──────────────────────────────────────────────────────

let _drawerMounted = false;

function openDrawer() {
  builderDrawer.hidden = false;
  drawerToggle.textContent = '✕ Close Builder';
  if (!_drawerMounted) {
    mountBlockBuilder(drawerBody, {
      onSave: async ({ trigger, replacement_html }) => {
        const { error } = await supabase
          .from('user_library')
          .insert({ user_id: userId, trigger, replacement_html });
        if (error) throw error;
        // Reload replacements if the current template uses auto-blocks
        if (currentTmpl) {
          currentRepls = await loadReplacements(currentTmpl);
          updateOutput();
        }
      },
    });
    _drawerMounted = true;
  }
  builderDrawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDrawer() {
  builderDrawer.hidden = true;
  drawerToggle.textContent = '+ Block Builder';
}

drawerToggle.addEventListener('click', () => {
  builderDrawer.hidden ? openDrawer() : closeDrawer();
});
drawerClose.addEventListener('click', closeDrawer);

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
