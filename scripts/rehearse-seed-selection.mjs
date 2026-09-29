// scripts/rehearse-seed-selection.mjs — the ADR-0091 D4 half of the corpus rehearsal.
//
// Before D4 the rehearsal handed candidate N straight to generation N+1 and never exercised seed
// SELECTION at all (the audit's V4 gap). This module lets it do what the nightly does:
//   1. "publish" candidate N into a LOCAL release registry, from the exact files release.mjs tried to
//      upload (the recorded `gh release create`), so nothing is invented about the asset set;
//   2. optionally cut a simulated CODE RELEASE in the disposable checkout between generations (a
//      version bump through the repo's own scripts/sync-version.mjs, committed) -- the event that,
//      before D4, reset the seed chain to the bootstrap (ADR-0091 section 3.4);
//   3. register newer, INCOMPATIBLE decoy generations that must be skipped before any archive
//      download: one whose receipt names a different embedding model, one whose recall report was
//      measured against a different frozen fixture;
//   4. answer the real corpus-next-seed.mjs resolver through a fake `gh` served from that registry,
//      which REFUSES any archive download and records every call;
//   5. check every candidate's runtime surface with the real verifyApprovedRuntime against a pin
//      derived from the CHECKOUT's own files, never from the candidate -- so a seed's executable that
//      leaked into the archive shows up as "no approved code release pinned".
//
// It publishes nothing and calls no network: the registry is a directory, the `gh` is a function.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ARCHIVE_ASSET = 'ruvnet-brain.zip';
const SIGNATURE_ASSET = 'ruvnet-brain.zip.sig';

const sha256Text = (text) => crypto.createHash('sha256').update(text).digest('hex');
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const clone = (from, to) => fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);

// ---------------------------------------------------------------------------------------------
// The local registry
// ---------------------------------------------------------------------------------------------

/**
 * Register one generation. `files` are local paths whose basenames become asset names. `declared`
 * overrides an asset's listed size without writing its bytes (a decoy's archive is listed, never
 * served). A `.sig` placeholder is added when the files carry none, and the release records that it
 * is a placeholder: the rehearsal's publish path is the non-promoting one, which signs nothing, and
 * the resolver checks the signature's PRESENCE only (verification happens in the updater).
 */
export function registerGeneration({ registryDir, tag, createdAt, files = [], declared = {}, note = null }) {
  const dir = path.join(registryDir, tag);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const assets = [];
  for (const file of files) {
    const name = path.basename(file);
    clone(file, path.join(dir, 'assets', name));
    assets.push({ name, size: fs.statSync(file).size, state: 'uploaded' });
  }
  for (const [name, size] of Object.entries(declared)) {
    fs.writeFileSync(path.join(dir, 'assets', name), '');
    assets.push({ name, size, state: 'uploaded', declaredOnly: true });
  }
  let signaturePlaceholder = false;
  if (!assets.some(({ name }) => name === SIGNATURE_ASSET)) {
    fs.writeFileSync(path.join(dir, 'assets', SIGNATURE_ASSET), 'rehearsal placeholder: not a signature\n');
    assets.push({ name: SIGNATURE_ASSET, size: fs.statSync(path.join(dir, 'assets', SIGNATURE_ASSET)).size, state: 'uploaded' });
    signaturePlaceholder = true;
  }
  const release = { tagName: tag, isDraft: false, createdAt, assets, signaturePlaceholder, note };
  fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

/** The files a recorded `gh release create` would have uploaded: its existing-file arguments. */
export function uploadedFilesOf(createArgs) {
  return (createArgs || []).filter((value) => path.isAbsolute(String(value)) && fs.existsSync(value) && fs.statSync(value).isFile());
}

/**
 * A `gh` answering the three calls corpus-next-seed.mjs makes, from the registry. An archive download
 * is REFUSED and recorded, so the rehearsal can assert the resolver judged from small files only.
 */
export function registryGh(registryDir) {
  const calls = [];
  const releases = () => fs.readdirSync(registryDir)
    .map((tag) => JSON.parse(fs.readFileSync(path.join(registryDir, tag, 'release.json'), 'utf8')));
  const run = (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    if (command !== 'gh') return { status: 127, stderr: `unexpected command ${command}` };
    if (args[0] === 'release' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(releases().map(({ tagName, isDraft, createdAt }) => ({ tagName, isDraft, createdAt }))) };
    }
    const release = releases().find((row) => row.tagName === args[2]);
    if (args[0] === 'release' && args[1] === 'view') {
      if (!release) return { status: 1, stderr: 'release not found' };
      return { status: 0, stdout: JSON.stringify({ tagName: release.tagName, isDraft: release.isDraft,
        assets: release.assets.map(({ name, size, state }) => ({ name, size, state })) }) };
    }
    if (args[0] === 'release' && args[1] === 'download') {
      const pattern = args[args.indexOf('--pattern') + 1];
      const dir = args[args.indexOf('--dir') + 1];
      if (pattern === ARCHIVE_ASSET) return { status: 1, stderr: 'rehearsal registry refuses archive downloads to the resolver' };
      const asset = release?.assets.find(({ name }) => name === pattern);
      if (!asset || asset.declaredOnly) return { status: 1, stderr: 'asset not found' };
      fs.copyFileSync(path.join(registryDir, release.tagName, 'assets', pattern), path.join(dir, pattern));
      return { status: 0, stdout: '' };
    }
    return { status: 1, stderr: `unsupported gh call in the rehearsal registry: ${line}` };
  };
  return {
    run,
    calls,
    downloads: () => calls.filter((line) => / release download /.test(line)),
    archiveDownloadAttempts: () => calls.filter((line) => / release download /.test(line) && line.includes(`--pattern ${ARCHIVE_ASSET} `)),
  };
}

/**
 * Two newer generations the resolver must SKIP, each rebound to its own digest so every identity
 * check that precedes the compatibility check still passes -- only the property under test differs:
 *   model-mismatch   -- one store's receipt row names another model/dimensions (rejected from the
 *                       receipt alone; its recall report must never be fetched);
 *   fixture-mismatch -- the recall report was measured against another frozen fixture (rejected
 *                       after the small recall download; its archive must never be fetched).
 */
export function registerIncompatibleDecoys({ registryDir, real, createdAtMs, scratchDir }) {
  const realReceipt = JSON.parse(fs.readFileSync(real.receiptFile, 'utf8'));
  const realRecall = JSON.parse(fs.readFileSync(real.recallFile, 'utf8'));
  const decoys = [];
  const make = (kind, offsetMs, mutate) => {
    const digest = sha256Text(`rehearsal-decoy:${kind}:${real.sha256}`);
    const tag = `corpus-sha256-${digest}`;
    const dir = path.join(scratchDir, `decoy-${kind}`);
    fs.mkdirSync(dir, { recursive: true });
    const recall = { ...realRecall, archive: { ...realRecall.archive, sha256: digest, bytes: real.bytes } };
    const receipt = { ...realReceipt, archive: { ...realReceipt.archive, sha256: digest, bytes: real.bytes } };
    mutate({ recall, receipt });
    const recallFile = path.join(dir, 'ruvnet-brain.zip.recall.json');
    fs.writeFileSync(recallFile, JSON.stringify(recall));
    receipt.recallReport = { file: path.basename(recallFile), sha256: sha256File(recallFile), bytes: fs.statSync(recallFile).size };
    const receiptFile = path.join(dir, 'corpus-receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    registerGeneration({
      registryDir, tag, createdAt: new Date(createdAtMs + offsetMs).toISOString(),
      files: [receiptFile, recallFile, real.accuracyFile], declared: { [ARCHIVE_ASSET]: real.bytes },
      note: `rehearsal decoy (${kind}); its archive is listed, never served`,
    });
    decoys.push({ kind, tag });
  };
  make('fixture-mismatch', 1000, ({ recall }) => {
    recall.fixture = { ...recall.fixture, sha256: sha256Text('rehearsal-decoy: a different frozen fixture') };
  });
  make('model-mismatch', 2000, ({ receipt }) => {
    receipt.stores = receipt.stores.map((row, index) => (index === 0 ? { ...row, model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 } : row));
  });
  return decoys;
}

// ---------------------------------------------------------------------------------------------
// A code release between generations
// ---------------------------------------------------------------------------------------------

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) throw new Error(`cannot bump a non x.y.z version (${version})`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/**
 * Cut a code release in the disposable checkout the way CONTRIBUTING.md's "set version" commit does:
 * edit the ONE hand-edited number (plugin/.claude-plugin/plugin.json) and let scripts/sync-version.mjs
 * propagate it (kb/package.json -- a SHIPPED runtime file -- among others). Only the paths this bump
 * changed are committed; the rehearsal's own scratch edits in the checkout stay uncommitted.
 */
export function simulateCodeRelease({ checkoutRoot }) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: checkoutRoot, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim().slice(0, 400)}`);
    return String(result.stdout);
  };
  const dirty = () => new Set(git(['status', '--porcelain']).split('\n').filter(Boolean).map((line) => line.slice(3)));
  const pluginFile = path.join(checkoutRoot, 'plugin', '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginFile, 'utf8'));
  const from = plugin.version;
  const to = nextPatchVersion(from);
  const before = dirty();
  plugin.version = to;
  fs.writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
  const sync = spawnSync(process.execPath, [path.join(checkoutRoot, 'scripts', 'sync-version.mjs')], { cwd: checkoutRoot, encoding: 'utf8' });
  if (sync.status !== 0) throw new Error(`sync-version.mjs failed in the disposable checkout: ${String(sync.stderr || sync.stdout).trim().slice(0, 400)}`);
  const committed = [...dirty()].filter((file) => !before.has(file)).sort();
  if (!committed.includes('kb/package.json')) throw new Error('the simulated code release did not change kb/package.json, the shipped runtime manifest');
  git(['add', '--', ...committed]);
  git(['-c', 'user.email=rehearsal@localhost', '-c', 'user.name=corpus rehearsal', 'commit', '-q', '-m', `chore(release): set version ${to} (rehearsal)`]);
  return { from, to, head: git(['rev-parse', 'HEAD']).trim(), committed };
}

// ---------------------------------------------------------------------------------------------
// The runtime surface, judged against the CHECKOUT
// ---------------------------------------------------------------------------------------------

/**
 * A pin built from the checkout's own bytes, for the runtime-shaped rows of a candidate manifest.
 * build-bundle.mjs copies the kb module graph and kb/package*.json from <checkout>/kb, and
 * verify-bundle.mjs, the signing key and primer/ from the checkout root or scripts/. A row is pinned
 * only when a checkout file at one of those places has EXACTLY its bytes; anything else (a file that
 * could only have come from the seed) stays unpinned, so verifyApprovedRuntime's backward check names
 * it. Never emitted from the candidate itself, which would pin whatever leaked.
 */
export function checkoutRuntimePin({ checkoutRoot, manifest, approvedCodeSha, version, api }) {
  const traced = [];
  const untraced = [];
  for (const row of manifest.files.filter((entry) => api.isRuntimeFile(entry.path))) {
    const candidates = [path.join('kb', row.path), row.path, path.join('scripts', row.path)];
    const source = candidates.find((relative) => {
      const file = path.join(checkoutRoot, relative);
      return fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size === row.bytes && sha256File(file) === row.sha256;
    });
    if (source) {
      const file = path.join(checkoutRoot, source);
      traced.push({ path: row.path, sha256: sha256File(file), bytes: fs.statSync(file).size, source });
    } else untraced.push(row.path);
  }
  const pin = api.emitApprovedRuntime({
    manifest: { schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version, releaseTag: `v${version}`,
      files: traced.map(({ path: p, sha256, bytes }) => ({ path: p, sha256, bytes })) },
    approvedCodeSha,
  });
  return { pin, traced: traced.length, untraced };
}
