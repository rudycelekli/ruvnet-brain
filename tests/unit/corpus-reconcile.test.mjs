import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertBootstrapIdentity,
  assertPathNotOverlapping,
  executeReconciliation,
  normalizeExtractedCorpus,
  planReconciliation,
  prepareCorpusCandidate,
  pruneIneligibleStores,
  acquireCorpusGeneration,
  acquireSealedGeneration,
  main,
  reconcileAndPrepareCorpusCandidate,
  seedPrivateFenceEvidence,
  summarizeReconciliation,
  SEED_LEDGER_INCOMPATIBLE_EXIT,
  SeedLedgerIncompatibleError,
  seedLedgerIncompatibility,
} from '../../scripts/corpus-reconcile.mjs';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-reconcile-'));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const sha = (char) => char.repeat(40);
// The envelope every real seed ledger carries (build-bundle.mjs writes it; v4.3.26 ships it).
const SEED_LEDGER = '{"schemaVersion":2,"kind":"ruvnet-brain-runtime-generation-ledger","stores":{}}';
const coverage = (rows) => ({ schemaVersion: 1, coverageGeneration: 'generation-1', rows });
const repo = ({ name, store = name.toLowerCase(), upstream = sha('a'), disposition = 'eligible' }) => ({
  key: `repo:${name}`,
  kind: 'repository',
  name,
  url: `https://github.com/ruvnet/${name}`,
  disposition,
  upstream: { sha: upstream },
  artifact: { store },
});

describe('exact corpus bootstrap identity', () => {
  it('accepts only a digest-derived tag whose downloaded archive has the configured sha256', () => {
    const root = temp();
    const archive = path.join(root, 'ruvnet-brain.zip');
    fs.writeFileSync(archive, 'sealed corpus bytes');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    expect(assertBootstrapIdentity({ archiveFile: archive, tag: `corpus-sha256-${digest}`, sha256: digest }))
      .toEqual({ tag: `corpus-sha256-${digest}`, sha256: digest });
    expect(() => assertBootstrapIdentity({ archiveFile: archive, tag: 'latest', sha256: digest }))
      .toThrow(/digest-derived tag/i);
    expect(() => assertBootstrapIdentity({ archiveFile: archive, tag: `corpus-sha256-${'0'.repeat(64)}`, sha256: '0'.repeat(64) }))
      .toThrow(/downloaded archive sha256/i);
  });

  it('normalizes the one archive root and rejects ambiguous or pre-fenced seed contents', () => {
    const root = temp();
    const extracted = path.join(root, 'extracted');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(extracted, 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'RVF-GENERATIONS.json'), SEED_LEDGER);
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'alpha.big.rvf'), 'rvf');
    expect(normalizeExtractedCorpus({ extractedDir: extracted, assetsDir: assets })).toBe(assets);
    expect(fs.existsSync(path.join(assets, 'alpha.big.rvf'))).toBe(true);

    const ambiguous = path.join(root, 'ambiguous');
    fs.mkdirSync(path.join(ambiguous, 'one'), { recursive: true });
    fs.mkdirSync(path.join(ambiguous, 'two'), { recursive: true });
    fs.writeFileSync(path.join(ambiguous, 'one', 'RVF-GENERATIONS.json'), SEED_LEDGER);
    fs.writeFileSync(path.join(ambiguous, 'two', 'RVF-GENERATIONS.json'), SEED_LEDGER);
    expect(() => normalizeExtractedCorpus({ extractedDir: ambiguous, assetsDir: path.join(root, 'bad-assets') }))
      .toThrow(/exactly one RVF-GENERATIONS/i);

    // A published seed's own PRIVATE-STORES.json is accepted as AUTHENTICATED HISTORICAL EVIDENCE
    // (task 4 / ADR bootstrap-fence correction) — never as current policy. It is kept aside under a
    // distinct name so it can never shadow or be overwritten by the exact builder checkout's own
    // canonical fence (copied in by main(), after normalizeExtractedCorpus returns).
    const fenced = path.join(root, 'fenced');
    fs.mkdirSync(fenced, { recursive: true });
    fs.writeFileSync(path.join(fenced, 'RVF-GENERATIONS.json'), SEED_LEDGER);
    fs.writeFileSync(path.join(fenced, 'alpha.big.rvf'), 'rvf');
    fs.writeFileSync(path.join(fenced, 'PRIVATE-STORES.json'), '{"privateStores":["secret"]}');
    const fencedAssets = path.join(root, 'fenced-assets');
    expect(normalizeExtractedCorpus({ extractedDir: fenced, assetsDir: fencedAssets })).toBe(fencedAssets);
    expect(fs.existsSync(path.join(fencedAssets, 'PRIVATE-STORES.json'))).toBe(false);
    expect(fs.existsSync(path.join(fencedAssets, 'SEED-PRIVATE-STORES.json'))).toBe(true);
    expect(seedPrivateFenceEvidence(fencedAssets)).toMatchObject({
      file: 'SEED-PRIVATE-STORES.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number),
    });
    // No historical fence at all: evidence is simply absent, never fabricated.
    expect(seedPrivateFenceEvidence(assets)).toBeNull();
  });
});

// ADR-0091 D4: the one seed property that cannot be judged before download is the generation ledger's
// schema (it lives only inside the archive). It is checked right after extraction, before anything is
// moved, and reported as a DISTINCT failure so corpus-seed.yml can retry once from the bootstrap.
describe('seed ledger schema is checked after extraction (ADR-0091 D4)', () => {
  const extractedWith = (ledgerText) => {
    const root = temp();
    const extracted = path.join(root, 'extracted');
    fs.mkdirSync(path.join(extracted, 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'RVF-GENERATIONS.json'), ledgerText);
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'alpha.big.rvf'), 'rvf');
    return { extracted, assets: path.join(root, 'assets') };
  };

  it.each([
    ['a schema-1 ledger', '{"schemaVersion":1,"stores":{}}', /schemaVersion 1 kind null; this runtime reads schemaVersion 2 kind ruvnet-brain-runtime-generation-ledger/],
    ['a future schema-3 ledger', '{"schemaVersion":3,"kind":"ruvnet-brain-runtime-generation-ledger","stores":{}}', /schemaVersion 3/],
    ['the public-ledger kind', '{"schemaVersion":2,"kind":"ruvnet-brain-public-generation-ledger","stores":{}}', /kind "ruvnet-brain-public-generation-ledger"/],
    ['a ledger with no stores object', '{"schemaVersion":2,"kind":"ruvnet-brain-runtime-generation-ledger","stores":[]}', /no stores object/],
    ['an unreadable ledger', '{not json', /unreadable/],
  ])('%s is refused as SeedLedgerIncompatibleError and NOTHING is moved', (_name, ledgerText, message) => {
    const { extracted, assets } = extractedWith(ledgerText);
    let caught;
    try { normalizeExtractedCorpus({ extractedDir: extracted, assetsDir: assets }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SeedLedgerIncompatibleError);
    expect(caught.message).toMatch(message);
    expect(fs.existsSync(assets)).toBe(false);
    expect(fs.existsSync(path.join(extracted, 'ruvnet-brain', 'alpha.big.rvf'))).toBe(true);
  });

  it('accepts exactly the envelope build-bundle writes', () => {
    expect(seedLedgerIncompatibility(JSON.parse(SEED_LEDGER))).toBeNull();
  });

  it('moves every top-level entry whole, runtime files and directories included -- no strip step (0.1.0 withdrawn)', () => {
    const { extracted, assets } = extractedWith(SEED_LEDGER);
    const rootDir = path.join(extracted, 'ruvnet-brain');
    for (const dir of ['keys', 'primer', 'l2']) {
      fs.mkdirSync(path.join(rootDir, dir), { recursive: true });
      fs.writeFileSync(path.join(rootDir, dir, 'x.txt'), dir);
    }
    fs.writeFileSync(path.join(rootDir, 'capability-cards.md'), '# cards');
    fs.writeFileSync(path.join(rootDir, 'forge-ask.mjs'), 'export {};');
    normalizeExtractedCorpus({ extractedDir: extracted, assetsDir: assets });
    expect(fs.readdirSync(assets).sort()).toEqual(
      ['RVF-GENERATIONS.json', 'alpha.big.rvf', 'capability-cards.md', 'forge-ask.mjs', 'keys', 'l2', 'primer']);
    expect(fs.readFileSync(path.join(assets, 'l2', 'x.txt'), 'utf8')).toBe('l2');
  });
});

describe('reconciliation planning', () => {
  it('plans only eligible repositories whose ledger sourceCommit is absent or differs', () => {
    const rows = [
      repo({ name: 'alpha', upstream: sha('a') }),
      repo({ name: 'beta', upstream: sha('b') }),
      repo({ name: 'gamma', upstream: sha('c'), disposition: 'fork' }),
      { key: 'gist:1', kind: 'gist', disposition: 'eligible', upstream: { sha: sha('d') }, artifact: { store: 'ruv-gists' } },
    ];
    const ledger = { stores: {
      alpha: { sourceCommit: sha('0') },
      beta: { sourceCommit: sha('b') },
    } };
    expect(planReconciliation({ coverage: coverage(rows), ledger })).toEqual([{
      name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('0'), reason: 'sourceCommit differs',
    }]);
  });

  it('fails closed on ambiguous, malformed, or non-GitHub eligible repository evidence', () => {
    const ledger = { stores: {} };
    expect(() => planReconciliation({ coverage: coverage([
      repo({ name: 'alpha', store: 'same' }), repo({ name: 'beta', store: 'same' }),
    ]), ledger })).toThrow(/duplicate eligible store/i);
    expect(() => planReconciliation({ coverage: coverage([
      { ...repo({ name: 'alpha' }), upstream: { sha: 'main' } },
    ]), ledger })).toThrow(/upstream SHA/i);
    expect(() => planReconciliation({ coverage: coverage([
      { ...repo({ name: 'alpha' }), url: 'https://example.com/alpha' },
    ]), ledger })).toThrow(/GitHub repository URL/i);
  });

  it('rebuilds a source-current store when its generation receipt does not bind the seed bytes', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'actual seed bytes');
    const rows = [repo({ name: 'alpha', upstream: sha('a') })];
    const ledger = { stores: { alpha: {
      file: 'alpha.big.rvf', sourceCommit: sha('a'), bytes: 1, sha256: '0'.repeat(64),
    } } };
    expect(planReconciliation({ coverage: coverage(rows), ledger, assetsDir })).toEqual([{
      name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('a'),
      reason: 'generation receipt differs from seed bytes',
    }]);
  });
});

describe('reconciliation execution', () => {
  it('fresh-clones, checks out and verifies the exact SHA before forge-refresh, then verifies the ledger', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    const workspaceDir = path.join(root, 'clones');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    const ledgerFile = path.join(assetsDir, 'RVF-GENERATIONS.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ stores: { alpha: { sourceCommit: sha('0') } } }));
    const plan = [{ name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('0'), reason: 'sourceCommit differs' }];
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n`, stderr: '' };
      if (command === process.execPath && args[0].replaceAll('\\', '/').endsWith('kb/forge-refresh.mjs')) {
        const output = args[args.indexOf('--out') + 1];
        fs.writeFileSync(path.join(output, 'alpha.big.rvf'), 'rvf');
        fs.writeFileSync(path.join(output, 'alpha.big.rvf.idmap.json'), '{}');
        fs.writeFileSync(path.join(output, 'alpha.big.rvf.embed.json'), '{}');
        fs.writeFileSync(path.join(output, 'alpha.passages.jsonl'), '{}\n');
        fs.writeFileSync(path.join(output, 'alpha.meta.json'), '{}');
        fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
          alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a'), bytes: 3,
            sha256: crypto.createHash('sha256').update('rvf').digest('hex') },
        } }));
        fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { sourceCommit: sha('a') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(executeReconciliation({ plan, assetsDir, workspaceDir, root, run })).resolves.toMatchObject({ refreshed: ['alpha'] });
    expect(calls).toEqual(expect.arrayContaining([
      ['git', 'clone', '--no-checkout', '--filter=blob:none', 'https://github.com/ruvnet/alpha', expect.stringContaining('alpha')],
      ['git', '-C', expect.stringContaining('alpha'), 'fetch', '--depth=1', 'origin', sha('a')],
      ['git', '-C', expect.stringContaining('alpha'), 'checkout', '--detach', 'FETCH_HEAD'],
      [process.execPath, expect.stringMatching(/kb[\\/]forge-refresh\.mjs$/), '--repo', expect.stringContaining('alpha'), '--out', expect.stringMatching(/workers[\\/]alpha[\\/]assets$/), '--name', 'alpha'],
    ]));
    expect(calls.find((call) => call[0] === process.execPath))
      .toBeTruthy();
  });

  // ADR-0091 D5: this used to reject the whole round. The worker's output still fails validation (so
  // nothing it produced is merged), but the failure is now ISOLATED to its store: a store with no
  // prior bytes becomes MISSING with a failure record, and an integrity failure is never retried.
  it('isolates a store whose forge-refresh does not produce the exact upstream ledger receipt', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {} }));
    const plan = [{ name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: null, reason: 'missing ledger receipt' }];
    const run = (command, args) => {
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const clones = [];
    const recordingRun = (command, args, options) => {
      if (command === 'git' && args[0] === 'clone') clones.push(args.at(-1));
      return run(command, args, options);
    };
    const result = await executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'clones'), root,
      run: recordingRun, log: () => {} });
    expect(result).toMatchObject({ refreshed: [], carried: [], integrityFailures: [],
      missing: [{ store: 'alpha', failure: { reason: 'integrity: worker output validation failed', attempts: 1 } }] });
    expect(clones, 'an integrity failure is never retried').toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'))).toEqual({ stores: {} });
  });

  // Required proof 4 (2026-09-13): a worker failure must abort and join its still-running siblings
  // -- no orphaned processes, no unhandled rejection from a sibling that finishes after the pool has
  // already been given up on. Before this fix `executeReconciliation` had no cancellation at all: a
  // failing lane's `Promise.all` member rejected immediately while sibling lanes kept running,
  // completely unobserved.
  // ADR-0091 D5 retired the abort-all half of this proof: one store's failure no longer cancels its
  // siblings (it now becomes a carry/failure record, see corpus-reconcile-isolation.test.mjs). The
  // join guarantee stays, for the one cancellation that is still round-wide: an EXTERNAL signal.
  it('an external abort still joins every still-running worker before the round rejects', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    const workspaceDir = path.join(root, 'clones');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {} }));
    const plan = [
      { name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha', upstreamSha: sha('a'), ledgerSourceCommit: null, reason: 'missing ledger receipt' },
      { name: 'beta', store: 'beta', url: 'https://github.com/ruvnet/beta', upstreamSha: sha('b'), ledgerSourceCommit: null, reason: 'missing ledger receipt' },
    ];
    let betaCloneStarted = false;
    let betaSawAbort = false;
    const external = new AbortController();
    const run = (command, args, options = {}) => {
      if (command === 'git' && args[0] === 'clone') {
        fs.mkdirSync(args.at(-1), { recursive: true });
        const isBeta = args.at(-1).includes('beta');
        if (!isBeta) {
          external.abort(new Error('caller discarded the round'));
          return Promise.resolve({ status: null, error: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
        }
        // beta hangs -- exactly like a real long-running clone would -- until the shared signal
        // aborts it, proving the still-running sibling is actually joined, not left dangling.
        betaCloneStarted = true;
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            betaSawAbort = true;
            resolve({ status: null, error: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
          }, { once: true });
        });
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    // beta's clone starts first (plan order is alpha, beta, but alpha aborts only once beta is running).
    const betaFirst = (command, args, options) => (command === 'git' && args[0] === 'clone' && !args.at(-1).includes('beta')
      ? new Promise((resolve) => setTimeout(() => resolve(run(command, args, options)), 20)) : run(command, args, options));
    await expect(executeReconciliation({ plan, assetsDir, workspaceDir, root, run: betaFirst, concurrency: 2,
      signal: external.signal, log: () => {} })).rejects.toThrow(/caller discarded the round/);
    expect(betaCloneStarted, 'beta must actually have started, or this test guards nothing').toBe(true);
    expect(betaSawAbort, 'beta must have observed the shared abort signal and joined promptly').toBe(true);
  });
});

describe('candidate preparation', () => {
  // Step 4, rules 5-6 (2026-09-13): prepareCorpusCandidate used to shell out to
  // `source-coverage.mjs --write` then `--check --strict` -- two SEPARATE live re-observations of
  // the real source universe, run AFTER reconciliation had already stabilized. It now trusts an
  // already-measured `coverage` object outright and renders both the committed JSON and Markdown
  // from that one object, never touching source-coverage.mjs at all.
  const coverageFixture = (status) => ({
    kind: 'ruvnet-brain-corpus-coverage', observedAt: '2026-09-13T00:00:00.000Z', coverageGeneration: 'gen-1',
    totals: { repositories: 1, gists: 0, byStatus: { [status]: 1 } },
    rows: [{ kind: 'repository', name: 'alpha', url: 'https://github.com/ruvnet/alpha', disposition: 'eligible',
      status, upstream: {}, artifact: {}, reasons: status === 'CURRENT' ? [] : ['x'] }],
  });

  // ADR-086 Step 15 wired the C3 retrieval-accuracy benchmark into this function, so a candidate root
  // needs the benchmark script and the committed oracle as well as the two older builders. The
  // 2026-09-15 amendment added the BLOCKING repo-recall gate beside it, which brings two more hard
  // inputs — the frozen fixture and the ratchet floor — checked before assembly for the same reason:
  // a missing one must fail in seconds, not after an hour of building.
  const candidateRoot = ({ oracle = true, recallInputs = true } = {}) => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts', 'oracle'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const file of ['build-bundle.mjs', 'corpus-candidate.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', file), '// fixture');
    }
    for (const file of ['retrieval-accuracy.mjs', 'repo-recall.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', 'oracle', file), '// fixture');
    }
    if (oracle) fs.writeFileSync(path.join(root, 'data', 'retrieval-accuracy-oracle.json'), '{}');
    if (recallInputs) {
      fs.writeFileSync(path.join(root, 'data', 'retrieval-query-evidence.json'), '{}');
      fs.writeFileSync(path.join(root, 'data', 'repo-recall-floor.json'), '{}');
    }
    return root;
  };

  it('MUST BLOCK: a checkout missing the frozen fixture or the ratchet assembles nothing at all', () => {
    const coverage = coverageFixture('CURRENT');
    const run = () => ({ status: 0, stdout: '', stderr: '' });
    const attempt = () => prepareCorpusCandidate({
      root: candidateRoot({ recallInputs: false }),
      assets: path.join(temp(), 'assets'),
      candidate: path.join(temp(), 'out', 'ruvnet-brain'),
      receipt: path.join(temp(), 'out', 'corpus-receipt.json'),
      policy: path.join(temp(), 'out', 'coverage.json'),
      builderSha: 'a'.repeat(40),
      coverage,
      run,
    });
    expect(attempt).toThrow(/repo-recall gate input missing/i);
  });

  it('never re-observes live sources; renders coverage JSON+Markdown from one object, then builds and seals', () => {
    const root = candidateRoot();
    const coverage = coverageFixture('CURRENT');
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    const result = prepareCorpusCandidate({
      root,
      assetsDir: path.join(root, 'assets'),
      builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage,
      run,
    });
    expect(result.bundleFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip'));
    const joined = calls.map((call) => call.join(' '));
    // Step 15 plus the 2026-09-15 amendment: assembly, THEN the C3 benchmark against the assembled
    // archive, THEN the BLOCKING repo-recall gate against the same archive, THEN the seal that binds
    // both reports, THEN independent re-verification. Order is the contract: a measurement run before
    // assembly would measure nothing, and one after the seal could not be bound by it.
    expect(joined).toHaveLength(5);
    expect(joined[0]).toMatch(/build-bundle\.mjs/);
    expect(joined[1]).toMatch(/oracle\/retrieval-accuracy\.mjs .*--bundle .*ruvnet-brain\.zip/);
    expect(joined[1]).toMatch(/--out .*ruvnet-brain\.zip\.accuracy\.json/);
    expect(joined[1]).not.toMatch(/--stores|--sample/);
    expect(joined[2]).toMatch(/oracle\/repo-recall\.mjs .*--bundle .*ruvnet-brain\.zip/);
    expect(joined[2]).toMatch(/--out .*ruvnet-brain\.zip\.recall\.json/);
    expect(joined[3]).toMatch(/corpus-candidate\.mjs/);
    expect(joined[3]).not.toMatch(/--verify/);
    expect(joined[3]).toMatch(/--accuracy-report .*ruvnet-brain\.zip\.accuracy\.json/);
    expect(joined[3]).toMatch(/--recall-report .*ruvnet-brain\.zip\.recall\.json/);
    expect(joined[4]).toMatch(/corpus-candidate\.mjs .*--verify/);
    expect(joined[4]).toMatch(/--recall-report .*ruvnet-brain\.zip\.recall\.json/);
    // ADR-0091 D7: the recall gate retires fixture repositories absent from THIS sealed observation, and
    // both corpus-candidate calls recompute that claim from the same coverage bytes rather than trust it.
    const sealedCoverage = path.join(root, 'data', 'source-coverage.json');
    for (const index of [2, 3, 4]) expect(calls[index].slice(calls[index].indexOf('--coverage'), calls[index].indexOf('--coverage') + 2))
      .toEqual(['--coverage', sealedCoverage]);
    expect(result.accuracyReportFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip.accuracy.json'));
    expect(result.recallReportFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip.recall.json'));
    expect(joined.join('\n')).not.toMatch(/corpus-seed-publish|release create|--publish|source-coverage\.mjs/);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data', 'source-coverage.json'), 'utf8'))).toEqual(coverage);
    expect(fs.readFileSync(path.join(root, 'docs', 'RUVNET-COVERAGE.md'), 'utf8')).toContain('alpha');
  });

  it('fails closed on any non-CURRENT eligible row, before ever shelling out to build or seal', () => {
    const root = candidateRoot();
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('STALE'), run,
    })).toThrow(/strict coverage/i);
    expect(calls).toHaveLength(0);
  });

  it('MUST BLOCK: no committed retrieval-accuracy oracle means nothing is assembled at all', () => {
    const root = candidateRoot({ oracle: false });
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('CURRENT'), run,
    })).toThrow(/retrieval-accuracy oracle missing/i);
    // Fails BEFORE the expensive single-pass assembly, not after it.
    expect(calls).toHaveLength(0);
  });

  it('a bounded measurement is opt-in and passes its bounds straight through to the benchmark', () => {
    const root = candidateRoot();
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('CURRENT'), accuracyStores: 2, accuracySamplePerPartition: 5, run,
    });
    const benchmark = calls.map((call) => call.join(' ')).find((call) => /retrieval-accuracy\.mjs/.test(call));
    expect(benchmark).toMatch(/--stores 2/);
    expect(benchmark).toMatch(/--sample 5/);
  });

  // ADR-0091 D2: accuracySample (CLI --accuracy-sample) is the whole-oracle question sample.
  it('accuracySample forwards --sample-questions, and omitting it runs the full, unsampled C3', () => {
    const root = candidateRoot();
    const benchmarkFor = (extra) => {
      const calls = [];
      const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
      prepareCorpusCandidate({
        root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
        candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
        receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
        coverageFile: path.join(root, 'data', 'source-coverage.json'),
        coverage: coverageFixture('CURRENT'), run, ...extra,
      });
      return calls.map((call) => call.join(' ')).find((call) => /retrieval-accuracy\.mjs/.test(call));
    };
    const sampled = benchmarkFor({ accuracySample: 80 });
    expect(sampled).toMatch(/--sample-questions 80/);
    expect(sampled).not.toMatch(/--sample 80/);
    const full = benchmarkFor({});
    expect(full).not.toMatch(/--sample/);
    expect(full).not.toMatch(/--stores/);
  });

  it('rejects a coverage object that is missing or not the real coverage shape', () => {
    const root = temp();
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
    })).toThrow(/already-measured coverage object/i);
  });

  // ADR-086 amendment (2026-09-15, commit a20727b7): C3's low score no longer blocks a corpus build.
  // scripts/corpus-candidate.mjs, scripts/release.mjs, and corpus-seed.yml all switched to
  // readDiagnosticAccuracyReport, which checks the report's integrity/archive binding, never its
  // score -- prepareCorpusCandidate was the one caller still missed, so it kept throwing on any
  // nonzero C3 exit and every full corpus build died there. These tests pin the fixed behavior: a
  // crashed measurement (no valid, archive-bound report) stays fatal; a low score does not.
  describe('C3 retrieval-accuracy is advisory, not blocking (ADR-086 amendment completion)', () => {
    // Builds a `run` mock that behaves like the real tool chain: the build-bundle.mjs call actually
    // writes bytes to the bundle zip (so fileIdentity(bundleFile) has something real to hash), and the
    // retrieval-accuracy.mjs call is intercepted so the test controls both its exit status and
    // whatever report file (if any) it leaves behind.
    const mockRun = ({ accuracyStatus, writeReport }) => {
      const calls = [];
      const run = (command, args) => {
        calls.push([command, ...args]);
        if (args.some((a) => /build-bundle\.mjs$/.test(a))) {
          const outIndex = args.indexOf('--out');
          const bundleFile = `${args[outIndex + 1]}.zip`;
          fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
          fs.writeFileSync(bundleFile, 'fixture-archive-bytes');
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args.some((a) => /oracle\/retrieval-accuracy\.mjs$/.test(a))) {
          const bundleIndex = args.indexOf('--bundle');
          const outIndex = args.indexOf('--out');
          const bundleFile = args[bundleIndex + 1];
          const reportFile = args[outIndex + 1];
          if (writeReport) writeReport({ bundleFile, reportFile });
          if (accuracyStatus !== 0) return { status: accuracyStatus, stdout: '', stderr: 'C3 below threshold' };
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      };
      return { run, calls };
    };

    const validReportFor = (bundleFile) => {
      const identity = { file: path.basename(bundleFile), sha256: crypto.createHash('sha256').update(fs.readFileSync(bundleFile)).digest('hex'), bytes: fs.statSync(bundleFile).size };
      return {
        schemaVersion: 2, kind: 'ruvnet-brain-retrieval-accuracy', state: 'FAIL', classification: 'diagnostic',
        c3Eligible: false, archive: { sha256: identity.sha256, bytes: identity.bytes, file: identity.file },
        oracle: {}, generator: {}, totals: { n: 1152, successes: 680 },
      };
    };

    it('C3 exits nonzero but writes a valid report bound to this archive: reconcile proceeds', () => {
      const root = candidateRoot();
      const { run, calls } = mockRun({
        accuracyStatus: 1,
        writeReport: ({ bundleFile, reportFile }) => fs.writeFileSync(reportFile, JSON.stringify(validReportFor(bundleFile))),
      });
      const result = prepareCorpusCandidate({
        root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
        candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
        receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
        coverageFile: path.join(root, 'data', 'source-coverage.json'),
        coverage: coverageFixture('CURRENT'), run,
      });
      // Proceeded all the way through the receipt build + verify steps that run AFTER the C3 call.
      const joined = calls.map((call) => call.join(' '));
      expect(joined.some((call) => /corpus-candidate\.mjs .*--verify/.test(call))).toBe(true);
      expect(result.accuracyReportFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip.accuracy.json'));
    });

    it('C3 exits nonzero with no report file at all: reconcile throws', () => {
      const root = candidateRoot();
      const { run } = mockRun({ accuracyStatus: 1 });
      expect(() => prepareCorpusCandidate({
        root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
        candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
        receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
        coverageFile: path.join(root, 'data', 'source-coverage.json'),
        coverage: coverageFixture('CURRENT'), run,
      })).toThrow(/crashed with no valid report/i);
    });

    it('C3 exits nonzero with a report bound to a DIFFERENT archive: reconcile throws', () => {
      const root = candidateRoot();
      const { run } = mockRun({
        accuracyStatus: 1,
        writeReport: ({ reportFile }) => {
          // Build a report bound to bytes that are NOT the real bundle's bytes.
          const decoyFile = path.join(root, 'decoy-archive.zip');
          fs.writeFileSync(decoyFile, 'not-the-real-archive');
          fs.writeFileSync(reportFile, JSON.stringify(validReportFor(decoyFile)));
        },
      });
      expect(() => prepareCorpusCandidate({
        root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
        candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
        receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
        coverageFile: path.join(root, 'data', 'source-coverage.json'),
        coverage: coverageFixture('CURRENT'), run,
      })).toThrow(/crashed with no valid report|not bound to this exact final archive/i);
    });

    it('deletes any stale leftover .accuracy.json before invoking the benchmark, so it cannot be mistaken for a fresh report', () => {
      const root = candidateRoot();
      const candidateDir = path.join(root, 'candidate', 'ruvnet-brain');
      const staleReportFile = `${candidateDir}.zip.accuracy.json`;
      fs.mkdirSync(path.dirname(staleReportFile), { recursive: true });
      fs.writeFileSync(staleReportFile, JSON.stringify({ stale: true }));
      let sawStaleAtInvocationTime = null;
      const { run } = mockRun({
        accuracyStatus: 0,
        writeReport: ({ reportFile }) => {
          sawStaleAtInvocationTime = fs.existsSync(reportFile);
          fs.writeFileSync(reportFile, JSON.stringify({ fresh: true }));
        },
      });
      prepareCorpusCandidate({
        root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
        candidateDir, receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
        coverageFile: path.join(root, 'data', 'source-coverage.json'),
        coverage: coverageFixture('CURRENT'), run,
      });
      expect(sawStaleAtInvocationTime).toBe(false);
      expect(JSON.parse(fs.readFileSync(staleReportFile, 'utf8'))).toEqual({ fresh: true });
    });
  });
});

describe('reconciliation output paths must never overlap the checkout, seed, or installed brain (rule 7)', () => {
  it('rejects an assets or workspace directory that is, contains, or is contained by the checkout kb build workspace', async () => {
    const root = temp();
    const kb = path.join(root, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    await expect(acquireCorpusGeneration({ assetsDir: kb, workspaceDir: path.join(root, 'work'), root }))
      .rejects.toThrow(/checkout kb build workspace/i);
    await expect(acquireCorpusGeneration({ assetsDir: path.join(root, 'assets'), workspaceDir: kb, root }))
      .rejects.toThrow(/checkout kb build workspace/i);
    await expect(acquireCorpusGeneration({ assetsDir: path.join(kb, 'nested'), workspaceDir: path.join(root, 'work'), root }))
      .rejects.toThrow(/checkout kb build workspace/i);
  });

  it('rejects a workspace directory that is, or is nested within, the assets directory', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    await expect(acquireCorpusGeneration({ assetsDir, workspaceDir: path.join(assetsDir, 'sub'), root }))
      .rejects.toThrow(/assets directory/i);
  });

  it('assertPathNotOverlapping fails closed on any direction of overlap, and passes clean, disjoint paths', () => {
    const root = temp();
    const forbidden = [{ label: 'the forbidden root', dir: path.join(root, 'forbidden') }];
    fs.mkdirSync(path.join(root, 'forbidden'), { recursive: true });
    expect(() => assertPathNotOverlapping('target', path.join(root, 'forbidden'), forbidden)).toThrow(/forbidden root/i);
    expect(() => assertPathNotOverlapping('target', path.join(root, 'forbidden', 'nested'), forbidden)).toThrow(/forbidden root/i);
    expect(() => assertPathNotOverlapping('target', root, forbidden)).toThrow(/forbidden root/i); // parent of forbidden
    expect(() => assertPathNotOverlapping('target', path.join(root, 'clean'), forbidden)).not.toThrow();
  });
});

describe('sealed-generation acquisition (acquireSealedGeneration)', () => {
  // The round-stability loop this replaced only returned when a fresh observation of the ENTIRE live
  // source universe hashed identically to the one it started with. Measured 2026-09-14/15: a round takes
  // about an hour, the hash covers each repository's updatedAt/pushedAt/diskUsage/head oid, and the org
  // pushes continuously -- so progress was unreliable under sustained churn and a local run died there
  // after refreshing 90 stores. Dual's ruling: freeze one discovery manifest, accept on completeness
  // against its immutable pins, and demote the closing observation to telemetry that cannot veto.
  const observationA = { observationSha256: 'a'.repeat(64) };
  const coverageStub = { schemaVersion: 1, coverageGeneration: 'g1', rows: [] };
  const noopLedger = () => ({ stores: {} });
  const seams = () => ({
    build: vi.fn(async () => coverageStub),
    execute: vi.fn(async () => ({ refreshed: [] })),
    prune: vi.fn(async () => ({ pruned: [] })),
    rebuild: vi.fn(async () => ({ rebuilt: [] })),
  });

  it('observes ONCE and accepts on completeness against the sealed manifest', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.observation).toEqual(observationA);
    expect(result.consistencyModel).toBe('sealed-acquisition-manifest/1');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('preflights sources before expensive execution and forwards verified capture for reuse', async () => {
    const order = [];
    const captured = { gists: { ['a'.repeat(32)]: { gistId: 'a'.repeat(32) } } };
    const f = seams();
    f.build = vi.fn(async () => { order.push('coverage'); return coverageStub; });
    f.execute = vi.fn(async () => { order.push('expensive'); return { refreshed: [] }; });
    f.rebuild = vi.fn(async (_coverage, _observation, _attempt, cache) => {
      order.push('rebuild');
      expect(cache).toBe(captured);
      return { rebuilt: [] };
    });
    await acquireSealedGeneration({ maxAttempts: 1, assetsDir: temp(), observe: async () => observationA,
      preflight: async () => { order.push('preflight'); return captured; }, readLedger: noopLedger, ...f });
    expect(order).toEqual(['preflight', 'coverage', 'expensive', 'rebuild', 'coverage']);
  });

  it('source preflight failure stops before coverage, cloning, or embedding work', async () => {
    const f = seams();
    await expect(acquireSealedGeneration({ maxAttempts: 1, assetsDir: temp(), observe: async () => observationA,
      preflight: async () => { throw Object.assign(new Error('gist detail HTTP 403'), { code: 'GIST_FORBIDDEN' }); },
      readLedger: noopLedger, ...f })).rejects.toMatchObject({ code: 'GIST_FORBIDDEN' });
    expect(f.build).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it('re-derives coverage AFTER rebuilding aggregates, against the same sealed observation', async () => {
    // The refactor to sealed acquisition originally dropped this, and a real 56-minute build died at
    // build-bundle with "coverage row gist:... was measured against different ruv-gists RVF bytes than
    // this corpus carries" -- the rows still pinned the PRE-rebuild aggregate digest. Coverage must be
    // recomputed after the rebuild, from the SAME observation (never a fresh one).
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const stale = { ...coverageStub, coverageGeneration: 'before-rebuild' };
    const settled = { ...coverageStub, coverageGeneration: 'after-rebuild' };
    let builds = 0;
    f.build = vi.fn(async () => { builds += 1; return builds === 1 ? stale : settled; });
    const result = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(builds).toBe(2);
    // The second argument is D5's per-store outcome record (empty here: nothing failed).
    expect(f.build).toHaveBeenNthCalledWith(1, observationA, {});
    expect(f.build).toHaveBeenNthCalledWith(2, observationA, {}); // same sealed observation, not a new one
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.coverage).toEqual(settled); // the post-rebuild coverage is what ships
  });

  it('MUST NOT restart when the universe keeps moving: continuous churn cannot invalidate a sealed generation', async () => {
    // Every call returns a DIFFERENT universe hash -- the exact condition that made the old loop fail
    // after exhausting its rounds. A sealed generation never re-observes, so it simply completes.
    let n = 0;
    const observe = vi.fn(async () => ({ observationSha256: String(n++).padStart(64, '0') }));
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('retries the SAME pinned inputs when a gist revision moves mid-fetch, without re-observing', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    let calls = 0;
    f.rebuild = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('gist moved');
        error.code = 'GIST_OBSERVATION_MOVED';
        error.gistId = 'g1';
        throw error;
      }
      return { rebuilt: ['concepts'] };
    });
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1); // the universe is never re-observed
    expect(calls).toBe(2);
    expect(result.attempts[0].retried).toMatchObject({ reason: expect.stringMatching(/gist revision moved/i), gistId: 'g1' });
    expect(result.observation).toEqual(observationA);
  });

  it('MUST BLOCK: an exhausted partial generation fails explicitly rather than being accepted', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    // One eligible source never reaches CURRENT: completeness against the manifest is unmet.
    f.build = vi.fn(async () => ({
      ...coverageStub,
      rows: [{
        kind: 'repository', disposition: 'eligible', status: 'STALE', name: 'x',
        url: 'https://github.com/ruvnet/x', upstream: { sha: 'a'.repeat(40) },
        artifact: { store: 'x', sourceCommit: 'b'.repeat(40) },
      }],
    }));
    await expect(acquireSealedGeneration({
      maxAttempts: 2, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    })).rejects.toThrow(/sealed generation incomplete after 2 acquisition attempt\(s\).*unresolved against the sealed manifest/is);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('reports freshness as telemetry only: a moved universe is recorded, never a veto', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
      closingObservation: async () => ({ observationSha256: 'f'.repeat(64) }),
    });
    expect(result.freshness).toMatchObject({ checkStatus: 'NEWER_REVISION_OBSERVED', closingObservationSha256: 'f'.repeat(64) });
    expect(result.coverage).toEqual(coverageStub); // accepted regardless
  });

  it('a failed or absent closing observation yields UNKNOWN freshness and still accepts', async () => {
    const observe = vi.fn(async () => observationA);
    const failing = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...seams(),
      closingObservation: async () => { throw new Error('rate limited'); },
    });
    expect(failing.freshness).toMatchObject({ checkStatus: 'UNKNOWN', reason: expect.stringMatching(/rate limited/) });
    const absent = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...seams(),
    });
    expect(absent.freshness).toMatchObject({ checkStatus: 'UNKNOWN', reason: expect.stringMatching(/no closing observation/) });
  });
});

describe('positive-selection pruning (pruneIneligibleStores) — required proof 5', () => {
  it('removes a store\'s full artifact family and ledger/SOURCE entries once it is no longer eligible', () => {
    const assetsDir = temp();
    for (const store of ['alpha', 'beta']) {
      for (const name of ['big.rvf', 'big.rvf.idmap.json', 'big.rvf.embed.json', 'passages.jsonl', 'meta.json']) {
        fs.writeFileSync(path.join(assetsDir, `${store}.${name}`), 'x');
      }
    }
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      beta: { file: 'beta.big.rvf', sourceCommit: sha('b') },
      'ruv-gists': { file: 'ruv-gists.big.rvf', sourceCommit: null },
    } }));
    fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), JSON.stringify({ stores: {
      alpha: { sourceCommit: sha('a') }, beta: { sourceCommit: sha('b') },
    } }));

    // beta was eligible in a prior round (present in ledger + SOURCE + on disk) but is no longer
    // eligible this round (removed from policy, gone private, or deleted upstream) -- it must not
    // linger in the finalized corpus.
    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] });

    expect(result.pruned).toEqual(['beta']);
    for (const name of ['big.rvf', 'big.rvf.idmap.json', 'big.rvf.embed.json', 'passages.jsonl', 'meta.json']) {
      expect(fs.existsSync(path.join(assetsDir, `beta.${name}`))).toBe(false);
      expect(fs.existsSync(path.join(assetsDir, `alpha.${name}`))).toBe(true);
    }
    const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(Object.keys(ledger.stores).sort()).toEqual(['alpha', 'ruv-gists']);
    const source = JSON.parse(fs.readFileSync(path.join(assetsDir, 'SOURCE.json'), 'utf8'));
    expect(Object.keys(source.stores)).toEqual(['alpha']);
  });

  it('never prunes ruv-gists or concepts, and no-ops cleanly when there is nothing stale', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      'ruv-gists': { file: 'ruv-gists.big.rvf', sourceCommit: null },
      concepts: { file: 'concepts.big.rvf', sourceCommit: null },
    } }));
    expect(pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] })).toEqual({ pruned: [] });
  });

  it('no-ops cleanly when the ledger does not exist yet (nothing to prune)', () => {
    expect(pruneIneligibleStores({ assetsDir: temp(), eligibleStores: [] })).toEqual({ pruned: [] });
  });
});

describe('legacy provenance is preserved distinctly from current-round rebuilds — required proof 6', () => {
  it('pruning never touches a still-eligible store, whether legacy-reused or freshly rebuilt this round', () => {
    const assetsDir = temp();
    const legacyGeneration = { file: 'alpha.big.rvf', sourceCommit: sha('a'),
      builtUtc: '2026-01-01T00:00:00.000Z', model: 'legacy-model' };
    const freshGeneration = { file: 'beta.big.rvf', sourceCommit: sha('b'),
      builtUtc: '2026-09-13T00:00:00.000Z', model: 'fresh-model' };
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({
      stores: { alpha: legacyGeneration, beta: freshGeneration },
    }));
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'legacy-bytes');
    fs.writeFileSync(path.join(assetsDir, 'beta.big.rvf'), 'fresh-bytes');

    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha', 'beta'] });

    expect(result).toEqual({ pruned: [] });
    const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    // The legacy row is preserved byte-for-byte -- pruning must never re-stamp or reclassify a
    // still-eligible store's generation record just because a round ran, which is exactly what
    // would erase the distinction between "verified this round" and "legacy, already verified".
    expect(ledger.stores.alpha).toEqual(legacyGeneration);
    expect(ledger.stores.beta).toEqual(freshGeneration);
  });

  it('a seed\'s bootstrap fence evidence is untouched by reconciliation pruning', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'SEED-PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
    fs.writeFileSync(path.join(assetsDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
    const before = seedPrivateFenceEvidence(assetsDir);
    expect(before).not.toBeNull();

    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      ghost: { file: 'ghost.big.rvf', sourceCommit: sha('c') },
    } }));
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'x');
    fs.writeFileSync(path.join(assetsDir, 'ghost.big.rvf'), 'x');

    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] });

    expect(result.pruned).toEqual(['ghost']);
    expect(fs.existsSync(path.join(assetsDir, 'ghost.big.rvf'))).toBe(false);
    // The bootstrap-fence distinction Step 1 established (seedPrivateFenceEvidence /
    // bootstrapIdentity) must never be weakened or bypassed by the new positive-selection prune.
    expect(seedPrivateFenceEvidence(assetsDir)).toEqual(before);
  });
});

describe('standalone workflow boundary', () => {
  it('binds preparation to the resolved approved SHA on main\'s history, plus tag/digest, and leaves publication to protected-release', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/corpus-seed.yml'), 'utf8');
    expect(workflow).toContain('candidate_sha:');
    expect(workflow).toContain('seed_tag:');
    expect(workflow).toContain('seed_sha256:');
    expect(workflow).toContain('ref: ${{ inputs.candidate_sha }}');
    // 2026-09-29 nightly redesign: the approved runtime's source is on main's history (ancestry), not
    // main HEAD. It must still BE the newest install-verified release's sourceSha (ADR-0091 D3); an
    // older runtime over a newer live release is refused at publish time (release.mjs --approved-tag).
    expect(workflow).not.toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$EXPECTED_SHA" origin/main');
    expect(workflow).toContain('node scripts/approved-runtime.mjs --resolve --repo "$GITHUB_REPOSITORY"');
    expect(workflow).toContain('test "$approved_sha" = "$EXPECTED_SHA"');
    expect(workflow).toContain('gh release download "$SEED_TAG"');
    expect(workflow).toContain('node scripts/corpus-reconcile.mjs');
    expect(workflow).toContain('kb/PRIVATE-STORES.json');
    expect(workflow).not.toMatch(/releases\/latest|download\/latest|\brelease create\b|node scripts\/corpus-seed-publish\.mjs/);
    expect(workflow).toMatch(/protected-release\.yml/);
  });
});

// ADR-0091 D1. main()'s last line read `reconciliation.rounds` for weeks after cd0f032f renamed the
// history to `attempts`, so every corpus-publish run threw "Cannot read properties of undefined
// (reading 'flatMap')" AFTER acquiring the whole generation. Nothing called main(), so nothing noticed.
// This drives main() end to end: a real seed zip, the real bootstrap identity check, extraction,
// normalization, fence copy and input sync, then the REAL reconcileAndPrepareCorpusCandidate over the
// REAL acquireSealedGeneration -- so the history main() summarizes is shaped by its actual producer,
// not by a hand-written fixture. Only network observation, cloning/embedding and assembly are stubbed.
describe('main() end to end (ADR-0091 D1)', () => {
  const seedFixture = ({ ledgerText = SEED_LEDGER } = {}) => {
    const dir = temp();
    const root = path.join(dir, 'checkout');
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'PRIVATE-STORES.json'), '{"privateStores":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'external-sources.json'), '{"sources":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'no-corpus-repos.json'), '{"repos":[]}');
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(path.join(stage, 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'ruvnet-brain', 'RVF-GENERATIONS.json'), ledgerText);
    fs.writeFileSync(path.join(stage, 'ruvnet-brain', 'alpha.big.rvf'), 'seed rvf bytes');
    const archive = path.join(dir, 'seed.zip');
    execFileSync('zip', ['-q', '-r', archive, 'ruvnet-brain'], { cwd: stage });
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const argv = ['--root', root, '--seed-archive', archive, '--seed-tag', `corpus-sha256-${digest}`,
      '--seed-sha256', digest, '--assets', path.join(dir, 'assets'), '--workspace', path.join(dir, 'workspace'),
      '--builder-sha', sha('f')];
    return { dir, root, argv, assets: path.join(dir, 'assets') };
  };

  // One stale eligible repository: attempt 1 plans it, "refreshes" it into the ledger, and the settled
  // coverage then reports it CURRENT, so the real sealed-generation loop accepts on its first attempt.
  const drive = () => {
    const ledger = { stores: {} };
    const row = () => ({ ...repo({ name: 'alpha', upstream: sha('a') }),
      status: ledger.stores.alpha ? 'CURRENT' : 'STALE' });
    const seen = {};
    const reconcileAndPrepare = (options) => reconcileAndPrepareCorpusCandidate({
      ...options,
      reconcile: ({ maxAttempts }) => acquireSealedGeneration({
        maxAttempts,
        observe: async () => ({ observationSha256: 'b'.repeat(64) }),
        build: async () => coverage([row()]),
        readLedger: () => ledger,
        execute: async (plan) => {
          for (const entry of plan) ledger.stores[entry.store] = { sourceCommit: entry.upstreamSha };
          return { refreshed: plan.map((entry) => entry.store) };
        },
        prune: async () => ({ pruned: ['retired-store'] }),
        rebuild: async () => ({ rebuilt: ['concepts', 'ruv-gists'] }),
      }),
      normalizeUpdaters: (input) => { seen.refreshedStores = input.refreshedStores; return { missing: [] }; },
      prepare: () => ({ bundleFile: 'candidate.zip', receiptFile: 'candidate.receipt.json' }),
    });
    return { reconcileAndPrepare, seen };
  };

  it('completes, exits 0 and prints the plan summarized from the real acquisition history', async () => {
    const fixture = seedFixture();
    const { reconcileAndPrepare, seen } = drive();
    let printed = '';
    const code = await main(fixture.argv, { reconcileAndPrepare, stdout: { write: (text) => { printed += text; } } });

    expect(code).toBe(0);
    const output = JSON.parse(printed);
    expect(output.ok).toBe(true);
    expect(output.plan).toEqual([expect.objectContaining({ store: 'alpha', upstreamSha: sha('a'), reason: 'missing ledger receipt' })]);
    expect(output.reconciliation.attempts).toHaveLength(1);
    expect(output.bundleFile).toBe('candidate.zip');
    // The updater normalization step reads the same history through the same reader.
    expect(seen.refreshedStores).toEqual(['alpha']);
    // The real bootstrap steps ran before reconciliation, not a shortcut around them.
    expect(fs.existsSync(path.join(fixture.assets, 'PRIVATE-STORES.json'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.assets, 'external-sources.json'))).toBe(true);
    expect(fs.readFileSync(path.join(fixture.assets, 'alpha.big.rvf'), 'utf8')).toBe('seed rvf bytes');
  });

  it('summarizeReconciliation reads every attempt, and names a result that has no attempts array', async () => {
    const history = { observation: { observationSha256: 'c'.repeat(64) }, attempts: [
      { plan: [{ store: 'alpha' }], refreshed: ['alpha'], pruned: [], rebuilt: [] },
      { plan: [{ store: 'beta' }], refreshed: ['beta'], pruned: ['old'], rebuilt: ['concepts'] },
    ] };
    expect(summarizeReconciliation(history)).toEqual({
      attempts: 2, observationSha256: 'c'.repeat(64),
      plan: [{ store: 'alpha' }, { store: 'beta' }], refreshed: ['alpha', 'beta'], pruned: ['old'], rebuilt: ['concepts'],
      degraded: { carried: [], missing: [] },
    });
    // The pre-cd0f032f shape must fail by name, never as a bare TypeError at the end of a generation.
    expect(() => summarizeReconciliation({ observation: {}, rounds: [] }))
      .toThrow(/no attempts array \(keys: observation, rounds\)/);
  });

  it(`exits ${SEED_LEDGER_INCOMPATIBLE_EXIT} on an incompatible seed ledger, before reconciling, with --assets left untouched (ADR-0091 D4)`, async () => {
    const fixture = seedFixture({ ledgerText: '{"schemaVersion":1,"stores":{}}' });
    let reconciled = false;
    let err = '';
    const code = await main(fixture.argv, {
      reconcileAndPrepare: () => { reconciled = true; throw new Error('must not reconcile an unconsumable seed'); },
      stdout: { write: () => {} }, stderr: { write: (text) => { err += text; } },
    });
    expect(SEED_LEDGER_INCOMPATIBLE_EXIT).toBe(3);
    expect(code).toBe(3);
    expect(reconciled).toBe(false);
    expect(err).toMatch(/seed ledger is incompatible with this runtime: RVF-GENERATIONS\.json is schemaVersion 1/);
    expect(err).toMatch(/exiting 3 so the caller can fall back to the committed bootstrap seed/);
    // The same --assets path is immediately reusable by the bootstrap retry, and no extraction debris is left.
    expect(fs.existsSync(fixture.assets)).toBe(false);
    expect(fs.readdirSync(fixture.dir).filter((name) => name.startsWith('.corpus-seed-extract-'))).toEqual([]);

    // ...and the retry: the same main(), same --assets, now a compatible seed, runs to completion.
    const retry = seedFixture();
    const { reconcileAndPrepare } = drive();
    const argv = [...retry.argv];
    argv[argv.indexOf('--assets') + 1] = fixture.assets;
    expect(await main(argv, { reconcileAndPrepare, stdout: { write: () => {} } })).toBe(0);
    expect(fs.readFileSync(path.join(fixture.assets, 'alpha.big.rvf'), 'utf8')).toBe('seed rvf bytes');
  });
});
