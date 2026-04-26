/**
 * utils.js — Shared UI helpers
 */
import { convertBBCodeToHTML } from './parser.js';

/**
 * Run an async action with button loading-state + optional inline status feedback.
 *
 * @param {HTMLButtonElement}   button
 * @param {HTMLElement|null}    messageEl   Status text element (may be null)
 * @param {() => Promise<void>} action      Should throw on failure
 * @param {object}              [opts]
 * @param {string}  [opts.loading='Saving…']    Button text while running
 * @param {string|null} [opts.success=null]     Text for messageEl on success; null = skip
 * @param {string|null} [opts.btnSuccess=null]  Button text on success; null = restore original
 * @param {number}  [opts.clearDelay=3000]      ms before success text clears; 0 = never
 */
// ── BBCode / WYSIWYG rule helpers ─────────────────────────────────────────────

/**
 * Parse a BBCode opening marker string into component flags.
 * @param {string} openVal  e.g. '[b][color=#ff0000]'
 * @returns {{ bold, italic, hasColor, color }}
 */
export function parseBBCodeMarker(openVal = '') {
  const bold  = /\[b\]/i.test(openVal);
  const italic = /\[i\]/i.test(openVal);
  const colorMatch = openVal.match(/\[color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\]/i);
  const color = colorMatch ? colorMatch[1] : null;
  return { bold, italic, hasColor: !!color, color: color ?? '#ffffff' };
}

/**
 * Build BBCode open + close strings from component flags.
 * @returns {{ open: string, close: string }}
 */
export function buildBBCodeMarker({ bold, italic, hasColor, color }) {
  let openTags = '', closeTags = '';
  if (bold)              { openTags += '[b]';              closeTags = '[/b]'     + closeTags; }
  if (italic)            { openTags += '[i]';              closeTags = '[/i]'     + closeTags; }
  if (hasColor && color) { openTags += `[color=${color}]`; closeTags = '[/color]' + closeTags; }
  return { open: openTags, close: closeTags };
}

const WYSIWYG_RULE_GROUPS = [
  { label: 'Dialogue', openKey: 'dialogueOpen', closeKey: 'dialogueClose', sample: 'She said hello.' },
  { label: 'Thought',  openKey: 'thoughtOpen',  closeKey: 'thoughtClose',  sample: "I wonder if they know." },
];
export { WYSIWYG_RULE_GROUPS };

/**
 * Build a WYSIWYG rule section (Bold/Italic/Color toggles + live preview + advanced raw).
 *
 * @param {object}   group          { label, openKey, closeKey, sample }
 * @param {object}   rules          Current rules_json object (read-only; values copied out)
 * @param {function} onRulesUpdate  Called with (openKey, openVal, closeKey, closeVal) on any change
 * @returns {HTMLElement}
 */
export function makeWysiwygGroup(group, rules, onRulesUpdate) {
  const { label, openKey, closeKey, sample } = group;
  const state = parseBBCodeMarker(rules[openKey] ?? '');

  const section = document.createElement('div');
  section.className = 'wysiwyg-rule-section';

  // Heading
  const heading = document.createElement('h4');
  heading.className = 'wysiwyg-rule-heading';
  heading.textContent = label;
  section.appendChild(heading);

  // ── Format button row ─────────────────────────────────────────
  const fmtRow = document.createElement('div');
  fmtRow.className = 'wysiwyg-fmt-row';

  const boldBtn = document.createElement('button');
  boldBtn.type = 'button';
  boldBtn.className = `wysiwyg-fmt-btn${state.bold ? ' active' : ''}`;
  boldBtn.title = 'Bold';
  boldBtn.innerHTML = '<strong>B</strong>';

  const italicBtn = document.createElement('button');
  italicBtn.type = 'button';
  italicBtn.className = `wysiwyg-fmt-btn${state.italic ? ' active' : ''}`;
  italicBtn.title = 'Italic';
  italicBtn.innerHTML = '<em>I</em>';

  // Color control
  const colorWrap = document.createElement('div');
  colorWrap.className = 'wysiwyg-color-wrap';

  const colorToggle = document.createElement('button');
  colorToggle.type = 'button';
  colorToggle.className = `wysiwyg-color-toggle${state.hasColor ? ' active' : ''}`;

  const colorDot = document.createElement('span');
  colorDot.className = 'wysiwyg-color-dot';
  colorDot.style.backgroundColor = state.hasColor ? state.color : '#888888';
  colorToggle.appendChild(colorDot);
  colorToggle.appendChild(document.createTextNode(' Color'));

  const colorNative = document.createElement('input');
  colorNative.type = 'color';
  colorNative.className = 'wysiwyg-color-input';
  colorNative.value = /^#[0-9a-fA-F]{6}$/i.test(state.color) ? state.color : '#ffffff';

  const hexIn = document.createElement('input');
  hexIn.type = 'text';
  hexIn.className = 'input input--mono wysiwyg-hex-input';
  hexIn.placeholder = '#xxxxxx';
  hexIn.maxLength = 7;
  hexIn.value = state.hasColor ? state.color : '';

  colorWrap.appendChild(colorToggle);
  colorWrap.appendChild(colorNative);
  colorWrap.appendChild(hexIn);

  fmtRow.appendChild(boldBtn);
  fmtRow.appendChild(italicBtn);
  fmtRow.appendChild(colorWrap);
  section.appendChild(fmtRow);

  // ── Live preview ──────────────────────────────────────────────
  const prevWrap = document.createElement('div');
  prevWrap.className = 'wysiwyg-preview';
  const prevLabel = document.createElement('span');
  prevLabel.className = 'field-label';
  prevLabel.textContent = 'Preview';
  const prevEl = document.createElement('div');
  prevEl.className = 'wysiwyg-preview-output';
  prevWrap.appendChild(prevLabel);
  prevWrap.appendChild(prevEl);
  section.appendChild(prevWrap);

  // ── Advanced — raw BBCode ─────────────────────────────────────
  const advanced = document.createElement('details');
  advanced.className = 'wysiwyg-advanced';
  const advSum = document.createElement('summary');
  advSum.textContent = 'Advanced (raw BBCode)';
  advanced.appendChild(advSum);

  const rawRow = document.createElement('div');
  rawRow.className = 'wysiwyg-raw-row';

  const openField = document.createElement('div');
  openField.className = 'wysiwyg-raw-field';
  const openLbl = document.createElement('label');
  openLbl.className = 'wysiwyg-raw-label';
  openLbl.textContent = 'Opening';
  const openRaw = document.createElement('input');
  openRaw.type = 'text';
  openRaw.className = 'input input--mono';
  openRaw.dataset.ruleKey = openKey;
  openRaw.placeholder = '[b][color=#hex]';
  openField.appendChild(openLbl);
  openField.appendChild(openRaw);

  const closeField = document.createElement('div');
  closeField.className = 'wysiwyg-raw-field';
  const closeLbl = document.createElement('label');
  closeLbl.className = 'wysiwyg-raw-label';
  closeLbl.textContent = 'Closing';
  const closeRaw = document.createElement('input');
  closeRaw.type = 'text';
  closeRaw.className = 'input input--mono';
  closeRaw.dataset.ruleKey = closeKey;
  closeRaw.placeholder = '[/color][/b]';
  closeField.appendChild(closeLbl);
  closeField.appendChild(closeRaw);

  rawRow.appendChild(openField);
  rawRow.appendChild(closeField);
  advanced.appendChild(rawRow);
  section.appendChild(advanced);

  // ── Internal helpers ──────────────────────────────────────────
  function regenerate() {
    const { open, close } = buildBBCodeMarker(state);
    openRaw.value  = open;
    closeRaw.value = close;
    prevEl.innerHTML = convertBBCodeToHTML(open + `"${sample}"` + close) || `"${sample}"`;
    onRulesUpdate(openKey, open, closeKey, close);
  }

  // Initialise from existing rules
  openRaw.value  = rules[openKey]  ?? '';
  closeRaw.value = rules[closeKey] ?? '';
  prevEl.innerHTML = convertBBCodeToHTML(
    (rules[openKey] ?? '') + `"${sample}"` + (rules[closeKey] ?? '')
  ) || `"${sample}"`;

  // Toggle events
  boldBtn.addEventListener('click', () => {
    state.bold = !state.bold;
    boldBtn.classList.toggle('active', state.bold);
    regenerate();
  });

  italicBtn.addEventListener('click', () => {
    state.italic = !state.italic;
    italicBtn.classList.toggle('active', state.italic);
    regenerate();
  });

  colorToggle.addEventListener('click', () => {
    state.hasColor = !state.hasColor;
    colorToggle.classList.toggle('active', state.hasColor);
    if (state.hasColor && !state.color) state.color = '#ffffff';
    regenerate();
  });

  colorNative.addEventListener('input', () => {
    state.color = colorNative.value;
    hexIn.value = colorNative.value;
    colorDot.style.backgroundColor = colorNative.value;
    if (state.hasColor) regenerate();
  });

  hexIn.addEventListener('input', () => {
    const v = hexIn.value.trim();
    if (/^#[0-9a-fA-F]{6}$/i.test(v)) {
      state.color = v;
      colorNative.value = v;
      colorDot.style.backgroundColor = v;
      if (state.hasColor) regenerate();
    }
  });

  // Advanced raw → sync toggles bidirectionally
  const syncFromRaw = () => {
    const reparsed = parseBBCodeMarker(openRaw.value);
    state.bold     = reparsed.bold;
    state.italic   = reparsed.italic;
    state.hasColor = reparsed.hasColor;
    if (reparsed.hasColor) {
      state.color = reparsed.color;
      const safe = /^#[0-9a-fA-F]{6}$/i.test(reparsed.color) ? reparsed.color : '#ffffff';
      colorNative.value = safe;
      hexIn.value = reparsed.color;
      colorDot.style.backgroundColor = reparsed.color;
    }
    boldBtn.classList.toggle('active',     state.bold);
    italicBtn.classList.toggle('active',   state.italic);
    colorToggle.classList.toggle('active', state.hasColor);
    prevEl.innerHTML = convertBBCodeToHTML(
      openRaw.value + `"${sample}"` + closeRaw.value
    ) || `"${sample}"`;
    onRulesUpdate(openKey, openRaw.value, closeKey, closeRaw.value);
  };
  openRaw.addEventListener('input',  syncFromRaw);
  closeRaw.addEventListener('input', syncFromRaw);

  return section;
}

// ── withFeedback ──────────────────────────────────────────────────────────────

export async function withFeedback(button, messageEl, action, {
  loading    = 'Saving…',
  success    = null,
  btnSuccess = null,
  clearDelay = 3000,
} = {}) {
  const origText = button.textContent;
  button.disabled    = true;
  button.textContent = loading;

  if (messageEl) {
    messageEl.textContent = '';
    messageEl.classList.remove('feedback--success', 'feedback--error');
  }

  try {
    await action();

    button.disabled    = false;
    button.textContent = btnSuccess ?? origText;

    if (messageEl && success) {
      messageEl.textContent = success;
      messageEl.classList.add('feedback--success');
      if (clearDelay > 0) {
        const txt = success;
        setTimeout(() => {
          if (messageEl.textContent === txt) {
            messageEl.textContent = '';
            messageEl.classList.remove('feedback--success');
          }
        }, clearDelay);
      }
    }

  } catch (err) {
    button.disabled    = false;
    button.textContent = origText;

    if (messageEl) {
      messageEl.textContent = err?.message || 'Something went wrong.';
      messageEl.classList.add('feedback--error');
    }
  }
}
