import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  acquireCorpusGeneration, acquireSealedGeneration, main, reconcileAndPrepareCorpusCandidate,
} from '../../scripts/corpus-reconcile.mjs';
import { materializePublicInputs } from '../../scripts/public-inputs.mjs';

// The pre-build no-change decision (2026-09-29 nightly redesign). The old test compared the NEW
// archive's digest with the seed's, which a rebuild can never reproduce, so a quiet night still paid
// the full build. The decision now happens right after the one sealed observation, before gist
// preflight, clones, embedding or aggregates -- so "unchanged" must mean execute is NEVER called.

const ROOT = path.resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-no-change-')); dirs.push(dir); return dir; };
const hex = (c, n = 40) => c.repeat(n);
const OBS = hex('7', 64);

function spies() {
  const calls = { build: 0, execute: 0, prune: 0, rebuild: 0, preflight: 0 };
  return {
    calls,
    observe: async () => ({ observationSha256: OBS }),
    build: async () => { calls.build += 1; return { schemaVersion: 1, coverageGeneration: 'g', rows: [] }; },
    readLedger: () => ({ stores: {} }),
    execute: async () => { calls.execute += 1; throw new Error('EXECUTED'); },
    prune: async () => { calls.prune += 1; return { pruned: [] }; },
    rebuild: async () => { calls.rebuild += 1; return { rebuilt: [] }; },
    preflight: async () => { calls.preflight += 1; return null; },
  };
}

describe('acquireSealedGeneration stops right after observation when the inputs are unchanged', () => {
  it('unchanged: returns noChange and never builds, fetches gists, clones, embeds or rebuilds', async () => {
    const s = spies();
    let seen = null;
    const result = await acquireSealedGeneration({ ...s,
      unchanged: async (observation) => { seen = observation; return { unchanged: true, seedSha256: hex('5', 64), tonightSha256: hex('5', 64) }; } });
    expect(seen).toEqual({ observationSha256: OBS });
    expect(result).toMatchObject({ noChange: true, observation: { observationSha256: OBS }, attempts: [],
      knowledgeInput: { unchanged: true, tonightSha256: hex('5', 64) } });
    expect(s.calls).toEqual({ build: 0, execute: 0, prune: 0, rebuild: 0, preflight: 0 });
  });

  it('changed: the generation proceeds exactly as before (preflight, then execute)', async () => {
    const s = spies();
    await expect(acquireSealedGeneration({ ...s, unchanged: async () => ({ unchanged: false }) })).rejects.toThrow('EXECUTED');
    expect(s.calls).toMatchObject({ preflight: 1, build: 1, execute: 1 });
  });
});

// The DEFAULT wiring in acquireCorpusGeneration: the seed evidence is read from the extracted seed
// assets, tonight's from the coverage `build` measures and the REAL public-input selector.
describe('acquireCorpusGeneration decides no-change from the seed it extracted', () => {
  const coverage = (sha = hex('a')) => ({
    schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', coverageGeneration: 'g', sourceObservationSha256: OBS,
    rows: [{ kind: 'repository', disposition: 'eligible', key: 'repo:ruvnet/alpha', url: 'https://github.com/ruvnet/alpha', upstream: { sha },
      artifact: { store: 'alpha', sourceCommit: hex('a') }, status: 'CURRENT' }],
  });
  const seedAssets = () => {
    const assets = path.join(temp(), 'assets');
    materializePublicInputs({ builderRoot: ROOT, outDir: assets });
    fs.writeFileSync(path.join(assets, 'CORPUS-COVERAGE.json'), JSON.stringify(coverage()));
    fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify({ schemaVersion: 2,
      stores: { alpha: { model: 'Xenova/bge-base-en-v1.5', dimensions: 768 } } }));
    return assets;
  };
  const run = (assets, tonight) => {
    const s = spies();
    const promise = acquireCorpusGeneration({ assetsDir: assets, workspaceDir: path.join(temp(), 'ws'), root: ROOT,
      observe: s.observe, build: async () => { s.calls.build += 1; return tonight; }, readLedger: s.readLedger,
      execute: s.execute, prune: s.prune, rebuild: s.rebuild, preflight: s.preflight });
    return { s, promise };
  };

  it('seed == tonight: noChange, and execute/preflight are never reached', async () => {
    const { s, promise } = run(seedAssets(), coverage());
    const result = await promise;
    expect(result.noChange).toBe(true);
    expect(result.knowledgeInput.seedSha256).toBe(result.knowledgeInput.tonightSha256);
    expect(s.calls).toMatchObject({ execute: 0, preflight: 0, rebuild: 0 });
  });

  it('one upstream commit moved: builds (execute is reached)', async () => {
    const { s, promise } = run(seedAssets(), coverage(hex('b')));
    await expect(promise).rejects.toThrow('EXECUTED');
    expect(s.calls.execute).toBe(1);
  });

  it('a seed with no knowledge-input evidence (the pre-contract bootstrap) always builds', async () => {
    const bare = path.join(temp(), 'assets');
    fs.mkdirSync(bare);
    const { s, promise } = run(bare, coverage());
    await expect(promise).rejects.toThrow('EXECUTED');
    expect(s.calls.execute).toBe(1);
  });
});

describe('reconcileAndPrepareCorpusCandidate and main() carry no-change to the workflow', () => {
  it('a no-change reconciliation never normalizes or prepares a candidate', async () => {
    let prepared = 0;
    const result = await reconcileAndPrepareCorpusCandidate({ assetsDir: temp(), workspaceDir: temp(), builderSha: hex('c'),
      reconcile: async () => ({ noChange: true, observation: { observationSha256: OBS }, attempts: [] }),
      normalizeUpdaters: () => { prepared += 1; return {}; }, prepare: () => { prepared += 1; return {}; } });
    expect(result).toMatchObject({ noChange: true, candidate: null });
    expect(prepared).toBe(0);
  });

  const makeRoot = () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'PRIVATE-STORES.json'), '{"privateStores":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'external-sources.json'), '{"sources":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'no-corpus-repos.json'), '{}');
    return root;
  };
  const makeSeed = () => {
    const staging = path.join(temp(), 'ruvnet-brain');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'RVF-GENERATIONS.json'), '{"schemaVersion":2,"kind":"ruvnet-brain-runtime-generation-ledger","stores":{}}');
    const zip = path.join(path.dirname(staging), 'seed.zip');
    execFileSync('zip', ['-qr', zip, 'ruvnet-brain'], { cwd: path.dirname(staging) });
    return { zip, digest: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') };
  };
  const invoke = async ({ tag = null, extra = [], outcome }) => {
    const seed = makeSeed();
    const out = [];
    const noChangeOut = path.join(temp(), 'no-change.json');
    const code = await main(['--root', makeRoot(), '--seed-archive', seed.zip, '--seed-tag', tag || `corpus-sha256-${seed.digest}`,
      '--seed-sha256', seed.digest, '--assets', path.join(temp(), 'assets'), '--workspace', path.join(temp(), 'clones'),
      '--builder-sha', hex('c'), '--no-change-out', noChangeOut, ...extra], {
      reconcileAndPrepare: async () => outcome,
      stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} },
    });
    return { code, out: JSON.parse(out.join('')), noChange: fs.existsSync(noChangeOut) ? JSON.parse(fs.readFileSync(noChangeOut, 'utf8')) : null };
  };

  it('--no-change-out records a no-change night (exit 0, nothing sealed)', async () => {
    const result = await invoke({ outcome: { noChange: true, candidate: null,
      reconciliation: { noChange: true, observation: { observationSha256: OBS }, attempts: [],
        knowledgeInput: { unchanged: true, seedSha256: hex('5', 64), tonightSha256: hex('5', 64) } } } });
    expect(result.code).toBe(0);
    expect(result.noChange).toEqual({ noChange: true, knowledgeInputSha256: hex('5', 64), observationSha256: OBS });
    expect(result.out).toMatchObject({ ok: true, noChange: true });
  });

  it('--no-change-out records a changed night too, so the workflow never guesses', async () => {
    const degraded = { carried: [], missing: [] };
    const result = await invoke({ outcome: { reconciliation: { observation: { observationSha256: OBS }, attempts: [], degraded },
      candidate: { bundleFile: '/x.zip', degraded } } });
    expect(result.code).toBe(0);
    expect(result.noChange).toEqual({ noChange: false, knowledgeInputSha256: null, observationSha256: OBS });
  });

  // corpus-reconcile.mjs read `--allow-pinned-seed-tag` from process.argv instead of the argv main()
  // was handed, so an injected invocation could never seed from the pinned bootstrap tag.
  it('--allow-pinned-seed-tag is read from the argv main() was given, and only from it', async () => {
    expect(process.argv).not.toContain('--allow-pinned-seed-tag');
    const outcome = { noChange: true, candidate: null, reconciliation: { noChange: true, observation: {}, attempts: [] } };
    const pinned = await invoke({ tag: 'v4.2.1-dev', extra: ['--allow-pinned-seed-tag'], outcome }); // sync-version-ignore: bootstrap seed tag
    expect(pinned.code).toBe(0);
    await expect(invoke({ tag: 'v4.2.1-dev', outcome })).rejects.toThrow(/bootstrap requires the exact digest-derived tag/); // sync-version-ignore: bootstrap seed tag
  });
});
