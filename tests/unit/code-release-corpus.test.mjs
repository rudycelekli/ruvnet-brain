// ADR-0091 D6 — a code release built from the newest corpus generation.
//
// Proves, with a recording process seam (no network, no real build):
//   * the path is chosen ONLY by where the seed came from, and neither path collapses into the other;
//   * the single-pass path never runs the capability-only refresh or the index repair, builds once,
//     feeds the generation's sealed coverage, restores the committed coverage, and FAILS if anything
//     mutated the sealed generation or shipped different store bytes;
//   * the bootstrap still runs the full legacy two-pass sequence, in order;
//   * the publish-time guard refuses a newer generation, and refuses when it cannot prove there is none.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEGACY_TWO_PASS, SINGLE_PASS, assembleCodeReleaseCorpus, assemblyPathFor, assertNoNewerCorpusGeneration,
  assertStoresUnmutated, checkNoNewerCorpusGeneration,
} from '../../scripts/code-release-corpus.mjs';
import { createCoverageReceipt } from '../../scripts/corpus-coverage-sidecar.mjs';
import { writeCoverageFor } from '../helpers/corpus-seed-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const GEN_SHA = 'd'.repeat(64);
const generationDescriptor = (extra = {}) => ({ origin: 'published-generation', tag: `corpus-sha256-${GEN_SHA}`,
  asset: 'ruvnet-brain.zip', sha256: GEN_SHA, bytes: 1234, coverage: { sha256: 'e'.repeat(64) }, ...extra });
const bootstrapDescriptor = { origin: 'committed-bootstrap', tag: 'v4.3.26', asset: 'ruvnet-brain.zip', // sync-version-ignore: bootstrap tag
  sha256: '9'.repeat(64), bytes: 555545135 };

describe('assemblyPathFor — the one place the dual path is chosen (ADR-0091 D6.1)', () => {
  it('a published generation assembles single-pass; the committed bootstrap keeps the legacy two-pass path', () => {
    expect(assemblyPathFor(generationDescriptor())).toBe(SINGLE_PASS);
    expect(assemblyPathFor(bootstrapDescriptor)).toBe(LEGACY_TWO_PASS);
  });
  it.each([
    ['a generation resolved without its coverage sidecar', generationDescriptor({ coverage: undefined }), /--require-coverage/],
    ['a generation whose tag is not its own digest', generationDescriptor({ sha256: 'c'.repeat(64) }), /does not name its own digest/],
    ['a "bootstrap" wearing a generation tag', { ...bootstrapDescriptor, tag: `corpus-sha256-${GEN_SHA}` }, /pinned pre-ADR-0091 tag/],
    ['a descriptor with no origin (a copied data/corpus-seed.json)', { tag: 'v4.3.26', sha256: '9'.repeat(64) }, /no recognised origin/], // sync-version-ignore: bootstrap tag
  ])('refuses %s instead of defaulting to either path', (_label, descriptor, pattern) => {
    expect(() => assemblyPathFor(descriptor)).toThrow(pattern);
  });
});

/** A generation directory, its coverage + sidecar, a fake repo root, and a recording `run`. */
async function scenario({ onBuild = null } = {}) {
  const root = tmp('code-release-root-');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(root, 'data', 'source-coverage.json'), '{"committed":true}\n');
  const assets = tmp('code-release-seed-');
  const files = { 'alpha.big.rvf': 'rvf-bytes', 'alpha.passages.jsonl': '{"id":1}\n', 'alpha.meta.json': '{}',
    'alpha.big.rvf.idmap.json': '{}', 'alpha.big.rvf.embed.json': '{}' };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(assets, name), body);
  fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: { sha256: sha('rvf-bytes') } } }));
  const receipt = { stores: [{ name: 'alpha', kind: 'repository', sourceCommit: 'a'.repeat(40),
    files: [{ file: 'alpha.big.rvf', sha256: sha('rvf-bytes'), bytes: 9 }] }] };
  const coverageFile = path.join(tmp('code-release-cov-'), 'CORPUS-COVERAGE.json');
  await writeCoverageFor(receipt, coverageFile);
  const coverageBytes = fs.readFileSync(coverageFile);
  const descriptor = generationDescriptor({ coverage: { sha256: sha(coverageBytes) } });
  const coverageReceiptFile = path.join(path.dirname(coverageFile), 'coverage-receipt.json');
  fs.writeFileSync(coverageReceiptFile, JSON.stringify(createCoverageReceipt({ generationTag: descriptor.tag,
    archiveSha256: GEN_SHA, archiveBytes: 1234, coverageBytes })));
  const evidence = tmp('code-release-evidence-');
  const calls = [];
  const coverageSeenByBuild = [];
  const run = (command, args) => {
    const script = path.basename(String(args[0] || command));
    calls.push({ command, script, args });
    if (args.includes('observe-baseline')) fs.writeFileSync(args[args.indexOf('--out') + 1], '{"observed":true}');
    if (script === 'build-bundle.mjs') {
      coverageSeenByBuild.push(fs.readFileSync(path.join(root, 'data', 'source-coverage.json'), 'utf8'));
      const out = path.join(root, 'dist', 'ruvnet-brain');
      fs.mkdirSync(out, { recursive: true });
      for (const name of [...Object.keys(files), 'RVF-GENERATIONS.json']) fs.copyFileSync(path.join(assets, name), path.join(out, name));
      onBuild?.({ assets, out });
    }
    return { status: 0 };
  };
  return { root, assets, descriptor, coverageFile, coverageReceiptFile, evidence, calls, coverageSeenByBuild, coverageBytes, run };
}

const assemble = (s, descriptor = s.descriptor) => assembleCodeReleaseCorpus({ root: s.root, descriptor,
  seedBundle: '/seed/ruvnet-brain.zip', assetsDir: s.assets, evidenceDir: s.evidence, coverageFile: s.coverageFile,
  coverageReceiptFile: s.coverageReceiptFile, run: s.run, env: { GITHUB_SHA: 'f'.repeat(40) } });

describe('single-pass assembly from a corpus generation (ADR-0091 D6.1 / V6a)', () => {
  it('builds ONCE from the sealed coverage with no capability-only refresh and no index repair', async () => {
    const s = await scenario();
    const result = assemble(s);
    expect(result.mode).toBe(SINGLE_PASS);
    expect(s.calls.map(({ script }) => script)).toEqual(['public-verification-inputs.mjs', 'build-bundle.mjs']);
    const flat = s.calls.flatMap(({ args }) => args).join(' ');
    expect(flat).not.toMatch(/refresh-capability-only-store|rvf-index-audit|--repair|--legacy-seed-projection|release-projection/);
    const build = s.calls.find(({ script }) => script === 'build-bundle.mjs').args;
    expect(build).toEqual(expect.arrayContaining(['--seed-tag', s.descriptor.tag, '--seed-sha256', GEN_SHA, '--seed-bytes', '1234']));
    expect(build[build.indexOf('--baseline-receipt-sha256') + 1]).toBe(sha('{"observed":true}'));
    // The observed baseline is judged against the seed's OWN published tag (D6.3).
    const observe = s.calls[0].args;
    expect(observe[observe.indexOf('--expected-tag') + 1]).toBe(s.descriptor.tag);
    // The build read the generation's coverage; the committed file was restored afterwards.
    expect(s.coverageSeenByBuild).toEqual([s.coverageBytes.toString('utf8')]);
    expect(fs.readFileSync(path.join(s.root, 'data', 'source-coverage.json'), 'utf8')).toBe('{"committed":true}\n');
    expect(result.unmutated).toEqual({ stores: 1, files: 5 });
  });

  it('RED: anything that rewrites the sealed generation during assembly (e.g. a capability-only refresh) fails the build', async () => {
    const s = await scenario({ onBuild: ({ assets }) => fs.writeFileSync(path.join(assets, 'alpha.passages.jsonl'), 'rewritten\n') });
    expect(() => assemble(s)).toThrow(/sealed generation directory was modified/);
    expect(fs.readFileSync(path.join(s.root, 'data', 'source-coverage.json'), 'utf8')).toBe('{"committed":true}\n');
  });

  it('RED: an assembly that ships store bytes other than the generation\'s fails the build', async () => {
    const s = await scenario({ onBuild: ({ out }) => fs.writeFileSync(path.join(out, 'alpha.big.rvf'), 'repaired-index-bytes') });
    expect(() => assemble(s)).toThrow(/assembly changed 1 store file\(s\) the generation sealed: alpha\.big\.rvf/);
  });

  it('RED: coverage that is not the one the resolver sealed is refused before any build', async () => {
    const s = await scenario();
    expect(() => assemble(s, { ...s.descriptor, coverage: { sha256: '0'.repeat(64) } })).toThrow(/not the coverage the resolver sealed/);
    expect(s.calls).toEqual([]);
  });
});

describe('the committed bootstrap keeps the legacy two-pass projection (ADR-0091 D6.1 / V6b)', () => {
  it('runs the full pre-D6 sequence, in order: deps, capability-only refresh, index repair, observe, build, project, build', async () => {
    const s = await scenario();
    const result = assemble(s, bootstrapDescriptor);
    expect(result.mode).toBe(LEGACY_TWO_PASS);
    expect(s.calls.map(({ command, script }) => (command === 'npm' ? 'npm' : script))).toEqual([
      'npm', 'refresh-capability-only-store.mjs', 'rvf-index-audit.mjs', 'public-verification-inputs.mjs',
      'build-bundle.mjs', 'release-projection.mjs', 'build-bundle.mjs',
    ]);
    expect(s.calls[2].args).toContain('--repair');
    for (const build of s.calls.filter(({ script }) => script === 'build-bundle.mjs')) expect(build.args).toContain('--legacy-seed-projection');
    expect(s.calls.at(-1).args).toEqual(expect.arrayContaining(['--coverage', '--projection']));
  });
});

describe('assertStoresUnmutated', () => {
  it('refuses a store set that differs from the generation\'s', async () => {
    const s = await scenario();
    const out = path.join(s.root, 'dist', 'ruvnet-brain');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {}, beta: {} } }));
    expect(() => assertStoresUnmutated({ seedDir: s.assets, bundleDir: out })).toThrow(/store set differs/);
  });
});

describe('publish-time backward-move guard (ADR-0091 D6.6 / V6c)', () => {
  const sealed = generationDescriptor();
  const seedOf = (seed, rejected = []) => ({ seed, rejected });
  it('passes when the newest compatible generation is still the one release QE sealed', () => {
    expect(checkNoNewerCorpusGeneration({ sealed, resolution: seedOf({ ...sealed }) })).toEqual({ origin: sealed.origin, tag: sealed.tag });
    expect(checkNoNewerCorpusGeneration({ sealed: bootstrapDescriptor, resolution: seedOf({ ...bootstrapDescriptor }) }).tag).toBe('v4.3.26'); // sync-version-ignore: bootstrap tag
  });
  it('REFUSES when a newer generation shipped after QE, naming it and asking for QE to be re-run', () => {
    const newer = { ...sealed, tag: `corpus-sha256-${'7'.repeat(64)}`, sha256: '7'.repeat(64) };
    expect(() => checkNoNewerCorpusGeneration({ sealed, resolution: seedOf(newer) }))
      .toThrow(new RegExp(`corpus generation ${newer.tag} published after this release was QE'd from ${sealed.tag}; re-run release QE`));
    // QE fell back to the bootstrap, then the FIRST generation shipped: that is a backward move too.
    expect(() => checkNoNewerCorpusGeneration({ sealed: bootstrapDescriptor, resolution: seedOf(newer) })).toThrow(/re-run release QE/);
  });
  it('REFUSES when it cannot prove nothing newer exists (a failed list/view/download is not "nothing newer")', () => {
    const resolution = seedOf({ ...sealed }, [{ tag: null, reason: 'release list failed (network down)', indeterminate: true }]);
    expect(() => checkNoNewerCorpusGeneration({ sealed, resolution })).toThrow(/cannot prove no newer corpus generation/);
  });
  it('REFUSES a sealed descriptor that did not come from the resolver', () => {
    expect(() => checkNoNewerCorpusGeneration({ sealed: { tag: 'v4.3.26', sha256: '9'.repeat(64) }, resolution: seedOf(bootstrapDescriptor) })) // sync-version-ignore: bootstrap tag
      .toThrow(/carries no resolver origin/);
  });
  it('re-resolves in code-release mode (requireCoverage) from the sealed file', async () => {
    const file = path.join(tmp('guard-'), 'corpus-seed.json');
    fs.writeFileSync(file, JSON.stringify(sealed));
    const asked = [];
    const newer = { ...sealed, tag: `corpus-sha256-${'7'.repeat(64)}`, sha256: '7'.repeat(64) };
    await expect(assertNoNewerCorpusGeneration({ sealedFile: file, repo: 'o/r',
      resolve: async (options) => { asked.push(options); return seedOf(newer); } })).rejects.toThrow(/re-run release QE/);
    expect(asked).toEqual([expect.objectContaining({ repo: 'o/r', requireCoverage: true })]);
  });
});
