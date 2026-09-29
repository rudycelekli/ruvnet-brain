// ADR-0091 D4 / V4 -- the rehearsal's seed-selection machinery, proven on small fixtures before the
// real rehearsal relies on it: the local registry + fake gh drive the REAL corpus-next-seed resolver,
// the decoys are skipped for their own reasons without an archive download, and the checkout-traced
// pin makes the REAL verifyApprovedRuntime fail when a seed executable leaks into a candidate.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkoutRuntimePin, nextPatchVersion, registerGeneration, registerIncompatibleDecoys, registryGh, uploadedFilesOf,
} from '../../scripts/rehearse-seed-selection.mjs';
import { resolveNextCorpusSeed } from '../../scripts/corpus-next-seed.mjs';
import { emitApprovedRuntime, isRuntimeFile, verifyApprovedRuntime } from '../../scripts/approved-runtime.mjs';
import { loadFixture, tally } from '../../scripts/oracle/repo-recall.mjs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-seed-selection-')); dirs.push(dir); return dir; };
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const MODEL = 'Xenova/bge-base-en-v1.5';

/** A small real-shaped published generation: archive bytes, receipt, both reports. */
function builtGeneration(dir) {
  const zip = path.join(dir, 'ruvnet-brain.zip');
  fs.writeFileSync(zip, 'a sealed corpus archive, in miniature');
  const archive = { file: 'ruvnet-brain.zip', sha256: sha(fs.readFileSync(zip)), bytes: fs.statSync(zip).size };
  const rows = [{ store: 'alpha', expectedPath: 'README.md', repoCovered: true, exactFileRank: 1, returnedPaths: [] }];
  const recallFile = `${zip}.recall.json`;
  fs.writeFileSync(recallFile, JSON.stringify({ schemaVersion: 1, kind: 'ruvnet-brain-repo-recall', archive,
    fixture: { sha256: loadFixture().fixtureSha256, questionCount: 1 }, totals: tally(rows), rows }));
  const accuracyFile = `${zip}.accuracy.json`;
  fs.writeFileSync(accuracyFile, '{}');
  const receiptFile = path.join(dir, 'corpus-receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({
    schemaVersion: 3, kind: 'ruvnet-brain-corpus-candidate', builderSourceSha: 'c'.repeat(40), archive,
    accuracyReport: { file: 'ruvnet-brain.zip.accuracy.json', sha256: sha(fs.readFileSync(accuracyFile)), bytes: 2 },
    recallReport: { file: 'ruvnet-brain.zip.recall.json', sha256: sha(fs.readFileSync(recallFile)), bytes: fs.statSync(recallFile).size },
    stores: [{ name: 'alpha', model: MODEL, dimensions: 768 }, { name: 'beta', model: MODEL, dimensions: 768 }],
    archiveManifestVersion: '4.3.34', archiveManifestReleaseTag: 'v4.3.34', // sync-version-ignore: fixture older runtime identity
  }));
  return { zip, receiptFile, recallFile, accuracyFile, ...archive };
}

function checkoutWithBootstrap() {
  const root = temp();
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'corpus-seed.json'), JSON.stringify({
    schemaVersion: 1, tag: 'v4.3.26', asset: 'ruvnet-brain.zip', sha256: '9'.repeat(64), bytes: 1, // sync-version-ignore: bootstrap tag
  }));
  return root;
}

describe('the rehearsal registry drives the REAL resolver (ADR-0091 V4)', () => {
  it('skips both decoys for their own reasons, never downloads an archive, and selects the real generation', async () => {
    const work = temp();
    const registryDir = path.join(work, 'registry');
    fs.mkdirSync(registryDir);
    fs.mkdirSync(path.join(work, 'gen1'));
    const real = builtGeneration(path.join(work, 'gen1'));
    const tag = `corpus-sha256-${real.sha256}`;
    const createdAtMs = Date.parse('2026-09-28T00:00:00Z');
    const release = registerGeneration({ registryDir, tag, createdAt: new Date(createdAtMs).toISOString(),
      files: [real.zip, real.receiptFile, real.recallFile, real.accuracyFile] });
    expect(release.signaturePlaceholder).toBe(true);
    const decoys = registerIncompatibleDecoys({ registryDir, createdAtMs, scratchDir: path.join(work, 'decoys'),
      real: { sha256: real.sha256, bytes: real.bytes, receiptFile: real.receiptFile, recallFile: real.recallFile, accuracyFile: real.accuracyFile } });

    const gh = registryGh(registryDir);
    const { seed, rejected } = await resolveNextCorpusSeed({ repo: 'o/r', root: checkoutWithBootstrap(), run: gh.run, runtimeRoot: REPO_ROOT });
    expect(seed).toMatchObject({ origin: 'published-generation', tag, sha256: real.sha256, bytes: real.bytes, brainVersion: '4.3.34' }); // sync-version-ignore: fixture
    const model = decoys.find(({ kind }) => kind === 'model-mismatch');
    const fixture = decoys.find(({ kind }) => kind === 'fixture-mismatch');
    expect(rejected.find((row) => row.tag === model.tag).reason).toMatch(/^incompatible: 1 store\(s\) embedded with a different model/);
    expect(rejected.find((row) => row.tag === fixture.tag).reason).toMatch(/^incompatible: recall report was measured against fixture/);
    expect(gh.archiveDownloadAttempts()).toEqual([]);
    expect(gh.downloads().some((line) => line.includes(model.tag) && line.includes('recall.json'))).toBe(false);
    expect(gh.downloads().some((line) => line.includes(fixture.tag) && line.includes('recall.json'))).toBe(true);
  });

  it('the registry refuses an archive download and records the attempt', () => {
    const registryDir = temp();
    registerGeneration({ registryDir, tag: 't', createdAt: '2026-09-28T00:00:00Z', declared: { 'ruvnet-brain.zip': 5 } });
    const gh = registryGh(registryDir);
    expect(gh.run('gh', ['release', 'download', 't', '--pattern', 'ruvnet-brain.zip', '--dir', temp()]).status).toBe(1);
    expect(gh.archiveDownloadAttempts()).toHaveLength(1);
  });

  it('uploadedFilesOf keeps only the existing-file arguments of a recorded release create', () => {
    const dir = temp();
    const file = path.join(dir, 'ruvnet-brain.zip');
    fs.writeFileSync(file, 'x');
    expect(uploadedFilesOf(['release', 'create', 'corpus-sha256-x', '--notes', 'Archive SHA-256: ...', file, path.join(dir, 'missing.json')]))
      .toEqual([file]);
  });

  it('nextPatchVersion bumps x.y.z and refuses anything else', () => {
    expect(nextPatchVersion('4.3.34')).toBe('4.3.35'); // sync-version-ignore: fixture versions
    expect(() => nextPatchVersion('4.3.34-dev')).toThrow(/non x\.y\.z/); // sync-version-ignore: fixture version
  });
});

describe('checkoutRuntimePin: a seed executable that leaks into a candidate is caught by verifyApprovedRuntime', () => {
  const api = { isRuntimeFile, emitApprovedRuntime };
  const fixture = () => {
    const root = temp();
    const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
    write('kb/forge-ask.mjs', 'export const ask = 1;\n');
    write('kb/package.json', '{"version":"4.3.35"}\n'); // sync-version-ignore: fixture checkout runtime
    write('scripts/verify-bundle.mjs', 'export const verify = 1;\n');
    write('keys/ruvnet-brain-signing.pub.pem', 'PEM\n');
    const row = (archivePath, text) => ({ path: archivePath, sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) });
    const clean = [
      row('forge-ask.mjs', 'export const ask = 1;\n'),
      row('package.json', '{"version":"4.3.35"}\n'), // sync-version-ignore: fixture
      row('verify-bundle.mjs', 'export const verify = 1;\n'),
      row('keys/ruvnet-brain-signing.pub.pem', 'PEM\n'),
      row('alpha.big.rvf', 'corpus bytes are not runtime'),
    ];
    const manifest = (files) => ({ schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version: '4.3.35', releaseTag: 'v4.3.35', files }); // sync-version-ignore: fixture
    return { root, row, clean, manifest };
  };

  it('PASS: every runtime file traces to the checkout', () => {
    const { root, clean, manifest } = fixture();
    const { pin, traced, untraced } = checkoutRuntimePin({ checkoutRoot: root, manifest: manifest(clean), approvedCodeSha: 'a'.repeat(40), version: '4.3.35', api }); // sync-version-ignore: fixture
    expect(traced).toBe(4);
    expect(untraced).toEqual([]);
    expect(verifyApprovedRuntime({ manifest: manifest(clean), pin }).verdict).toBe('PASS');
  });

  it('FAIL: a seed-only module in the candidate is unpinned and named', () => {
    const { root, row, clean, manifest } = fixture();
    const leaked = manifest([...clean, row('corpus-freshness.mjs', 'export const fromTheSeed = true;\n')]);
    const { pin, untraced } = checkoutRuntimePin({ checkoutRoot: root, manifest: leaked, approvedCodeSha: 'a'.repeat(40), version: '4.3.35', api }); // sync-version-ignore: fixture
    expect(untraced).toEqual(['corpus-freshness.mjs']);
    const verdict = verifyApprovedRuntime({ manifest: leaked, pin });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.failures).toContain('archive ships an executable/runtime file no approved code release pinned: corpus-freshness.mjs');
  });

  it('FAIL: the seed\'s OLDER copy of a shipped runtime file (e.g. kb/package.json before a release) is caught', () => {
    const { root, row, clean, manifest } = fixture();
    const older = manifest(clean.map((entry) => (entry.path === 'package.json' ? row('package.json', '{"version":"4.3.34"}\n') : entry))); // sync-version-ignore: fixture
    const { pin, untraced } = checkoutRuntimePin({ checkoutRoot: root, manifest: older, approvedCodeSha: 'a'.repeat(40), version: '4.3.35', api }); // sync-version-ignore: fixture
    expect(untraced).toEqual(['package.json']);
    expect(verifyApprovedRuntime({ manifest: older, pin }).failures)
      .toContain('archive ships an executable/runtime file no approved code release pinned: package.json');
  });
});
