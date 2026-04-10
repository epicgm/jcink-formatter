/**
 * Parser Test Agent — runs 5 canonical strings through formatPost()
 * and prints PASS / FAIL for each.
 *
 * Usage:  node parser.test.mjs
 */

import { formatPost } from './parser.js';

const D_OPEN  = '<span class="dialogue">';
const D_CLOSE = '</span>';
const T_OPEN  = '<span class="thought">';
const T_CLOSE = '</span>';

const TESTS = [
  {
    id:    1,
    name:  'Simple straight quotes',
    input: '"Hello there"',
    check(out) {
      return out === `${D_OPEN}"Hello there"${D_CLOSE}`;
    },
    expect: `dialogue span wraps "Hello there"`,
  },
  {
    id:    2,
    name:  'Apostrophe inside dialogue',
    input: `"I don't know what happened"`,
    check(out) {
      return out === `${D_OPEN}"I don't know what happened"${D_CLOSE}`;
    },
    expect: `apostrophe in don't preserved; full string wrapped as dialogue`,
  },
  {
    id:    3,
    name:  'Possessive not treated as thought',
    input: `Helena's eyes narrowed slowly`,
    check(out) {
      return out === `Helena's eyes narrowed slowly`;
    },
    expect: `output unchanged — Helena's must not produce a thought span`,
  },
  {
    id:    4,
    name:  'Curly double quotes',
    input: '\u201CHello there\u201D',
    check(out) {
      return out === `${D_OPEN}\u201CHello there\u201D${D_CLOSE}`;
    },
    expect: `curly " " quotes wrapped as dialogue`,
  },
  {
    id:    5,
    name:  'Mixed: dialogue + thought + possessive',
    input: `She narrowed her eyes. "I don't know." 'Suspicious.' Helena's instincts screamed.`,
    check(out) {
      const hasDialogue     = out.includes(`${D_OPEN}"I don't know."${D_CLOSE}`);
      const hasThought      = out.includes(`${T_OPEN}'Suspicious.'${T_CLOSE}`);
      const possessiveSafe  = out.includes(`Helena's instincts screamed.`);
      const noSpanInHelena  = !out.includes(`Helena${T_OPEN}`);
      return hasDialogue && hasThought && possessiveSafe && noSpanInHelena;
    },
    expect: `dialogue + thought wrapped; Helena's possessive unchanged`,
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

console.log('── Parser Test Agent ─────────────────────────────────');

for (const t of TESTS) {
  const out = formatPost(t.input);
  const ok  = t.check(out);

  if (ok) {
    passed++;
    console.log(`[PASS] Test ${t.id}: ${t.name}`);
  } else {
    failed++;
    console.log(`[FAIL] Test ${t.id}: ${t.name}`);
    console.log(`       Expected : ${t.expect}`);
    console.log(`       Got      : ${out}`);
  }
}

console.log('──────────────────────────────────────────────────────');
console.log(`Result: ${passed}/5 passed  |  ${failed}/5 failed`);

if (failed > 0) process.exit(1);
