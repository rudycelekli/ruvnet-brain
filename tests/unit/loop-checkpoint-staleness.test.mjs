// tests/unit/loop-checkpoint-staleness.test.mjs — H3: the single source for "is this checkpoint too
// old to trust", used by ground-ruvnet.sh's session injection (via `node loop-checkpoint.mjs stale`)
// and by scripts/single-source-check.mjs's E1 audit (via a direct import). See
// tests/integration/autonomy-loop.test.mjs for the end-to-end hook-level proof; this file is the
// pure-function and CLI-verb level proof.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECKPOINT_STALE_MS, checkpointStaleness, writeCheckpoint } from '../../scripts/loop-checkpoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'loop-checkpoint.mjs');

describe('checkpointStaleness — pure decision logic', () => {
  it('a checkpoint updated seconds ago is fresh', () => {
    const r = checkpointStaleness({ updatedAt: new Date().toISOString() });
    expect(r.known).toBe(true);
    expect(r.stale).toBe(false);
  });

  it('a checkpoint updated 3 days ago is stale, and reports ~3 age days', () => {
    const r = checkpointStaleness({ updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(r.known).toBe(true);
    expect(r.stale).toBe(true);
    expect(Math.floor(r.ageDays)).toBe(3);
  });

  it('is UNKNOWN (never fresh, never stale) for a missing or unparseable updatedAt', () => {
    for (const cp of [null, undefined, {}, { updatedAt: 'not a date' }, { updatedAt: 123 }]) {
      const r = checkpointStaleness(cp);
      expect(r.known, JSON.stringify(cp)).toBe(false);
      expect(r.stale, JSON.stringify(cp)).toBe(false);
    }
  });

  it('the threshold is exactly 24 hours', () => {
    expect(CHECKPOINT_STALE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('boundary: exactly at the threshold counts as stale (>=, not >)', () => {
    const now = 10_000_000_000;
    const r = checkpointStaleness({ updatedAt: new Date(now - CHECKPOINT_STALE_MS).toISOString() }, now);
    expect(r.stale).toBe(true);
  });
});

describe('loop-checkpoint.mjs stale CLI verb — exit-code protocol', () => {
  function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cp-stale-')); }
  function runStale(dir) {
    const r = spawnSync(process.execPath, [CLI, 'stale', '--dir', dir], { encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, stdout: r.stdout.trim() };
  }

  it('exit 2 (unknown) when there is no checkpoint at all', () => {
    const r = runStale(tmpDir());
    expect(r.status).toBe(2);
  });

  it('exit 0 (fresh) right after a real write', () => {
    const dir = tmpDir();
    writeCheckpoint({ iteration: 1, next: 'x' }, path.join(dir, '.ruvnet-brain', 'checkpoint.json'));
    const r = runStale(dir);
    expect(r.status).toBe(0);
  });

  it('exit 1 (stale) with the whole age in days on stdout, for a 5-day-old checkpoint', () => {
    const dir = tmpDir();
    const file = path.join(dir, '.ruvnet-brain', 'checkpoint.json');
    writeCheckpoint({ iteration: 1, next: 'x' }, file);
    const cp = JSON.parse(fs.readFileSync(file, 'utf8'));
    cp.updatedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(cp));
    const r = runStale(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('5'); // sync-version-ignore: the fixture itself backdates by exactly 5 days (line above) — this is not a restated fact, it's the test's own controlled input
  });
});
