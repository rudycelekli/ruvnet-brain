// tests/unit/corpus-seed-ledger-fallback.test.mjs
//
// ADR-0091 D4. corpus-next-seed.mjs judges a published generation from small files before download,
// but the generation ledger lives only inside the archive. corpus-reconcile.mjs therefore checks the
// ledger schema right after extraction and exits 3 (SEED_LEDGER_INCOMPATIBLE_EXIT) having moved
// nothing. corpus-seed.yml must then re-run seed extraction ONCE from the committed bootstrap in the
// same job, loudly, and every later step must name the seed actually used.
//
// Like corpus-seed-bootstrap-exemption.test.mjs, this EXECUTES the block extracted from the workflow
// source (between its BEGIN/END markers) under `set -euo pipefail`, with `reconcile`, `gh`,
// `sha256sum` and `stat` stubbed as shell functions. Pattern-matching the YAML would pass a block
// that reads correctly and branches wrongly.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_LEDGER_INCOMPATIBLE_EXIT } from '../../scripts/corpus-reconcile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'corpus-seed.yml');
const bootstrap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corpus-seed.json'), 'utf8'));
const GENERATION = { tag: `corpus-sha256-${'7'.repeat(64)}`, sha256: '7'.repeat(64), bytes: 600000000 };

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function extractBlock() {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  const match = source.match(/^(\s*)# BEGIN seed-ledger-fallback[^\n]*\n([\s\S]*?)^\1# END seed-ledger-fallback$/m);
  if (!match) throw new Error('the seed-ledger-fallback block is gone from corpus-seed.yml');
  const indent = match[1];
  return match[2].split('\n').map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
}

/**
 * exits: the statuses successive `reconcile` calls return. digestOk: whether the bootstrap download
 * verifies. Returns every recorded call, the GITHUB_ENV file, and the block's own exit status.
 */
function runBlock({ origin, exits, digestOk = true }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-ledger-fallback-'));
  dirs.push(work);
  fs.mkdirSync(path.join(work, 'data'));
  fs.copyFileSync(path.join(ROOT, 'data', 'corpus-seed.json'), path.join(work, 'data', 'corpus-seed.json'));
  const log = path.join(work, 'calls.log');
  const githubEnv = path.join(work, 'github-env');
  fs.writeFileSync(githubEnv, '');
  const seed = origin === 'committed-bootstrap' ? bootstrap : GENERATION;
  const prelude = `
set -euo pipefail
EXITS=(${exits.join(' ')})
N=0
reconcile() { echo "reconcile archive=$1 tag=$SEED_TAG sha=$SEED_SHA256 origin=$SEED_ORIGIN" >> "$LOG"; local s=\${EXITS[$N]}; N=$((N+1)); return "$s"; }
gh() { echo "gh $*" >> "$LOG"; }
sha256sum() { echo "sha256sum $(cat)" >> "$LOG"; return ${digestOk ? 0 : 1}; }
stat() { echo "$BOOTSTRAP_BYTES"; }
`;
  const r = spawnSync('bash', ['-c', `${prelude}\n${extractBlock()}`], {
    cwd: work,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      LOG: log,
      GITHUB_ENV: githubEnv,
      RUNNER_TEMP: path.join(work, 'runner-temp'),
      GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
      BOOTSTRAP_BYTES: String(bootstrap.bytes),
      SEED_TAG: seed.tag,
      SEED_SHA256: seed.sha256,
      SEED_BYTES: String(seed.bytes),
      SEED_ORIGIN: origin,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, calls, env: fs.readFileSync(githubEnv, 'utf8') };
}

describe('corpus-seed.yml re-runs once from the bootstrap on an unconsumable seed ledger (ADR-0091 D4)', () => {
  it('the workflow and corpus-reconcile agree on the exit code', () => {
    expect(SEED_LEDGER_INCOMPATIBLE_EXIT).toBe(3);
    expect(extractBlock()).toContain('if [ "$status" = 3 ]');
  });

  it('GREEN: a generation seed with an incompatible ledger falls back to the bootstrap and succeeds', () => {
    const { status, out, calls, env } = runBlock({ origin: 'runtime-generation', exits: [3, 0] });
    expect(status).toBe(0);
    expect(out).toMatch(/::warning title=Corpus seed fallback::seed corpus-sha256-7{64} has a generation ledger this runtime cannot read/);
    const reconciles = calls.filter((call) => call.startsWith('reconcile'));
    expect(reconciles).toHaveLength(2);
    expect(reconciles[0]).toMatch(new RegExp(`corpus-seed-download/ruvnet-brain\\.zip tag=${GENERATION.tag}`));
    expect(reconciles[1]).toMatch(new RegExp(`corpus-bootstrap-download/ruvnet-brain\\.zip tag=${bootstrap.tag} sha=${bootstrap.sha256} origin=committed-bootstrap-after-ledger-fallback`));
    const ghCalls = calls.filter((call) => call.startsWith('gh '));
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]).toMatch(new RegExp(`^gh release download ${bootstrap.tag} --repo stuinfla/ruvnet-brain --pattern ruvnet-brain\\.zip --dir .*/corpus-bootstrap-download$`));
    // The bootstrap bytes were verified BEFORE the retry reconciled them.
    expect(calls.findIndex((c) => c.startsWith('sha256sum'))).toBeLessThan(calls.lastIndexOf(reconciles[1]));
    expect(calls.find((c) => c.startsWith('sha256sum'))).toContain(`${bootstrap.sha256}  `);
    // Later steps (the seal, the no-change comparison) see the seed actually used.
    expect(env).toContain(`SEED_TAG=${bootstrap.tag}\n`);
    expect(env).toContain(`SEED_SHA256=${bootstrap.sha256}\n`);
    expect(env).toContain(`SEED_BYTES=${bootstrap.bytes}\n`);
    expect(env).toContain('SEED_ORIGIN=committed-bootstrap-after-ledger-fallback\n');
  });

  it('retries only ONCE: a bootstrap that is also unconsumable fails the job with exit 3', () => {
    const { status, calls } = runBlock({ origin: 'runtime-generation', exits: [3, 3] });
    expect(status).toBe(3);
    expect(calls.filter((call) => call.startsWith('reconcile'))).toHaveLength(2);
  });

  it('never "falls back" from the bootstrap to itself', () => {
    const { status, out, calls, env } = runBlock({ origin: 'committed-bootstrap', exits: [3] });
    expect(status).toBe(3);
    expect(out).not.toMatch(/::warning/);
    expect(calls.filter((call) => call.startsWith('reconcile'))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
    expect(env).toBe('');
  });

  it('any other failure is NOT a fallback trigger (exit 1 stays exit 1, no retry)', () => {
    const { status, calls } = runBlock({ origin: 'runtime-generation', exits: [1] });
    expect(status).toBe(1);
    expect(calls.filter((call) => call.startsWith('reconcile'))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith('gh '))).toBe(false);
  });

  it('a compatible seed runs once with no fallback', () => {
    const { status, calls, env } = runBlock({ origin: 'runtime-generation', exits: [0] });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(env).toBe('');
  });

  it('a bootstrap download that fails verification stops the job before any retry', () => {
    const { status, calls } = runBlock({ origin: 'runtime-generation', exits: [3, 0], digestOk: false });
    expect(status).not.toBe(0);
    expect(calls.filter((call) => call.startsWith('reconcile'))).toHaveLength(1);
  });
});
