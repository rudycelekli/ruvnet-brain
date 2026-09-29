// ADR-0091 D6.4 — the frozen fixture meets a living eligible set.
//
// The canary used to demand fixture == eligible, which a growing corpus can never satisfy. The
// reconciled decision: every fixture store must ship or be VERIFIED retired (blocking otherwise);
// eligible stores with no fixture question are recorded as unfixturedEligible, never blocking.
import { describe, expect, it } from 'vitest';
import { coverageGenerationFor, digest } from '../../scripts/coverage-integrity.mjs';
import { getVersionTag } from '../../scripts/version.mjs';
import { fixtureDenominator, retiredFixtureStores } from '../../scripts/fixture-denominator.mjs';
import {
  buildRetrievalCanaryPlan, sealRetrievalQueryEvidence, validatePlanAgainstCoverage, validateRetrievalCanaryPlan,
} from '../../scripts/retrieval-canary.mjs';

const FIXTURE = ['old-a', 'old-b', 'old-c', 'old-d', 'new-e', 'new-f'];
const passagesFor = (store) => [{ id: `${store}-0`, path: `src/${store}.mjs`, title: `${store} architecture`,
  text: `The ${store} implementation owns a unique deterministic boundary and verifies its runtime behavior.` }];

function row(store, overrides = {}) {
  return { key: `repo:ruvnet/${store}`, kind: 'repository', name: store, url: `https://example/${store}`,
    disposition: 'eligible', status: 'CURRENT', reasons: [], upstream: { sha: 'c'.repeat(40) },
    artifact: { store, rvfSha256: digest(store) }, ...overrides };
}

function coverageOf(rows, { expected = rows.length } = {}) {
  const enumerationReceipt = { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-08-22T00:00:00Z', requestParameters: {},
    repositories: { expected, pages: [] }, gists: { expected: 0, pages: [] }, duplicateKeys: 0, terminal: true };
  const byStatus = {};
  for (const entry of rows) byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
  const base = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet', observedAt: '2026-08-22T00:00:00Z',
    generatorSourceSha: digest('generator'), sourceObservationSha256: digest('observation'), snapshotRoot: digest('snapshot'),
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: rows.length, gists: 0, rows: rows.length, byStatus } };
  return { ...base, coverageGeneration: coverageGenerationFor({ generatorSourceSha: base.generatorSourceSha,
    snapshotRoot: base.snapshotRoot, sourceObservationSha256: base.sourceObservationSha256, rows, enumerationReceipt,
    policyDispositionDigests: [], exemptionDigests: [] }) };
}

const queryEvidence = sealRetrievalQueryEvidence({
  schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence', sourceCommit: 'd'.repeat(40),
  sourcePath: 'data/retrieval-query-evidence.json', queryStoreSetSha256: digest([...FIXTURE].sort()),
  queries: Object.fromEntries(FIXTURE.map((store) => {
    const value = { query: `independently authored behavior question for ${store} runtime boundary`,
      expected: { path: passagesFor(store)[0].path, passageSha256: digest(passagesFor(store)[0]) } };
    return [store, { ...value, recordSha256: digest({ store, ...value }) }];
  })),
});

function planFor(coverage) {
  const coverageIdentity = { sha256: digest(coverage), bytes: Buffer.byteLength(JSON.stringify(coverage)) };
  return buildRetrievalCanaryPlan({
    coverage, coverageIdentity, queryEvidence, readPassages: (_dir, store) => passagesFor(store), allowNoDelta: true,
    baseline: { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline', tag: getVersionTag(),
      archiveSha256: '1'.repeat(64), archiveBytes: 1234, archiveManifestSha256: '2'.repeat(64),
      verificationReceiptSha256: '3'.repeat(64), stores: ['old-a', 'old-b', 'old-c', 'old-d'], storeCount: 4 },
    candidate: { sourceSha: 'a'.repeat(40), packageSha256: 'b'.repeat(64), archiveSha256: '4'.repeat(64),
      coverageSha256: coverageIdentity.sha256, publicLedgerSha256: '5'.repeat(64), publicLedgerBytes: 4321,
      publicStoreCount: 8, publicInventoryPartitionSha256: '6'.repeat(64) },
  });
}

const failed = { status: 'MISSING', failure: { reason: 'qa: forge-refresh failed', attempts: 1 } };

describe('canary denominator: fixture ⊆ available (ADR-0091 D6.4)', () => {
  it('GREEN: a live eligible set LARGER than the frozen fixture seals a plan; extras are recorded, not questioned', () => {
    const coverage = coverageOf([...FIXTURE.map((store) => row(store)), row('brand-new-g'), row('brand-new-h')]);
    const plan = planFor(coverage);
    expect(plan.denominator.eligibleStores).toEqual([...FIXTURE].sort());
    expect(plan.denominator.unfixturedEligibleStores).toEqual(['brand-new-g', 'brand-new-h']);
    expect(plan.denominator.unfixturedEligibleCount).toBe(2);
    expect(plan.denominator.retiredFixtureStores).toEqual([]);
    expect(plan.cases.some(({ expected }) => expected.repo.startsWith('brand-new'))).toBe(false);
    expect(validatePlanAgainstCoverage(plan, coverage)).toBe(plan);
  });

  it('GREEN: a fixture repository with NO row in a complete enumeration is retired -- removed from questioning, never answered', () => {
    const coverage = coverageOf(FIXTURE.filter((store) => store !== 'old-c').map((store) => row(store)));
    const plan = planFor(coverage);
    expect(plan.denominator.retiredFixtureStores).toEqual(['old-c']);
    expect(plan.cases.some(({ expected }) => expected.repo === 'old-c')).toBe(false);
    expect(validatePlanAgainstCoverage(plan, coverage)).toBe(plan);
  });

  it.each([
    ['MISSING with a failure record (no store shipped)', (store) => row(store, failed), 'old-c:MISSING'],
    ['ineligible (archived/forked)', (store) => row(store, { disposition: 'ineligible', status: 'INELIGIBLE' }), 'old-c:INELIGIBLE'],
  ])('RED: a fixture store that is %s blocks the release', (_label, make, named) => {
    const coverage = coverageOf(FIXTURE.map((store) => (store === 'old-c' ? make(store) : row(store))));
    expect(() => planFor(coverage)).toThrow(new RegExp(`neither shipped nor verified retired: ${named}`));
  });

  it('RED: absence is only a retirement under a complete, terminal enumeration', () => {
    const coverage = coverageOf(FIXTURE.filter((store) => store !== 'old-c').map((store) => row(store)), { expected: 6 });
    expect(retiredFixtureStores({ coverage, fixtureStores: FIXTURE })).toEqual([]);
    expect(fixtureDenominator({ coverage, fixtureStores: FIXTURE }).blocking).toEqual([{ store: 'old-c', status: null, disposition: null }]);
  });

  it('RED: a plan that hides a retirement or an unfixtured store no longer matches the coverage it claims', () => {
    const coverage = coverageOf([...FIXTURE.filter((store) => store !== 'old-c').map((store) => row(store)), row('brand-new-g')]);
    const plan = planFor(coverage);
    const reseal = (mutate) => {
      const { planSha256: _drop, ...payload } = structuredClone(plan);
      mutate(payload.denominator);
      return validateRetrievalCanaryPlan({ ...payload, planSha256: digest(payload) });
    };
    const hidden = reseal((d) => { d.retiredFixtureStores = []; d.retiredFixtureStoreSetSha256 = digest([]); });
    expect(() => validatePlanAgainstCoverage(hidden, coverage)).toThrow(/differs from exact coverage denominator/);
    const unrecorded = reseal((d) => {
      d.unfixturedEligibleStores = []; d.unfixturedEligibleStoreSetSha256 = digest([]); d.unfixturedEligibleCount = 0;
    });
    expect(() => validatePlanAgainstCoverage(unrecorded, coverage)).toThrow(/differs from exact coverage denominator/);
    expect(() => reseal((d) => { d.unfixturedEligibleCount = 5; })).toThrow(/fixture denominator is inconsistent/);
  });
});

// Real store names mix '-', '_' and '.', where code-unit order and localeCompare order disagree
// (the committed 182-store fixture diverges at 'chatgpt-…' vs 'chatgpt_…'). The canary's checkedSet
// demands localeCompare order, so the denominator must produce exactly that order. Preflight of
// 4.3.36 failed with 'eligible denominator set is invalid' on the real fixture before this was fixed.
describe('canary denominator: ordering matches the canary set check on punctuated store names', () => {
  const PUNCTUATED = ['chatgpt-dev-mode', 'chatgpt_plugin_python', 'ruv.io', 'ruv-dev', 'ai-code-generator-', 'aido'];
  const localeOrdered = (values) => [...values].sort((a, b) => a.localeCompare(b));
  it('orders every denominator list the way the canary validator requires', () => {
    expect([...PUNCTUATED].sort()).not.toEqual(localeOrdered(PUNCTUATED)); // the case is genuinely discriminating
    const coverage = coverageOf([...PUNCTUATED.map((store) => row(store)), row('zeta_new'), row('zeta-new2')]);
    const denominator = fixtureDenominator({ coverage, fixtureStores: PUNCTUATED });
    expect(denominator.fixture).toEqual(localeOrdered(PUNCTUATED));
    expect(denominator.questioned).toEqual(localeOrdered(PUNCTUATED));
    expect(denominator.unfixturedEligible).toEqual(localeOrdered(['zeta_new', 'zeta-new2']));
    const retiring = coverageOf(PUNCTUATED.filter((store) => !store.startsWith('chatgpt')).map((store) => row(store)));
    expect(retiredFixtureStores({ coverage: retiring, fixtureStores: PUNCTUATED }))
      .toEqual(localeOrdered(['chatgpt-dev-mode', 'chatgpt_plugin_python']));
  });

  it('seals and re-validates a canary plan over a punctuated fixture', () => {
    const evidence = sealRetrievalQueryEvidence({
      schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence', sourceCommit: 'd'.repeat(40),
      sourcePath: 'data/retrieval-query-evidence.json', queryStoreSetSha256: digest(localeOrdered(PUNCTUATED)),
      queries: Object.fromEntries(PUNCTUATED.map((store) => {
        const value = { query: `independently authored behavior question for ${store} runtime boundary`,
          expected: { path: passagesFor(store)[0].path, passageSha256: digest(passagesFor(store)[0]) } };
        return [store, { ...value, recordSha256: digest({ store, ...value }) }];
      })),
    });
    const coverage = coverageOf(PUNCTUATED.map((store) => row(store)));
    const coverageIdentity = { sha256: digest(coverage), bytes: Buffer.byteLength(JSON.stringify(coverage)) };
    const baselineStores = PUNCTUATED.slice(0, 4);
    const plan = buildRetrievalCanaryPlan({
      coverage, coverageIdentity, queryEvidence: evidence, readPassages: (_dir, store) => passagesFor(store), allowNoDelta: true,
      baseline: { schemaVersion: 1, kind: 'ruvnet-brain-verified-public-baseline', tag: getVersionTag(),
        archiveSha256: '1'.repeat(64), archiveBytes: 1234, archiveManifestSha256: '2'.repeat(64),
        verificationReceiptSha256: '3'.repeat(64), stores: baselineStores, storeCount: baselineStores.length },
      candidate: { sourceSha: 'a'.repeat(40), packageSha256: 'b'.repeat(64), archiveSha256: '4'.repeat(64),
        coverageSha256: coverageIdentity.sha256, publicLedgerSha256: '5'.repeat(64), publicLedgerBytes: 4321,
        publicStoreCount: PUNCTUATED.length, publicInventoryPartitionSha256: '6'.repeat(64) },
    });
    expect(validateRetrievalCanaryPlan(plan)).toBeTruthy();
    expect(validatePlanAgainstCoverage(plan, coverage)).toBe(plan);
  });
});
