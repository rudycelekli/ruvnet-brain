// tests/unit/claude-settings-note-honesty.test.mjs — H7: .claude/settings.json's `_note` field
// claimed "no automatic shell-command interceptor" exists for this project, which is false: the
// ruvnet-brain plugin layer supplies exactly that — decision-gate's write gate (ADR-067) and every
// lifecycle hook registered in plugin/hooks/hooks.json (session-start, unprompted-speech,
// ground-ruvnet, capacity-aware-parallel-work, grounding-turn-mark, grounding-stamp,
// continuation-gate, session-snapshot, grounding-turn-gate). The note's only TRUE claim was that
// THIS FILE's own `hooks` object is empty — that part stays; the false "nothing automatic exists at
// all" implication is what H7 fixes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTINGS = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));

describe('.claude/settings.json _note is truthful about automatic interceptors (H7)', () => {
  it('this project\'s own hooks object really is empty — the note\'s one true pre-fix claim, preserved', () => {
    expect(SETTINGS.hooks).toEqual({});
  });

  it('does NOT claim no automatic interceptor exists anywhere (RED on pre-fix code)', () => {
    expect(SETTINGS._note).not.toMatch(/never by an automatic (shell-command )?interceptor/i);
    expect(SETTINGS._note).not.toMatch(/\bno automatic (shell-command )?interceptor/i);
  });

  it('names the real source of automation: decision-gate and plugin/hooks/hooks.json', () => {
    expect(SETTINGS._note).toMatch(/decision-gate/);
    expect(SETTINGS._note).toMatch(/plugin\/hooks\/hooks\.json/);
  });

  it('is exactly ONE sentence, as the fix requires', () => {
    // A sentence-ending punctuation mark is one followed by whitespace or end-of-string — this
    // correctly ignores the embedded period inside the literal filename "hooks.json".
    const sentenceEnders = (SETTINGS._note.match(/[.!?](?:\s|$)/g) || []).length;
    expect(sentenceEnders).toBe(1);
  });
});
