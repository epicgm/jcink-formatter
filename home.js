/**
 * home.js — Main formatter page logic
 * Requires config.js loaded first (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { formatPost } from './parser.js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// ── Auth guard ────────────────────────────────────────────────────────────────

const { data: { session } } = await supabase.auth.getSession();
if (!session) { window.location.href = 'index.html'; }
const userId = session.user.id;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const charSelect  = document.getElementById('character-select');
const tmplSelect  = document.getElementById('template-select');
const rawInput    = document.getElementById('raw-input');
const outputEl    = document.getElementById('formatted-output');
const copyBtn     = document.getElementById('copy-btn');
const logoutBtn   = document.getElementById('logout-btn');
const charStatus  = document.getElementById('char-status');

// ── State ─────────────────────────────────────────────────────────────────────

let _templates     = {};   // id → full template object
let currentTmpl    = null;
let currentRepls   = [];

// ── localStorage helpers ──────────────────────────────────────────────────────

const CKEY_CHARS = (uid) => `jcink_chars_${uid}`;
const CKEY_TMPLS = (cid) => `jcink_tmpls_${cid}`;

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

  const { data, error } = await supabase
    .from('characters')
    .select('id, name')
    .eq('user_id', userId)
    .order('name');

  // Always write to localStorage as fallback cache
  const chars = data ?? cacheRead(CKEY_CHARS(userId)) ?? [];
  cacheWrite(CKEY_CHARS(userId), chars);

  charSelect.innerHTML = '<option value="">— Select character —</option>';

  if (chars.length === 0) {
    charStatus.textContent = 'No characters yet';
  } else {
    charStatus.textContent = '';
    for (const c of chars) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      charSelect.appendChild(opt);
    }
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

  const { data } = await supabase
    .from('templates')
    .select('id, name, shell_html, rules_json, active_block_ids')
    .eq('character_id', characterId)
    .order('name');

  // Always write to localStorage as fallback cache
  const tmpls = data ?? cacheRead(CKEY_TMPLS(characterId)) ?? [];
  cacheWrite(CKEY_TMPLS(characterId), tmpls);

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

  const ids = tmpl.active_block_ids;
  const [{ data: userBlocks }, { data: boardBlocks }] = await Promise.all([
    supabase.from('user_library').select('trigger, replacement_html').in('id', ids),
    supabase.from('board_library').select('trigger, replacement_html').in('id', ids),
  ]);

  return [...(userBlocks ?? []), ...(boardBlocks ?? [])];
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
  }
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
});

// ── Init ──────────────────────────────────────────────────────────────────────

await loadCharacters();
updateOutput();
