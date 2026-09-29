import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareKnowledgeInputs, digest, fromCoverage, fromSeed, normalize, runtimeEmbedding,
} from '../../scripts/knowledge-input-digest.mjs';
import { materializePublicInputs } from '../../scripts/public-inputs.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-input-')); dirs.push(dir); return dir; };
const hex = (c, n = 40) => c.repeat(n);

const base = () => ({
  sourceObservationSha256: hex('0', 64),
  repositories: [{ store: 'alpha', sha: hex('a') }, { store: 'beta', sha: hex('b') }],
  gists: [{ id: 'g1', sha: hex('1') }, { id: 'g2', sha: hex('2') }],
  publicInputs: {
    files: [{ path: 'alpha-primer.md', sha256: hex('c', 64), bytes: 10 }, { path: 'l2/x.md', sha256: hex('d', 64), bytes: 5 }],
    ownership: { x: 'alpha', y: 'beta' },
  },
  embedding: ['Xenova/bge-base-en-v1.5:768'],
});

describe('knowledge-input digest', () => {
  it('is a 64-hex digest that ignores the ORDER of every list and map', () => {
    const a = base();
    const b = base();
    b.repositories.reverse();
    b.gists.reverse();
    b.publicInputs.files.reverse();
    b.publicInputs.ownership = { y: 'beta', x: 'alpha' };
    b.embedding = ['Xenova/bge-base-en-v1.5:768', 'Xenova/bge-base-en-v1.5:768'];
    b.repositories[0].sha = b.repositories[0].sha.toUpperCase();
    expect(digest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(digest(b)).toBe(digest(a));
  });

  it.each([
    ['one repository commit', (c) => { c.repositories[1].sha = hex('e'); }],
    ['a repository added', (c) => { c.repositories.push({ store: 'gamma', sha: hex('f') }); }],
    ['a repository dropped', (c) => { c.repositories.pop(); }],
    ['one gist version', (c) => { c.gists[0].sha = hex('9'); }],
    ['one public input file digest', (c) => { c.publicInputs.files[1].sha256 = hex('e', 64); }],
    ['one public input file size', (c) => { c.publicInputs.files[0].bytes = 11; }],
    ['topic ownership', (c) => { c.publicInputs.ownership.x = 'beta'; }],
    ['the embedding model', (c) => { c.embedding = ['Xenova/bge-small-en-v1.5:384']; }],
    ['the sealed source observation', (c) => { c.sourceObservationSha256 = hex('1', 64); }],
  ])('changes when %s changes, and only then', (_name, mutate) => {
    const changed = base();
    mutate(changed);
    expect(digest(base())).toBe(digest(base()));
    expect(digest(changed)).not.toBe(digest(base()));
  });

  it('refuses malformed components instead of digesting them', () => {
    expect(() => normalize({ ...base(), sourceObservationSha256: 'nope' })).toThrow(/sourceObservationSha256/);
    expect(() => normalize({ ...base(), repositories: [{ store: 'a', sha: hex('a') }, { store: 'A', sha: hex('b') }] }))
      .toThrow(/duplicate repository store/);
    expect(() => normalize({ ...base(), embedding: [] })).toThrow(/no embedding model/);
    expect(() => normalize({ ...base(), publicInputs: { files: [{ path: 'x', sha256: 'z', bytes: 1 }] } })).toThrow(/malformed/);
  });

  it('a seed without evidence is never "unchanged"', () => {
    expect(fromSeed(temp())).toBeNull();
    const verdict = compareKnowledgeInputs({ seed: null, tonight: base() });
    expect(verdict).toMatchObject({ unchanged: false, seedSha256: null });
    expect(compareKnowledgeInputs({ seed: base(), tonight: base() }).unchanged).toBe(true);
  });

  it('the runtime embedding comes from the forge fingerprint of the runtime tree', async () => {
    expect(await runtimeEmbedding(ROOT)).toEqual(['Xenova/bge-base-en-v1.5:768']);
  });
});

// The two sides of the comparison are computed from DIFFERENT evidence (the seed's sealed files vs
// tonight's coverage and checkout). This proves they agree when nothing changed -- through the REAL
// public-input selector on this checkout -- and disagree when the seed carried a store.
describe('seed side and tonight side agree on an unchanged world', () => {
  const OBS = hex('7', 64);
  const coverage = ({ carried = false } = {}) => ({
    kind: 'ruvnet-brain-corpus-coverage', sourceObservationSha256: OBS,
    rows: [
      { kind: 'repository', disposition: 'eligible', key: 'repo:ruvnet/alpha', upstream: { sha: hex('a') },
        artifact: { store: 'alpha', sourceCommit: carried ? hex('9') : hex('a') }, status: carried ? 'STALE' : 'CURRENT' },
      { kind: 'repository', disposition: 'fork:no-original-content', key: 'repo:ruvnet/fork', upstream: { sha: hex('f') },
        artifact: { store: 'fork', sourceCommit: null }, status: 'INELIGIBLE' },
      { kind: 'gist', disposition: 'eligible', key: 'gist:g1', upstream: { sha: hex('1') },
        artifact: { store: 'ruv-gists', sourceCommit: hex('1') }, status: 'CURRENT' },
    ],
  });
  const seedTree = (seedCoverage) => {
    const assets = temp();
    materializePublicInputs({ builderRoot: ROOT, outDir: assets });
    fs.writeFileSync(path.join(assets, 'CORPUS-COVERAGE.json'), JSON.stringify(seedCoverage));
    fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify({ schemaVersion: 2, stores: {
      alpha: { model: 'Xenova/bge-base-en-v1.5', dimensions: 768 }, 'ruv-gists': { model: 'Xenova/bge-base-en-v1.5', dimensions: 768 },
    } }));
    return assets;
  };

  it('unchanged: identical observation, commits, prose and model', async () => {
    const seed = fromSeed(seedTree(coverage()));
    const tonight = await fromCoverage(coverage(), ROOT);
    expect(seed.publicInputs.files.length).toBeGreaterThan(10);
    expect(tonight.repositories).toEqual([{ store: 'alpha', sha: hex('a') }]);
    expect(compareKnowledgeInputs({ seed, tonight })).toMatchObject({ unchanged: true });
  });

  it('changed: the seed CARRIED a store at old bytes, so tonight must build even with the same observation', async () => {
    const seed = fromSeed(seedTree(coverage({ carried: true })));
    const tonight = await fromCoverage(coverage(), ROOT);
    expect(compareKnowledgeInputs({ seed, tonight }).unchanged).toBe(false);
  });

  it('changed: one public input file differs from what the seed shipped', async () => {
    const assets = seedTree(coverage());
    const selection = JSON.parse(fs.readFileSync(path.join(assets, 'PUBLIC-INPUT-SELECTION.json'), 'utf8'));
    selection.files[0].sha256 = hex('e', 64);
    fs.writeFileSync(path.join(assets, 'PUBLIC-INPUT-SELECTION.json'), JSON.stringify(selection));
    const tonight = await fromCoverage(coverage(), ROOT);
    expect(compareKnowledgeInputs({ seed: fromSeed(assets), tonight }).unchanged).toBe(false);
  });
});
