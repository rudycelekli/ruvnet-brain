// tests/unit/ground-ruvnet-staleness-inline.test.mjs — H3: ground-ruvnet.sh's checkpoint-staleness
// threshold is an INLINE `node -e` literal (not a reference to scripts/loop-checkpoint.mjs — see
// that file's own comment and tests/unit/payload-self-contained.test.mjs for why: loop-checkpoint.mjs
// lives only at repo-root scripts/, never inside plugin/scripts/, so a real reference to it from a
// payload file resolves to nothing on every shipped install). scripts/loop-checkpoint.mjs's exported
// CHECKPOINT_STALE_MS is still the SOURCE OF TRUTH for the number; this test is the drift guard,
// same idiom as ruvnet-gate1-pattern.test.mjs's byte-identity check against ground-ruvnet.sh's Gate 1
// pattern, applied to a number instead of a regex string.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKPOINT_STALE_MS } from '../../scripts/loop-checkpoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GROUND_RUVNET = path.join(ROOT, 'plugin', 'scripts', 'ground-ruvnet.sh');

function extractInlineStaleMs() {
  const src = fs.readFileSync(GROUND_RUVNET, 'utf8');
  const m = /const STALE_MS = ([^;]+);/.exec(src);
  if (!m) return null;
  // The extracted text is a numeric literal expression from this repo's own trusted source
  // (e.g. "24 * 60 * 60 * 1000"), never external input.
  return Function(`"use strict"; return (${m[1]});`)();
}

describe('ground-ruvnet.sh\'s inline STALE_MS never drifts from loop-checkpoint.mjs\'s CHECKPOINT_STALE_MS', () => {
  it('extracts a real, non-trivial STALE_MS literal (or this test checks nothing)', () => {
    const inlineMs = extractInlineStaleMs();
    expect(inlineMs, 'could not find the inline STALE_MS literal in ground-ruvnet.sh — did it move or get rewritten?').not.toBeNull();
    expect(inlineMs).toBeGreaterThan(0);
  });

  it('is numerically equal to CHECKPOINT_STALE_MS (24h)', () => {
    expect(extractInlineStaleMs()).toBe(CHECKPOINT_STALE_MS);
  });

  it('never resolves a self-relative path to loop-checkpoint.mjs and invokes it (payload-self-contained; the model-facing prose mention of the CLI is fine)', () => {
    // tests/unit/payload-self-contained.test.mjs is the general-purpose guard for this invariant
    // across the whole payload; this is the narrow, H3-specific regression check for the exact bug
    // a first version of this fix shipped: resolving a path to loop-checkpoint.mjs relative to this
    // file's own directory and invoking it (`LOOP_CHECKPOINT=".../loop-checkpoint.mjs"` then
    // `node "$LOOP_CHECKPOINT"`). The AUTONOMOUS MODE banner's plain-text mention ("node
    // scripts/loop-checkpoint.mjs read") is prose shown to the model, not a resolved, invoked
    // reference, and must not trip this.
    const src = fs.readFileSync(GROUND_RUVNET, 'utf8');
    expect(src).not.toMatch(/LOOP_CHECKPOINT=/);
    expect(src).not.toMatch(/node\s+"\$LOOP_CHECKPOINT"/);
  });
});
