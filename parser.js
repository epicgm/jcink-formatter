/**
 * parser.js — Jcink post formatting engine
 *
 * Pipeline (in order):
 *   1. Block replacements   ::trigger:: → replacement_html
 *   2. Inline rules         dialogue markers, thought markers
 *   3. Shell wrapper        shell_html with {{content}} placeholder
 *
 * Safe against:
 *   - Apostrophes inside dialogue  "I don't know"  → full dialogue wrap
 *   - Possessives                  Helena's         → not treated as thought
 *   - Curly quotes                 \u201C\u201D     → normalised to straight "
 *
 * Quote handling:
 *   The open/close rule strings wrap the FULL matched token (including its
 *   original quote characters). Rules must NOT include the quote characters
 *   themselves — they come from the input text.
 *
 *   Correct:   dialogueOpen  = '[color=red][b]'   (no " at end)
 *   Incorrect: dialogueOpen  = '[color=red][b]"'  (doubles the ")
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {string} raw
 * @param {{
 *   replacements?: Array<{trigger:string, replacement_html:string}>,
 *   shellHtml?:    string|null,
 *   rules?:        object
 * }} options
 * @returns {string}  BBCode / HTML string suitable for clipboard copy
 */
export function formatPost(raw = '', { replacements = [], shellHtml = null, rules = {} } = {}) {
  let text = raw;
  text = applyReplacements(text, replacements);
  text = applyInlineRules(text, rules);
  if (shellHtml) text = shellHtml.replace('{{content}}', text);
  return text;
}

/**
 * Convert common BBCode tags to inline HTML for the live preview pane.
 * Apply ONLY to the display string — the copy-to-clipboard string must
 * retain raw BBCode so it pastes correctly into Jcink.
 *
 * @param {string} text
 * @returns {string}
 */
export function convertBBCodeToHTML(text) {
  return text
    .replace(/\[color=([^\]]+)\]/gi, '<span style="color:$1">')
    .replace(/\[\/color\]/gi, '</span>')
    .replace(/\[b\]/gi, '<strong>')
    .replace(/\[\/b\]/gi, '</strong>')
    .replace(/\[i\]/gi, '<em>')
    .replace(/\[\/i\]/gi, '</em>')
    .replace(/\[u\]/gi, '<span style="text-decoration:underline">')
    .replace(/\[\/u\]/gi, '</span>')
    .replace(/\n/g, '<br>');
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

  // ── Dialogue: any double-quote style → straight " in output ──────
  //
  // Match any opening double-quote variant (" straight, \u201C left-curly,
  // \u201D right-curly), capture inner content, match any closing variant.
  //
  // IMPORTANT: the REPLACEMENT always emits literal straight " chars — it
  // does NOT reuse the matched open/close chars. This means:
  //   • curly/smart quotes are normalised to straight in the output
  //   • there is no doubling even if dialogueOpen/Close happen to contain
  //     a " character, because the output quotes come from the literal
  //     replacement string, not from the regex match
  const dialogueRe = /[\u201C\u201D"]([^"\u201C\u201D]*?)[\u201C\u201D"]/g;
  text = text.replace(dialogueRe, (_, inner) =>
    `${c.dialogueOpen}"${inner}"${c.dialogueClose}`
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
  //
  // Replacement emits literal ' chars for the same reason as dialogue.
  text = text.replace(/(?<!\w)'((?:[^']|\w'\w)+)'(?!\w)/g, (_, inner) =>
    `${c.thoughtOpen}'${inner}'${c.thoughtClose}`
  );

  return text;
}
