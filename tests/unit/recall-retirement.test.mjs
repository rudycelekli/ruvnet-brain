// tests/unit/recall-retirement.test.mjs — ADR-0091 D7.2-D7.6.
//
// A frozen fixture meets a live prune. A fixture repository with NO row in a complete sealed coverage
// observation is RETIRED: its question is not asked and it leaves the denominator. The fixture is never
// edited (its digest is what seeds and the canary re-verify). Retirement only ever REMOVES a question,
// so the danger is a report that claims a retirement it cannot prove -- every reader recomputes the
// claim from coverage it obtained itself, through the one shared rule in scripts/fixture-denominator.mjs.
//
// The report format stays schemaVersion 1 and only ADDS fields. Compatibility is proven against the
// REAL v4.3.35 reader bytes (the shipped approved runtime, 107a1d44), not a re-typed imitation of it.
// And the floor is recorded, never fatal: repo-recall's exit code derives from integrity failures only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageGenerationFor, digest } from '../../scripts/coverage-integrity.mjs';
import { createCoverageReceipt } from '../../scripts/corpus-coverage-sidecar.mjs';
import { retiredFixtureStores } from '../../scripts/fixture-denominator.mjs';
import {
  FLOOR_KIND, RECALL_SCHEMA_VERSION, RecallGateError, evaluateGate, loadFixture, main, runRepoRecall, tally, validateRecallReport,
} from '../../scripts/oracle/repo-recall.mjs';
import { retireInRecallReport, writeAccuracyReport, writeRecallReport } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V4_3_35 = '107a1d44fc578dc67cea0425f1f01954e3e8d06b'; // the shipped approved runtime's repo-recall reader
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); vi.restoreAllMocks(); });
const temp = (label) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recall-retirement-${label}-`)); dirs.push(dir); return dir; };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const FIXTURE = loadFixture();
const STORES = FIXTURE.questions.map((question) => question.store);
const RETIRED = STORES[3].toLowerCase();
const NOW = () => new Date('2026-09-28T00:00:00.000Z');

function repositoryRow(store, overrides = {}) {
  return { key: `repo:ruvnet/${store.toLowerCase()}`, kind: 'repository', name: store, url: `https://github.com/ruvnet/${store}`,
    disposition: 'eligible', status: 'CURRENT', reasons: [], upstream: { sha: 'c'.repeat(40) },
    artifact: { store, rvfSha256: digest(store) }, ...overrides };
}

/** A VALID sealed coverage ledger (its generation digest recomputes) over `rows`. */
function sealedCoverage(rows, { expected = rows.length } = {}) {
  const enumerationReceipt = { schemaVersion: 1, owner: 'ruvnet', observedAt: '2026-09-27T00:00:00Z', requestParameters: {},
    repositories: { expected, pages: [] }, gists: { expected: 0, pages: [] }, duplicateKeys: 0, terminal: true };
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  const base = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', owner: 'ruvnet', observedAt: '2026-09-27T00:00:00Z',
    generatorSourceSha: digest('generator'), sourceObservationSha256: digest('observation'), snapshotRoot: digest('snapshot'),
    policy: { policyDispositionDigests: [], exemptionDigests: [] }, enumerationReceipt, rows,
    totals: { repositories: rows.length, gists: 0, rows: rows.length, byStatus } };
  return { ...base, coverageGeneration: coverageGenerationFor({ generatorSourceSha: base.generatorSourceSha,
    snapshotRoot: base.snapshotRoot, sourceObservationSha256: base.sourceObservationSha256, rows, enumerationReceipt,
    policyDispositionDigests: [], exemptionDigests: [] }) };
}

function writeCoverage(dir, coverage, name = 'coverage.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(coverage, null, 2)}\n`);
  return file;
}

/** Coverage in which every fixture repository has a row except `retired`. */
const coverageRetiring = (retired = [RETIRED]) => sealedCoverage(STORES.filter((store) => !retired.includes(store.toLowerCase()))
  .map((store) => repositoryRow(store)));

/** A search that answers every asked store with its labeled file, and records what was asked. */
function answeringSearch({ path: pathFor = (store) => FIXTURE.questions.find((q) => q.store === store).expectedPath, empty = [] } = {}) {
  const asked = [];
  return {
    asked,
    searchAll: async ({ repos }) => {
      asked.push(repos[0]);
      if (empty.includes(repos[0])) return { results: [] };
      return { results: [{ repo: repos[0], path: pathFor(repos[0]) }] };
    },
  };
}

describe('producer: a fixture repository absent from a complete sealed observation is retired, not asked (D7.2)', () => {
  it('GREEN: skips the retired question, records the claim bound to the coverage bytes, and passes the gate over the rest', async () => {
    const dir = temp('producer');
    const coverageFile = writeCoverage(dir, coverageRetiring());
    const search = answeringSearch();
    const { report, gate } = await runRepoRecall({ kbDir: '/unused', searchAll: search.searchAll, coverageFile, now: NOW });

    expect(search.asked.map((store) => store.toLowerCase())).not.toContain(RETIRED);
    expect(search.asked).toHaveLength(STORES.length - 1);
    expect(report.retirement).toEqual({ coverageSha256: sha(fs.readFileSync(coverageFile)), stores: [RETIRED] });
    // The SAME answer the shared rule gives (scripts/fixture-denominator.mjs is reused, not re-implemented).
    expect(report.retirement.stores).toEqual(retiredFixtureStores({ coverage: coverageRetiring(), fixtureStores: STORES }));
    expect(report.rows.find((row) => row.store.toLowerCase() === RETIRED))
      .toEqual({ store: STORES[3], expectedPath: FIXTURE.questions[3].expectedPath, retired: true, repoCovered: false, exactFileRank: null, returnedPaths: [] });
    expect(report.totals).toMatchObject({ questions: STORES.length - 1, completed: STORES.length - 1, errors: 0, retired: 1 });
    expect(gate).toEqual({ verdict: 'PASS', failures: [] });
    // The report format does NOT change version; it only adds fields.
    expect(RECALL_SCHEMA_VERSION).toBe(1);
    expect(report.schemaVersion).toBe(1);
    expect(report.fixture.questionCount).toBe(STORES.length); // the fixture is never edited
    expect(validateRecallReport({ report, coverageBytes: fs.readFileSync(coverageFile), fixtureStores: STORES, floorValue: 0 }).gate.blocking)
      .toBe(false);
  });

  it('with NO retirement the report is byte-for-byte the pre-D7 shape (no `retirement`, no `totals.retired`)', async () => {
    const dir = temp('no-retirement');
    const everyone = writeCoverage(dir, sealedCoverage(STORES.map((store) => repositoryRow(store))));
    const withCoverage = await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, coverageFile: everyone, now: NOW });
    const without = await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, now: NOW });
    expect(withCoverage.report).not.toHaveProperty('retirement');
    expect(withCoverage.report.totals).not.toHaveProperty('retired');
    expect(JSON.stringify(withCoverage.report)).toBe(JSON.stringify(without.report));
  });

  it('refuses a coverage that is not a valid sealed ledger rather than retiring from it', async () => {
    const dir = temp('tampered');
    const coverage = coverageRetiring();
    coverage.rows[0].status = 'STALE'; // edited after sealing: the generation digest no longer recomputes
    await expect(runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, coverageFile: writeCoverage(dir, coverage) }))
      .rejects.toThrow(RecallGateError);
  });
});

describe('tally and the gate apply the SAME exclusion (D7.4)', () => {
  const rows = [
    { store: 'a', repoCovered: true, exactFileRank: 1 },
    { store: 'b', repoCovered: true, exactFileRank: 3 },
    { store: 'c', retired: true, repoCovered: false, exactFileRank: null, returnedPaths: [] },
  ];

  it('excludes a retired row from every count and reports it, and the gate uses fixtureCount - retired', () => {
    expect(tally(rows)).toEqual({ questions: 2, completed: 2, errors: 0, repoCoverage: 2, hitTop1: 1, hitTop5: 2, retired: 1 });
    expect(evaluateGate({ totals: tally(rows), floorValue: 0, fixtureCount: 3 })).toEqual({ verdict: 'PASS', failures: [] });
  });

  it('an unanswered question still fails integrity -- retirement cannot absorb it', () => {
    const unanswered = [...rows.slice(0, 1), { store: 'b', repoCovered: false, exactFileRank: null }, rows[2]];
    const gate = evaluateGate({ totals: tally(unanswered), floorValue: 0, fixtureCount: 3 });
    expect(gate.verdict).toBe('FAIL');
    expect(gate.failures.join('; ')).toMatch(/1 repository\(ies\) returned nothing of their own/);
  });

  it('a gate that forgot the exclusion would refuse a correctly retired run (the two must agree)', () => {
    // Counting the retired row as asked-but-unanswered is exactly the pre-D7 behavior on a pruned repository.
    const counted = { ...tally(rows), questions: 3, completed: 3 };
    delete counted.retired;
    expect(evaluateGate({ totals: counted, floorValue: 0, fixtureCount: 3 }).verdict).toBe('FAIL');
  });
});

describe('readers recompute the retired set; a claim is never trusted (D7.3)', () => {
  async function retiredReport() {
    const dir = temp('reader');
    const coverageFile = writeCoverage(dir, coverageRetiring());
    const { report } = await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, coverageFile, now: NOW });
    return { dir, report, coverageBytes: fs.readFileSync(coverageFile) };
  }
  const read = (report, extra = {}) => validateRecallReport({ report: structuredClone(report), floorValue: 0, fixtureStores: STORES, ...extra });

  it('RED: a report hiding an UNANSWERED question behind a false retirement is rejected', async () => {
    const { report, coverageBytes } = await retiredReport();
    // Store 0 genuinely failed to answer. Honestly reported, that is an integrity failure...
    const honest = structuredClone(report);
    honest.rows[0] = { ...honest.rows[0], repoCovered: false, exactFileRank: null, returnedPaths: [] };
    honest.totals = tally(honest.rows);
    expect(() => read(honest, { coverageBytes })).toThrow(/integrity FAILED: 1 repository\(ies\) returned nothing/);
    // ...so a forger claims it retired too. Store 0 HAS a row in the coverage, so the reader refuses.
    const forged = structuredClone(honest);
    forged.rows[0] = { store: forged.rows[0].store, expectedPath: forged.rows[0].expectedPath, retired: true,
      repoCovered: false, exactFileRank: null, returnedPaths: [] };
    forged.retirement.stores = [RETIRED, STORES[0].toLowerCase()].sort();
    forged.totals = tally(forged.rows);
    expect(() => read(forged, { coverageBytes }))
      .toThrow(new RegExp(`claims \\[${STORES[0].toLowerCase()}\\] retired, but the coverage it names does not retire them`));
  });

  it('RED: a repository row matched by NAME alone (no store on the row) still proves the repository exists', async () => {
    const dir = temp('by-name');
    const rows = STORES.map((store) => (store.toLowerCase() === RETIRED
      ? repositoryRow(store, { disposition: 'excluded-no-corpus', status: 'INELIGIBLE', artifact: { store: null } })
      : repositoryRow(store)));
    const coverageFile = writeCoverage(dir, sealedCoverage(rows));
    const { report } = await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, now: NOW });
    const claimed = structuredClone(report);
    const index = claimed.rows.findIndex((row) => row.store.toLowerCase() === RETIRED);
    claimed.rows[index] = { store: claimed.rows[index].store, expectedPath: claimed.rows[index].expectedPath, retired: true,
      repoCovered: false, exactFileRank: null, returnedPaths: [] };
    claimed.retirement = { coverageSha256: sha(fs.readFileSync(coverageFile)), stores: [RETIRED] };
    claimed.totals = tally(claimed.rows);
    expect(() => read(claimed, { coverageBytes: fs.readFileSync(coverageFile) })).toThrow(/does not retire them/);
  });

  it('GREEN: the genuine claim verifies against the coverage it names', async () => {
    const { report, coverageBytes } = await retiredReport();
    expect(read(report, { coverageBytes }).totals.retired).toBe(1);
  });

  it.each([
    ['no coverage at all', (r) => r, () => null, /claims retired question\(s\) but no coverage was supplied/],
    ['different coverage bytes than the claim names', (r) => r,
      () => Buffer.from(JSON.stringify(sealedCoverage(STORES.filter((s) => s.toLowerCase() !== RETIRED).map((s) => repositoryRow(s, { reasons: ['x'] }))))),
      /measured against different coverage bytes/],
    ['a retired row credited with an answer', (r) => { r.rows.find((row) => row.retired).repoCovered = true; r.totals = tally(r.rows); return r; }, null,
      /credits a retired question with an answer/],
    ['a retirement block naming other rows than it marks', (r) => { r.retirement.stores = ['someone-else']; return r; }, null,
      /does not name exactly the rows it marks retired/],
    ['rows marked retired with no retirement block', (r) => { delete r.retirement; return r; }, null,
      /without a well-formed retirement block/],
  ])('RED: %s', async (_label, mutate, coverageFor, message) => {
    const { report, coverageBytes } = await retiredReport();
    const bytes = coverageFor === null ? coverageBytes : coverageFor();
    expect(() => read(mutate(structuredClone(report)), { coverageBytes: bytes })).toThrow(message);
  });
});

/** The REAL v4.3.35 repo-recall module (the shipped approved runtime), loaded from git history. */
async function loadV4335Reader() {
  let source;
  try { source = execFileSync('git', ['show', `${V4_3_35}:scripts/oracle/repo-recall.mjs`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
  const root = temp('v4335');
  fs.mkdirSync(path.join(root, 'scripts', 'oracle'), { recursive: true });
  fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'oracle', 'repo-recall.mjs'), source);
  fs.copyFileSync(path.join(ROOT, 'kb', 'zip-extract.mjs'), path.join(root, 'kb', 'zip-extract.mjs'));
  return import(pathToFileURL(path.join(root, 'scripts', 'oracle', 'repo-recall.mjs')).href);
}

describe('schemaVersion 1 stays readable in both directions against the real v4.3.35 reader (D7.4)', () => {
  it('an OLDER reader accepts a NEWER report with no retirement, and FAILS CLOSED on one with a retirement', async (ctx) => {
    const old = await loadV4335Reader();
    if (!old) ctx.skip(); // no git history for 107a1d44 in this checkout (shallow clone): reported as skipped, never passed
    expect(old.RECALL_SCHEMA_VERSION).toBe(1);
    expect(old.validateRecallReport.toString()).not.toMatch(/retire/); // it genuinely predates D7

    const plain = (await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll, now: NOW })).report;
    expect(old.validateRecallReport({ report: structuredClone(plain), expectedFixtureSha256: FIXTURE.fixtureSha256, floorValue: 0 }).gate.blocking)
      .toBe(false);

    const dir = temp('old-reader');
    const retired = (await runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll,
      coverageFile: writeCoverage(dir, coverageRetiring()), now: NOW })).report;
    expect(() => old.validateRecallReport({ report: structuredClone(retired), expectedFixtureSha256: FIXTURE.fixtureSha256, floorValue: 0 }))
      .toThrow(/totals do not re-derive from its own rows/);
  });

  it('a NEWER reader accepts a report the OLDER producer wrote, with or without coverage supplied', async (ctx) => {
    const old = await loadV4335Reader();
    if (!old) ctx.skip();
    const { report } = await old.runRepoRecall({ kbDir: '/unused', searchAll: answeringSearch().searchAll,
      fixtureFile: path.join(ROOT, 'data', 'retrieval-query-evidence.json'), now: NOW });
    expect(report.schemaVersion).toBe(1);
    const dir = temp('new-reader');
    const coverageBytes = fs.readFileSync(writeCoverage(dir, sealedCoverage(STORES.map((store) => repositoryRow(store)))));
    for (const extra of [{}, { coverageBytes, fixtureStores: STORES }]) {
      const checked = validateRecallReport({ report: structuredClone(report), expectedFixtureSha256: FIXTURE.fixtureSha256, floorValue: 0, ...extra });
      expect(checked.gate.blocking).toBe(false);
    }
  });
});

describe('the floor is RECORDED, never fatal: repo-recall exits non-zero on integrity failures only (D7.6)', () => {
  function floorFile(dir, hitTop5Floor) {
    const file = path.join(dir, 'floor.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: FLOOR_KIND, hitTop5Floor, fixtureSha256: FIXTURE.fixtureSha256 }));
    return file;
  }
  const quiet = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('GREEN: a floor-ONLY miss exits 0 and the miss is still written into the report', async () => {
    const dir = temp('floor');
    const out = path.join(dir, 'report.json');
    quiet();
    // Every repository answers, but never with the labeled file: Hit@5 = 0 against a re-accepted floor of 176.
    const code = await main(['--kb', '/unused', '--floor', floorFile(dir, 176), '--out', out],
      { searchAll: answeringSearch({ path: () => 'not-the-labeled-file.md' }).searchAll });
    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.state).toBe('FAIL');
    expect(report.failures).toEqual(['exact-file Hit@5 regressed to 0, below the accepted floor of 176']);
    const read = validateRecallReport({ report, floorFile: floorFile(dir, 176) });
    expect(read.gate).toMatchObject({ blocking: false, enforced: [] });
  });

  it('RED: an integrity failure (a repository returns nothing of its own) exits 1', async () => {
    const dir = temp('integrity');
    quiet();
    const code = await main(['--kb', '/unused', '--floor', floorFile(dir, 0), '--out', path.join(dir, 'report.json')],
      { searchAll: answeringSearch({ empty: [STORES[0]] }).searchAll });
    expect(code).toBe(1);
  });

  it('GREEN: --coverage retires through the CLI too, and exits 0', async () => {
    const dir = temp('cli-coverage');
    const out = path.join(dir, 'report.json');
    quiet();
    const code = await main(['--kb', '/unused', '--floor', floorFile(dir, 0), '--out', out, '--coverage', writeCoverage(dir, coverageRetiring())],
      { searchAll: answeringSearch().searchAll });
    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).retirement.stores).toEqual([RETIRED]);
  });
});

// corpus-seed.yml's seed re-check (between its BEGIN/END seed-recall-verify markers) is EXECUTED here,
// with `gh` stubbed to serve "published" assets from a directory. Pattern-matching the YAML would pass
// a block that reads correctly and branches wrongly.
describe('corpus-seed.yml re-verifies a seed\'s claimed retirement against the seed\'s own coverage sidecar (D7.3)', () => {
  function extractBlock() {
    const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'corpus-seed.yml'), 'utf8');
    const match = source.match(/^(\s*)# BEGIN seed-recall-verify[^\n]*\n([\s\S]*?)^\1# END seed-recall-verify$/m);
    if (!match) throw new Error('the seed-recall-verify block is gone from corpus-seed.yml');
    return match[2].split('\n').map((line) => (line.startsWith(match[1]) ? line.slice(match[1].length) : line)).join('\n');
  }

  function runSeedCheck({ coverage, publishSidecar = true, claim = true }) {
    const runnerTemp = temp('runner');
    const published = temp('published');
    const download = path.join(runnerTemp, 'corpus-seed-download');
    fs.mkdirSync(download);
    const bundle = path.join(download, 'ruvnet-brain.zip');
    fs.writeFileSync(bundle, 'fixture seed archive bytes');
    const archiveSha256 = sha(fs.readFileSync(bundle));
    const tag = `corpus-sha256-${archiveSha256}`;
    writeAccuracyReport(bundle);
    writeRecallReport(bundle);
    const coverageFile = writeCoverage(published, coverage, 'CORPUS-COVERAGE.json');
    if (claim) retireInRecallReport(`${bundle}.recall.json`, [RETIRED], coverageFile);
    const assets = [{ name: 'ruvnet-brain.zip' }, { name: 'ruvnet-brain.zip.accuracy.json' }, { name: 'ruvnet-brain.zip.recall.json' }];
    if (publishSidecar) {
      const sidecar = createCoverageReceipt({ generationTag: tag, archiveSha256, archiveBytes: fs.statSync(bundle).size,
        coverageBytes: fs.readFileSync(coverageFile) });
      fs.writeFileSync(path.join(published, 'coverage-receipt.json'), JSON.stringify(sidecar));
      assets.push({ name: 'CORPUS-COVERAGE.json' }, { name: 'coverage-receipt.json' });
    }
    fs.writeFileSync(path.join(runnerTemp, 'corpus-seed-release.json'), JSON.stringify({ tagName: tag, isDraft: false, assets }));
    const prelude = `set -euo pipefail
gh() { local pattern dir; while [ $# -gt 0 ]; do case "$1" in --pattern) pattern="$2"; shift;; --dir) dir="$2"; shift;; esac; shift; done
  echo "gh download $pattern" >> "$RUNNER_TEMP/gh.log"; cp "$PUBLISHED/$pattern" "$dir/"; }
`;
    const r = spawnSync('bash', ['-c', `${prelude}\n${extractBlock()}`], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, RUNNER_TEMP: runnerTemp, PUBLISHED: published, SEED_TAG: tag, SEED_SHA256: archiveSha256,
        GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain' },
    });
    const log = fs.existsSync(path.join(runnerTemp, 'gh.log')) ? fs.readFileSync(path.join(runnerTemp, 'gh.log'), 'utf8') : '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, log };
  }

  it('GREEN: a retirement the seed\'s sidecar coverage proves is verified, and the seed is accepted', () => {
    const r = runSeedCheck({ coverage: coverageRetiring() });
    expect(r.status, r.out).toBe(0);
    expect(r.log).toMatch(/gh download CORPUS-COVERAGE\.json\ngh download coverage-receipt\.json/);
    expect(r.out).toMatch(/1 retired \(verified against the seed's coverage\)/);
  });

  it('RED: a FALSE retirement (the repository has a row in the seed\'s coverage) fails the step', () => {
    const r = runSeedCheck({ coverage: sealedCoverage(STORES.map((store) => repositoryRow(store))) });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not retire them/);
  });

  it('RED: a claimed retirement from a seed with no sidecar cannot be verified, so it fails the step', () => {
    const r = runSeedCheck({ coverage: coverageRetiring(), publishSidecar: false });
    expect(r.status).not.toBe(0);
    expect(r.log).toBe('');
    expect(r.out).toMatch(/claims retired question\(s\) but no coverage was supplied/);
  });

  it('GREEN (compatibility): a pre-D6 seed with no sidecar and no retirement reads exactly as before', () => {
    const r = runSeedCheck({ coverage: coverageRetiring(), publishSidecar: false, claim: false });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/seed repo-recall gate verified against the downloaded seed bytes/);
    expect(r.out).not.toMatch(/retired/);
  });
});

describe('every workflow corpus-candidate --verify hands the reader the candidate\'s sealed coverage (D7.3)', () => {
  // Without it, a candidate whose recall report legitimately retires a pruned repository could never be
  // re-verified: the reader treats any retirement it cannot recompute as invalid.
  const verifyCall = (file) => {
    const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8');
    const calls = source.match(/node scripts\/corpus-candidate\.mjs --verify(?:[^\n]*\\\n)*[^\n]*/g) || [];
    expect(calls.length, `${file} has no corpus-candidate --verify call`).toBeGreaterThan(0);
    return calls;
  };
  it.each([
    ['corpus-seed.yml', '--coverage data/source-coverage.json'],
    ['protected-release.yml', '--coverage "$staged/source-coverage.json"'],
  ])('%s', (file, flag) => {
    for (const call of verifyCall(file)) expect(call).toContain(flag);
  });
});
