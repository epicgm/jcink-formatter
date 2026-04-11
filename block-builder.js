/**
 * block-builder.js — Reusable inline block builder component
 *
 * Usage:
 *   import { mountBlockBuilder } from './block-builder.js';
 *   mountBlockBuilder(containerEl, { onSave: async ({ trigger, replacement_html }) => { ... } });
 *
 * Renders a trigger input, side-by-side HTML editor + live preview,
 * and a "Save to my library" button inside `container`.
 * Calls `onSave` with the block data and resets the form on success.
 */

export function mountBlockBuilder(container, { onSave } = {}) {
  container.innerHTML = `
    <div class="bb-root">
      <div class="bb-trigger-row field">
        <label class="field-label" for="bb-trigger-input">Trigger</label>
        <div class="bb-trigger-wrap">
          <span class="bb-affix">&#58;&#58;</span>
          <input
            type="text"
            id="bb-trigger-input"
            class="input bb-trigger"
            placeholder="e.g. header"
            autocomplete="off"
            maxlength="80"
          />
          <span class="bb-affix">&#58;&#58;</span>
        </div>
      </div>
      <div class="bb-split">
        <div class="field bb-html-field">
          <label class="field-label" for="bb-html-input">Replacement HTML</label>
          <textarea
            id="bb-html-input"
            class="textarea-input textarea--mono bb-html"
            rows="7"
            placeholder='&lt;div class="post-header"&gt;…&lt;/div&gt;'
            spellcheck="false"
          ></textarea>
        </div>
        <div class="field bb-preview-field">
          <label class="field-label">Preview</label>
          <div class="bb-preview output-area">
            <span class="output-placeholder">Preview appears here…</span>
          </div>
        </div>
      </div>
      <div class="bb-footer">
        <p class="bb-status" aria-live="polite"></p>
        <button type="button" class="btn-primary bb-save">Save to my library</button>
      </div>
    </div>
  `;

  const triggerIn = container.querySelector('.bb-trigger');
  const htmlIn    = container.querySelector('.bb-html');
  const preview   = container.querySelector('.bb-preview');
  const saveBtn   = container.querySelector('.bb-save');
  const status    = container.querySelector('.bb-status');

  // Live preview — renders user's own HTML (intentional, no sanitisation needed)
  htmlIn.addEventListener('input', () => {
    preview.innerHTML = htmlIn.value.trim()
      || '<span class="output-placeholder">Preview appears here…</span>';
  });

  saveBtn.addEventListener('click', async () => {
    const trigger = triggerIn.value.trim();
    const html    = htmlIn.value.trim();

    if (!trigger) {
      triggerIn.focus();
      flash(status, '⚠ Enter a trigger name.', 'status--warn');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    try {
      await onSave({ trigger, replacement_html: html || null });
      triggerIn.value = '';
      htmlIn.value    = '';
      preview.innerHTML = '<span class="output-placeholder">Preview appears here…</span>';
      flash(status, `✓ Saved ::${trigger}:: to your library.`, 'status--ok');
    } catch (err) {
      flash(status, `Error: ${err.message}`, 'status--warn');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to my library';
    }
  });
}

function flash(el, msg, cls) {
  el.textContent = msg;
  el.className   = `bb-status ${cls}`;
  setTimeout(() => {
    el.textContent = '';
    el.className   = 'bb-status';
  }, 4000);
}
