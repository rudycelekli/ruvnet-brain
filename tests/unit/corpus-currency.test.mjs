// tests/unit/corpus-currency.test.mjs — ADR-0091 D7.1: manifest.json's `corpus` block.
//
// No single `contentAsOf` date exists for a mixed current/carried corpus (0.1.0's max-builtUtc read
// "today" every round), so the manifest reports the observation time, counts by status, the fixture
// repositories RETIRED by that observation, and the oldest carried store -- with every unknown date
// left null, never estimated. Proven on the pure function AND through the real assembler.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENCY_BASIS, corpusCurrencyBlock } from '../../scripts/corpus-currency.mjs';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const IDENTITY = { version: '7.7.7-fixture', sourceSnapshot: 'a'.repeat(40) };

const repo = (store, overrides = {}) => ({ key: `repo:ruvnet/${store}`, kind: 'repository', name: store, disposition: 'eligible',
  status: 'CURRENT', upstream: { sha: 'c'.repeat(40) }, artifact: { store }, ...overrides });
const carried = (store, carriedCommittedAt) => repo(store, { status: 'STALE',
  carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: store[0].repeat(40), missedUpstream: 'c'.repeat(40), attempts: 1, carriedCommittedAt } });

const coverage = (rows) => ({ observedAt: '2026-09-27T08:00:00Z', rows,
  enumerationReceipt: { terminal: true, duplicateKeys: 0, repositories: { expected: rows.filter((row) => row.kind === 'repository').length } } });

describe('corpusCurrencyBlock (pure)', () => {
  const rows = [
    repo('alpha'), repo('beta'),
    carried('gamma', '2026-08-01T00:00:00Z'), carried('delta', '2026-07-01T00:00:00Z'),
    repo('epsilon', { status: 'MISSING', failure: { reason: 'transient: clone', attempts: 2 } }),
    repo('zeta', { status: 'UNVERIFIED' }),
    repo('forked', { disposition: 'fork:no-original-content', status: 'INELIGIBLE' }), // not eligible: not counted
    { key: 'gist:1', kind: 'gist', disposition: 'eligible', status: 'CURRENT', artifact: { store: 'ruv-gists' } }, // not a repository
  ];

  it('counts eligible repositories by status, retired fixture repos via the shared rule, and dates the oldest carried store', () => {
    const block = corpusCurrencyBlock({ coverage: coverage(rows), basis: CURRENCY_BASIS.SEALED, generationTag: 'corpus-sha256-x',
      fixtureStores: ['alpha', 'gamma', 'gone-upstream'] });
    expect(block).toEqual({
      basis: 'sealed-observation',
      observedAt: '2026-09-27T08:00:00Z',
      generationTag: 'corpus-sha256-x',
      counts: { eligible: 6, current: 2, stale: 2, missing: 1, unverified: 1, retired: 1 },
      oldestCarried: { store: 'delta', sourceCommit: 'd'.repeat(40), committedAt: '2026-07-01T00:00:00Z' },
    });
  });

  it('an UNDATED carried store makes the oldest unknowable: it is reported with committedAt null, never estimated', () => {
    const block = corpusCurrencyBlock({ coverage: coverage([...rows, carried('eta', null)]), basis: CURRENCY_BASIS.SEALED, fixtureStores: [] });
    expect(block.oldestCarried).toEqual({ store: 'eta', sourceCommit: 'e'.repeat(40), committedAt: null });
  });

  it('nothing carried -> oldestCarried null; no fixture -> retired null (unknown is not zero)', () => {
    const block = corpusCurrencyBlock({ coverage: coverage([repo('alpha')]), basis: CURRENCY_BASIS.SEALED });
    expect(block.oldestCarried).toBeNull();
    expect(block.counts.retired).toBeNull();
  });

  it('the observation time is the coverage\'s own observedAt (never "now"), and null when it is not a date', () => {
    expect(corpusCurrencyBlock({ coverage: { ...coverage([repo('a')]), observedAt: 'yesterday' }, basis: CURRENCY_BASIS.SEALED }).observedAt).toBeNull();
  });

  it.each([
    [CURRENCY_BASIS.LEGACY, 'v4.3.26'], // sync-version-ignore: the committed bootstrap seed tag
    [CURRENCY_BASIS.NONE, null],
  ])('%s: observed nothing, so it reports no date and no counts', (basis, tag) => {
    expect(corpusCurrencyBlock({ coverage: null, basis, generationTag: tag }))
      .toEqual({ basis, observedAt: null, generationTag: tag, counts: null, oldestCarried: null });
  });

  it('refuses an unknown basis rather than guessing one', () => {
    expect(() => corpusCurrencyBlock({ coverage: null, basis: 'fresh' })).toThrow(/unknown corpus currency basis/);
  });
});

function writeFixture(runtimeRoot, stores) {
  const queries = Object.fromEntries(stores.map((store) => [store, { query: `what does ${store} do?`, expected: { path: 'README.md' } }]));
  fs.writeFileSync(path.join(runtimeRoot, 'data', 'retrieval-query-evidence.json'),
    JSON.stringify({ schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence', sourceCommit: 'f'.repeat(40), queries }));
}

describe('manifest.json carries the corpus block through the real assembler (build-bundle.mjs)', () => {
  it('sealed observation: observedAt is the coverage\'s, not the assembly time; counts and the generation tag are exact', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    const sealed = writeCoverage(runtimeRoot, corpusDir);
    writeFixture(runtimeRoot, ['alpha', 'beta', 'pruned-upstream']);
    const outDir = path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: SEED_IDENTITY });
    const manifest = readJson(path.join(outDir, 'manifest.json'));
    expect(manifest.corpus).toEqual({
      basis: 'sealed-observation', observedAt: sealed.observedAt, generationTag: SEED_IDENTITY.tag,
      counts: { eligible: 2, current: 2, stale: 0, missing: 0, unverified: 0, retired: 1 }, oldestCarried: null,
    });
    expect(manifest.generated).not.toBe(sealed.observedAt); // `generated` stays the assembly time
  });

  it('a carried store: counted STALE, and oldestCarried names it with its date left null (bootstrap lineage)', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    const missed = '9'.repeat(40);
    writeCoverage(runtimeRoot, corpusDir, { mutate: (rows) => {
      const alpha = rows.find((row) => row.name === 'alpha');
      Object.assign(alpha, { status: 'STALE', reasons: ['receipt sourceCommit differs from upstream HEAD'],
        upstream: { ...alpha.upstream, sha: missed },
        carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: alpha.artifact.sourceCommit, missedUpstream: missed,
          attempts: 1, carriedCommittedAt: null } });
    } });
    const outDir = path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });
    const { corpus } = readJson(path.join(outDir, 'manifest.json'));
    expect(corpus.counts).toMatchObject({ eligible: 2, current: 1, stale: 1, retired: null });
    expect(corpus.generationTag).toBeNull(); // a nightly candidate cannot name its own content-addressed tag
    expect(corpus.oldestCarried).toMatchObject({ store: 'alpha', committedAt: null });
  });

  it('no observation (a standalone kb with no sealed coverage): every currency field is null', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });
    expect(readJson(path.join(outDir, 'manifest.json')).corpus)
      .toEqual({ basis: 'no-observation', observedAt: null, generationTag: null, counts: null, oldestCarried: null });
  });
});
