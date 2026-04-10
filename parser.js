/**
 * parser.js — Jcink post formatting engine
 *
 * Pipeline (in order):
 *   1. Block replacements   ::trigger:: → replacement_html
 *   2. Inline rules         dialogue markers (straight + curly), thought markers
 *   3. Shell wrapper        shell_html with {{content}} placeholder
 *
 * Safe against:
 *   - Apostrophes inside dialogue  "I don't know"  → full dialogue span
 *   - Possessives                  Helena's         → not treated as thought
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {string} raw
 * @param {{
 *   replacements?: Array<{trigger:string, replacement_html:string}>,
 *   shellHtml?:    string|null,
 *   rules?:        object
 * }} options
 * @returns {string}
 */
export function formatPost(raw = '', { replacements = [], shellHtml = null, rules = {} } = {}) {
  let text = raw;
  text = applyReplacements(text, replacements);
  text = applyInlineRules(text, rules);
  if (shellHtml) text = shellHtml.replace('{{content}}', text);
  return text;
}

// ── Block replacements ────────────────────────────────────────────────────────

function applyReplacements(text, replacements) {
  for (const { trigger, replacement_html } of replacements) {
    if (!trigger) continue;
    const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`::${esc}::`, 'gi'), replacement_html ?? '');
  }
  return text;
}

// ── Inline rules ──────────────────────────────────────────────────────────────

const DEFAULTS = {
  dialogueOpen:  '<span class="dialogue">',
  dialogueClose: '</span>',
  thoughtOpen:   '<span class="thought">',
  thoughtClose:  '</span>',
};

function applyInlineRules(text, rules = {}) {
  const c = { ...DEFAULTS, ...rules };

  // ── Dialogue: straight double quotes ─────────────────────────────
  // [^"]+ matches everything inside, including apostrophes (don't, I'm).
  text = text.replace(/"([^"]+)"/g, (_, inner) =>
    `${c.dialogueOpen}"${inner}"${c.dialogueClose}`
  );

  // ── Dialogue: curly double quotes (" ") ─────────────────────────
  text = text.replace(/\u201C([^\u201D]+)\u201D/g, (_, inner) =>
    `${c.dialogueOpen}\u201C${inner}\u201D${c.dialogueClose}`
  );

  // ── Thoughts: single quotes, excluding apostrophes & possessives ──
  //
  // (?<!\w)   opening ' must NOT be preceded by a word char
  //           → excludes Helena's (a precedes ')
  //
  // (?:[^']|\w'\w)+
  //           content is either not-a-quote, OR a quote flanked by
  //           word chars on both sides (apostrophe: don't, I'm, it's)
  //
  // (?!\w)    closing ' must NOT be followed by a word char
  //           → excludes trailing possessives / contractions
  text = text.replace(/(?<!\w)'((?:[^']|\w'\w)+)'(?!\w)/g, (_, inner) =>
    `${c.thoughtOpen}'${inner}'${c.thoughtClose}`
  );

  return text;
}
