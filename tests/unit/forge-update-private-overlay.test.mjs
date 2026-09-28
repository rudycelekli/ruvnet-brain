import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capturePrivateOverlayState,
  restorePrivateFilesIntoCandidate,
  restorePrivateOverlayState,
  selectUpdateManagedStores,
} from '../../kb/forge-update.mjs';
import { runStorageTransaction } from '../../kb/update-storage-transaction.mjs';

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function registryFixture() {
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-private-'));
  const privateStore = {
    kbName: 'makerkit-source',
    updateManaged: false,
    sourceCommit: 'private-commit',
  };
  writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { public: { kbName: 'public' }, 'makerkit-source': privateStore } });
  writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), { stores: { public: { file: 'public.rvf' }, 'makerkit-source': { file: 'makerkit-source.rvf', sha256: 'private' } } });
  writeJson(path.join(kbDir, 'repo-aliases.json'), { public: ['public'], makerkit: ['makerkit-source'] });
  fs.writeFileSync(path.join(kbDir, 'capability-cards.md'), '# Cards\n\n## public\nold public\n\n## makerkit\nprivate card\n');
  fs.writeFileSync(path.join(kbDir, 'makerkit-source.rvf'), 'private-rvf-bytes');
  return { kbDir, privateStore };
}

describe('forge-update private overlay boundary', () => {
  const stores = [
    { kbName: 'ruvector' },
    { kbName: 'ruflo' },
    { kbName: 'makerkit-source', updateManaged: false },
    { kbName: 'saythanks', updateManaged: false },
  ];

  it('keeps private stores in provenance while excluding them from public updates', () => {
    expect(selectUpdateManagedStores(stores, 'complete').map((store) => store.kbName)).toEqual([
      'ruvector',
      'ruflo',
    ]);
  });

  it('applies the RuVector-only profile after excluding private stores', () => {
    expect(selectUpdateManagedStores(stores, 'ruvector')).toEqual([{ kbName: 'ruvector' }]);
  });

  it('restores private provenance after a public bundle replaces shared registries', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });

    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { public: { kbName: 'public', sourceCommit: 'new-public' } } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), { stores: { public: { file: 'public-v2.rvf' } } });
    writeJson(path.join(kbDir, 'repo-aliases.json'), { public: ['public-v2'] });
    fs.writeFileSync(path.join(kbDir, 'capability-cards.md'), '# Cards\n\n## public\nnew public\n');

    expect(restorePrivateOverlayState({ kbDir, overlay })).toEqual({ restored: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).stores).toEqual({
      public: { kbName: 'public', sourceCommit: 'new-public' },
      'makerkit-source': privateStore,
    });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8')).stores).toEqual({
      public: { file: 'public-v2.rvf' },
      'makerkit-source': { file: 'makerkit-source.rvf', sha256: 'private' },
    });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'repo-aliases.json'), 'utf8')).makerkit).toEqual(['makerkit-source']);
    expect(fs.readFileSync(path.join(kbDir, 'capability-cards.md'), 'utf8')).toContain('## makerkit\nprivate card');
  });

  it('fails a conflicting public/private name before writing any registry', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { 'makerkit-source': { kbName: 'makerkit-source', sourceCommit: 'public-collision' } } });
    const files = ['SOURCE.json', 'RVF-GENERATIONS.json', 'repo-aliases.json', 'capability-cards.md'];
    const before = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(kbDir, name))]));

    expect(() => restorePrivateOverlayState({ kbDir, overlay })).toThrow(/SOURCE\.json collision/);
    for (const name of files) expect(fs.readFileSync(path.join(kbDir, name))).toEqual(before[name]);
  });

  // The full-KB-rollback-on-failure guarantee this test used to cover belongs to
  // `runStorageTransaction` now (S1: ONE APPLY PATH — the deleted `applyPublicBundlePreservingPrivate`
  // was a second, parallel implementation production code never called). That guarantee is already
  // exercised generically for ANY `prepareCandidate` failure — see
  // tests/unit/update-storage-transaction.test.mjs "leaves live byte-identical when candidate
  // preparation or validation fails". The SOURCE.json-collision throw itself is covered directly
  // above ("fails a conflicting public/private name before writing any registry").

  it('refuses a public bundle that contains a private RVF filename before copying', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    // candidateDir stands in for the sibling tree runStorageTransaction builds from the freshly
    // extracted public bundle, BEFORE restorePrivateFilesIntoCandidate copies anything onto it.
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-rvf-collision-'));
    fs.writeFileSync(path.join(candidateDir, 'makerkit-source.rvf'), 'public-collision');

    expect(() => restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay }))
      .toThrow(/collides with private file makerkit-source\.rvf/);
    expect(fs.readFileSync(path.join(candidateDir, 'makerkit-source.rvf'), 'utf8')).toBe('public-collision');
    expect(fs.readFileSync(path.join(kbDir, 'makerkit-source.rvf'), 'utf8')).toBe('private-rvf-bytes');
  });

  it('uses the generation file as authority when the private logical name and filename differ', () => {
    const { kbDir } = registryFixture();
    const privateStore = { kbName: 'privateLogical', updateManaged: false };
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { privateLogical: privateStore } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), {
      stores: { privateLogical: { file: 'opaque.rvf', sha256: 'private' } },
    });
    fs.writeFileSync(path.join(kbDir, 'opaque.rvf'), 'private-opaque-bytes');
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-opaque-rvf-'));
    fs.writeFileSync(path.join(candidateDir, 'opaque.rvf'), 'public-collision');

    expect(Object.keys(overlay.files)).toContain('opaque.rvf');
    expect(() => restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay }))
      .toThrow(/collides with private file opaque\.rvf/);
    expect(fs.readFileSync(path.join(candidateDir, 'opaque.rvf'), 'utf8')).toBe('public-collision');
    expect(fs.readFileSync(path.join(kbDir, 'opaque.rvf'), 'utf8')).toBe('private-opaque-bytes');
  });

  it('fails preflight when a private generation does not resolve to a live artifact', () => {
    const { kbDir } = registryFixture();
    const privateStore = { kbName: 'privateLogical', updateManaged: false };
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { privateLogical: privateStore } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), {
      stores: { privateLogical: { file: 'missing.rvf', sha256: 'private' } },
    });

    expect(() => capturePrivateOverlayState({ kbDir, allStores: [privateStore] }))
      .toThrow(/RVF generation file is missing: missing\.rvf/);
  });

  it.skipIf(process.platform === 'win32')('rejects a private generation symlink before a public update can write through it', () => {
    const { kbDir } = registryFixture();
    const privateStore = { kbName: 'privateLogical', updateManaged: false };
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-outside-'));
    const outsideFile = path.join(outsideDir, 'sentinel.rvf');
    fs.writeFileSync(outsideFile, 'do-not-touch');
    fs.symlinkSync(outsideFile, path.join(kbDir, 'opaque.rvf'));
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { privateLogical: privateStore } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), {
      stores: { privateLogical: { file: 'opaque.rvf', sha256: 'private' } },
    });

    expect(() => capturePrivateOverlayState({ kbDir, allStores: [privateStore] }))
      .toThrow(/RVF generation file is a symbolic link: opaque\.rvf/);
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('do-not-touch');
  });

  it('copies captured private files onto a fresh candidate and restores registry entries (the real apply path)', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    // candidateDir stands in for the sibling tree runStorageTransaction builds from the freshly
    // extracted public bundle — public bytes only, no private artifacts yet. Unlike the deleted
    // full-tree-replace path, there is no "old kbDir" here for a retired file to survive in: the
    // candidate is always a brand-new directory (transactionPaths() refuses to reuse an existing
    // candidate path, kb/update-storage-transaction.mjs), so "does the old tree shape disappear" is
    // structural, not something this function needs to prove.
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-candidate-'));
    writeJson(path.join(candidateDir, 'SOURCE.json'), { stores: { public: { kbName: 'public', sourceCommit: 'new' } } });
    writeJson(path.join(candidateDir, 'RVF-GENERATIONS.json'), { stores: { public: { file: 'public-v2.rvf' } } });
    writeJson(path.join(candidateDir, 'repo-aliases.json'), { public: ['public-v2'] });
    fs.writeFileSync(path.join(candidateDir, 'capability-cards.md'), '# Cards\n\n## public\nnew public\n');
    fs.writeFileSync(path.join(candidateDir, 'public-v2.rvf'), 'public-v2');

    expect(restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay })).toEqual({ restored: 1 });
    expect(fs.readFileSync(path.join(candidateDir, 'makerkit-source.rvf'), 'utf8')).toBe('private-rvf-bytes');
    expect(JSON.parse(fs.readFileSync(path.join(candidateDir, 'SOURCE.json'), 'utf8')).stores['makerkit-source'])
      .toEqual(privateStore);
    expect(fs.readFileSync(path.join(candidateDir, 'public-v2.rvf'), 'utf8')).toBe('public-v2');
  });

  it.skipIf(process.platform === 'win32')('rejects destination ancestor symlinks before copying a private file into the candidate', () => {
    const { kbDir } = registryFixture();
    const privateStore = { kbName: 'privateLogical', updateManaged: false };
    fs.mkdirSync(path.join(kbDir, 'nested'));
    fs.writeFileSync(path.join(kbDir, 'nested', 'opaque.rvf'), 'private-nested-bytes');
    writeJson(path.join(kbDir, 'SOURCE.json'), { stores: { privateLogical: privateStore } });
    writeJson(path.join(kbDir, 'RVF-GENERATIONS.json'), {
      stores: { privateLogical: { file: 'nested/opaque.rvf', sha256: 'private' } },
    });
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });

    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-destination-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-outside-destination-'));
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'DO-NOT-TOUCH');
    fs.symlinkSync(outside, path.join(candidateDir, 'nested'), 'dir');

    expect(() => restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay }))
      .toThrow(/symlink destination is not allowed/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('DO-NOT-TOUCH');
    expect(fs.readdirSync(outside)).toEqual(['sentinel.txt']);
  });

  it.skipIf(process.platform === 'win32')('rejects dangling destination symlinks instead of following them outside the KB', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-dangling-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-dangling-outside-'));
    const target = path.join(outside, 'pwned.txt');
    fs.symlinkSync(target, path.join(candidateDir, 'makerkit-source.rvf'));

    expect(() => restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay }))
      .toThrow(/symlink destination is not allowed/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

// S5: regression coverage for "single apply path" — the deleted helper stays gone, and a failure
// inside restorePrivateFilesIntoCandidate mid-transaction rolls the WHOLE live tree back, not just
// the in-memory overlay call.
describe('S1/S5 — single apply path regression guards', () => {
  it('applyPublicBundlePreservingPrivate is gone: not exported, and not present in the source text', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../kb/forge-update.mjs'), 'utf8');
    // Historical explanatory comments are allowed to name the deleted function; a live declaration
    // or export is not. Match the exact declaration/export forms, not the prose that discusses them.
    expect(source).not.toMatch(/\bfunction applyPublicBundlePreservingPrivate\b/);
    expect(source).not.toMatch(/\bexport\s+(?:async\s+)?function applyPublicBundlePreservingPrivate\b/);
  });

  it('rolls the WHOLE live tree back, byte for byte, when restorePrivateFilesIntoCandidate collides mid-transaction', () => {
    const { kbDir, privateStore } = registryFixture();
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [privateStore] });
    const before = Object.fromEntries(fs.readdirSync(kbDir).map((name) => [name, fs.readFileSync(path.join(kbDir, name))]));

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-candidate-source-'));
    // The "new public bundle" collides with the private store's own filename — restorePrivateFilesIntoCandidate
    // must refuse, and runStorageTransaction must treat that refusal exactly like any other
    // prepareCandidate failure: candidate discarded, live untouched, no stray transaction directories.
    fs.writeFileSync(path.join(sourceDir, 'makerkit-source.rvf'), 'a-colliding-public-file');

    expect(() => runStorageTransaction({
      liveDir: kbDir, sourceDir, transactionId: `s5-rollback-${Date.now()}`,
      prepareCandidate: ({ candidateDir, liveDir }) => restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: liveDir, overlay }),
    })).toThrow(/collides with private file makerkit-source\.rvf/);

    const after = Object.fromEntries(fs.readdirSync(kbDir).map((name) => [name, fs.readFileSync(path.join(kbDir, name))]));
    expect(after).toEqual(before);
    // Scoped to THIS kbDir's own basename — os.tmpdir() is shared with every other test running
    // concurrently, so a blanket scan for the transaction-directory pattern would be flaky.
    const parent = path.dirname(kbDir);
    const base = path.basename(kbDir);
    const stray = fs.readdirSync(parent).filter((name) => name.startsWith(`${base}.next-`)
      || name.startsWith(`${base}.rollback-`) || name.startsWith(`${base}.failed-`));
    expect(stray).toEqual([]);
  });

  // S3/S5: a store this brain pulled in via scripts/ingest-repo.mjs (origin:'local-ingest') is, from
  // forge-update.mjs's point of view, just another updateManaged:false store — the extra field flows
  // through capturePrivateOverlayState/restorePrivateFilesIntoCandidate/restorePrivateOverlayState
  // untouched, with no special-casing needed. Proven directly rather than assumed.
  it('a local-ingest store (origin:local-ingest) survives the apply path exactly like any private overlay', () => {
    const { kbDir } = registryFixture();
    const localIngestStore = { kbName: 'makerkit-source', updateManaged: false, origin: 'local-ingest', sourceCommit: 'private-commit' };
    fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), `${JSON.stringify({ stores: { public: { kbName: 'public' }, 'makerkit-source': localIngestStore } }, null, 2)}\n`);
    const overlay = capturePrivateOverlayState({ kbDir, allStores: [localIngestStore] });
    expect(overlay.sourceStores['makerkit-source'].origin).toBe('local-ingest');

    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-local-ingest-candidate-'));
    fs.writeFileSync(path.join(candidateDir, 'SOURCE.json'), `${JSON.stringify({ stores: { public: { kbName: 'public', sourceCommit: 'new' } } }, null, 2)}\n`);
    fs.writeFileSync(path.join(candidateDir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ stores: { public: { file: 'public.rvf' } } }, null, 2)}\n`);
    fs.writeFileSync(path.join(candidateDir, 'repo-aliases.json'), '{}');

    expect(restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: kbDir, overlay })).toEqual({ restored: 1 });
    expect(fs.readFileSync(path.join(candidateDir, 'makerkit-source.rvf'), 'utf8')).toBe('private-rvf-bytes');
    const landed = JSON.parse(fs.readFileSync(path.join(candidateDir, 'SOURCE.json'), 'utf8'));
    expect(landed.stores['makerkit-source']).toEqual(localIngestStore);
  });
});
