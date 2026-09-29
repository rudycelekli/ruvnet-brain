// ADR-0091 D3 — the approved runtime pin is RESOLVED at run time from the newest install-verified code
// release, never read from a committed file. These tests drive resolveApprovedRuntime's decision logic
// through its seams (gh, git, asset download, archive manifest, aggregate verifier). The real signed
// v4.3.34 aggregate + 555 MB archive were proven separately against the real verifier and the
// committed key (accept / tampered / non-ancestor); that archive is far too large to commit here.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApprovedRuntimeNotYetVerified, EXIT_NOT_YET_VERIFIED, readApprovedRuntime, resolveApprovedRuntime,
} from '../../scripts/approved-runtime.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approved-runtime-resolve-')); dirs.push(dir); return dir; };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const REPO = 'stuinfla/ruvnet-brain';
const KEY = crypto.generateKeyPairSync('ed25519').publicKey;
const ZIP_BYTES = 'the exact archive bytes';
const SOURCE = { 'v9.0.2': 'a'.repeat(40), 'v9.0.1': 'b'.repeat(40), 'v9.0.10': 'c'.repeat(40) };
const manifestFor = (version) => ({
  schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version, releaseTag: `v${version}`,
  files: [
    { path: 'forge-update.mjs', sha256: sha('update'), bytes: 6 },
    { path: 'alpha.big.rvf', sha256: sha('vectors'), bytes: 7 },
  ],
});

/** A fake GitHub + clone. `releases` rows: { tag, aggregate?, zipDigest?, draft?, prerelease?, aggregateBody? }. */
function world({ releases, ancestors = Object.values(SOURCE), pkgVersion = null, zipBytes = ZIP_BYTES, verify = null }) {
  const downloads = [];
  const gh = (args) => {
    if (args[0] === 'release' && args[1] === 'list') {
      return JSON.stringify(releases.map((row) => ({ tagName: row.tag, isDraft: !!row.draft, isPrerelease: !!row.prerelease })));
    }
    const tag = args[1].split('/tags/')[1];
    const row = releases.find((r) => r.tag === tag);
    const assets = [{ name: 'ruvnet-brain.zip', digest: row.zipDigest ?? `sha256:${sha(zipBytes)}` }];
    if (row.aggregate !== false) assets.push({ name: 'public-verification-aggregate.json' });
    return JSON.stringify({ draft: !!row.draft, prerelease: !!row.prerelease, assets });
  };
  const git = (args) => {
    if (args[0] === 'merge-base') return { status: ancestors.includes(args[2]) ? 0 : 1, stdout: '', stderr: '' };
    const [commit] = args[1].split(':');
    const tag = Object.keys(SOURCE).find((t) => SOURCE[t] === commit);
    return { status: 0, stdout: JSON.stringify({ version: pkgVersion ?? tag.slice(1) }), stderr: '' };
  };
  const downloadAsset = ({ tag, name, dir }) => {
    downloads.push(`${tag}/${name}`);
    const file = path.join(dir, name);
    if (name === 'ruvnet-brain.zip') fs.writeFileSync(file, zipBytes);
    else {
      const row = releases.find((r) => r.tag === tag);
      fs.writeFileSync(file, JSON.stringify(row.aggregateBody ?? {
        verdict: 'PASS', aggregateSha256: sha(tag),
        identity: { tag, version: tag.slice(1), sourceSha: SOURCE[tag], bundleSha256: sha(ZIP_BYTES) },
      }));
    }
    return file;
  };
  const options = {
    repo: REPO, publicKey: KEY, gh, git, downloadAsset, scratchDir: tmp(),
    verifyAggregate: verify ?? ((aggregate) => aggregate),
    readArchiveManifest: () => manifestFor(downloads.at(-1).split('/')[0].slice(1)),
  };
  return { options, downloads };
}

describe('resolveApprovedRuntime — which release is approved', () => {
  it('picks the NEWEST install-verified code release by semver (9.0.10 > 9.0.2), not list order', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.2' }, { tag: 'v9.0.10' }, { tag: 'v9.0.1' },
      { tag: `corpus-sha256-${'d'.repeat(64)}` }] });
    const result = await resolveApprovedRuntime(options);
    expect(result.release).toMatchObject({ tag: 'v9.0.10', version: '9.0.10', sourceSha: SOURCE['v9.0.10'] });
    expect(result.pin).toMatchObject({ kind: 'ruvnet-brain-approved-runtime', brainVersion: '9.0.10',
      releaseTag: 'v9.0.10', approvedCodeSha: SOURCE['v9.0.10'], fileCount: 1 });
    expect(result.pin.files.map((row) => row.path)).toEqual(['forge-update.mjs']); // corpus data is never pinned
  });

  // Independent review of ADR-0091 D3 (2026-09-28): falling back to an older verified release let the
  // unattended corpus job promote an OLDER runtime over the live code release as releases/latest.
  it('NO FALLBACK: newest release with NO aggregate yet is a clean "not yet verified" — never an older release', async () => {
    const { options, downloads } = world({ releases: [{ tag: 'v9.0.10', aggregate: false }, { tag: 'v9.0.2' }] });
    const error = await resolveApprovedRuntime(options).then(() => null, (caught) => caught);
    expect(error).toBeInstanceOf(ApprovedRuntimeNotYetVerified);
    expect(error.code).toBe('APPROVED_RUNTIME_NOT_YET_VERIFIED');
    expect(error.tag).toBe('v9.0.10');
    expect(error.message).toMatch(/v9\.0\.10 has no public-verification-aggregate\.json yet/);
    // The older, perfectly valid v9.0.2 was never even looked at.
    expect(downloads.filter((entry) => entry.startsWith('v9.0.2/'))).toEqual([]);
  });

  it('NO FALLBACK: newest release with a TAMPERED aggregate fails loudly — not a silent skip to an older release', async () => {
    const { options, downloads } = world({ releases: [{ tag: 'v9.0.10' }, { tag: 'v9.0.2' }],
      verify: (aggregate) => {
        if (aggregate.identity.tag === 'v9.0.10') throw new Error('public verification aggregate signature mismatch');
        return aggregate;
      } });
    const error = await resolveApprovedRuntime(options).then(() => null, (caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApprovedRuntimeNotYetVerified); // loud, not a stand-down
    expect(error.message).toMatch(/v9\.0\.10 \(the newest\)[\s\S]*refusing to fall back to an older release[\s\S]*signature mismatch/);
    expect(downloads.filter((entry) => entry.startsWith('v9.0.2/'))).toEqual([]);
  });

  it('NO FALLBACK: a newest release whose signed aggregate says FAIL is a loud failure, not a skip', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10', aggregateBody: { verdict: 'FAIL',
      identity: { tag: 'v9.0.10', version: '9.0.10', sourceSha: SOURCE['v9.0.10'], bundleSha256: sha(ZIP_BYTES) } } },
    { tag: 'v9.0.2' }] });
    const error = await resolveApprovedRuntime(options).then(() => null, (caught) => caught);
    expect(error).not.toBeInstanceOf(ApprovedRuntimeNotYetVerified);
    expect(error.message).toMatch(/v9\.0\.10[\s\S]*aggregate verdict is FAIL, not PASS/);
  });

  it('ignores drafts and prereleases entirely', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10', draft: true }, { tag: 'v9.0.2', prerelease: true }, { tag: 'v9.0.1' }] });
    expect((await resolveApprovedRuntime(options)).release.tag).toBe('v9.0.1');
  });

  it('--tag judges exactly that release and nothing else', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10' }, { tag: 'v9.0.2' }] });
    expect((await resolveApprovedRuntime({ ...options, tag: 'v9.0.2' })).release.tag).toBe('v9.0.2');
    await expect(resolveApprovedRuntime({ ...options, tag: 'latest' })).rejects.toThrow(/--tag must be vX\.Y\.Z/);
  });
});

describe('resolveApprovedRuntime — every piece of evidence must hold, and it never falls open', () => {
  it('RED: an aggregate the verifier rejects (bad signature / tampered) disqualifies the release', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10' }],
      verify: () => { throw new Error('public verification aggregate signature mismatch'); } });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/v9\.0\.10 \(the newest\)[\s\S]*public verification aggregate signature mismatch/);
  });

  it('RED: an aggregate that describes a different release is refused', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10', aggregateBody: { verdict: 'PASS',
      identity: { tag: 'v9.0.2', version: '9.0.2', sourceSha: SOURCE['v9.0.2'], bundleSha256: sha(ZIP_BYTES) } } }] });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/does not describe release v9\.0\.10/);
  });

  it('RED: the release zip is not the archive the aggregate verified — refused BEFORE downloading 500 MB', async () => {
    const { options, downloads } = world({ releases: [{ tag: 'v9.0.10', zipDigest: `sha256:${'0'.repeat(64)}` }] });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/is not the archive the aggregate verified/);
    expect(downloads).not.toContain('v9.0.10/ruvnet-brain.zip');
  });

  it('RED: a sourceSha NOT reachable from origin/main is refused — BEFORE downloading the archive', async () => {
    const { options, downloads } = world({ releases: [{ tag: 'v9.0.10' }], ancestors: [] });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/is not reachable from origin\/main/);
    expect(downloads).not.toContain('v9.0.10/ruvnet-brain.zip');
  });

  it('RED: package.json at sourceSha must BE the approved version, or a build there could never match the pin', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10' }], pkgVersion: '9.0.11' });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/package\.json at c{12} is 9\.0\.11, not 9\.0\.10/);
  });

  it('RED: downloaded archive bytes that differ from the verified digest are refused', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10', zipDigest: '' }], zipBytes: 'swapped bytes' });
    await expect(resolveApprovedRuntime(options)).rejects.toThrow(/downloaded ruvnet-brain\.zip is [0-9a-f]{64}, not the verified/);
  });

  it('RED: --tag with an invalid aggregate is loud too, and names that exact release', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10' }, { tag: 'v9.0.2' }], ancestors: [] });
    await expect(resolveApprovedRuntime({ ...options, tag: 'v9.0.2' })).rejects.toThrow(
      /code release v9\.0\.2 carries[\s\S]*aggregate sourceSha a{40} is not reachable/);
  });

  it('with no injected verifier, the REAL aggregate verifier runs (a malformed aggregate is refused)', async () => {
    const { options } = world({ releases: [{ tag: 'v9.0.10' }] });
    await expect(resolveApprovedRuntime({ ...options, verifyAggregate: null }))
      .rejects.toThrow(/v9\.0\.10 \(the newest\)[\s\S]*public verification aggregate is malformed/);
  });
});

describe('approved-runtime.mjs --resolve CLI — the exit code the nightly stands down on', () => {
  // Crosses the process boundary: a fake `gh` (RUVNET_GH_COMMAND) serves one newest release.
  const fakeGh = (withAggregate) => {
    const dir = tmp();
    const script = path.join(dir, 'gh.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'list') { process.stdout.write(JSON.stringify([{ tagName: 'v9.0.10' }, { tagName: 'v9.0.2' }])); process.exit(0); }
if (args[0] === 'api') {
  const assets = [{ name: 'ruvnet-brain.zip' }];
  if (${withAggregate}) assets.push({ name: 'public-verification-aggregate.json' });
  process.stdout.write(JSON.stringify({ draft: false, prerelease: false, assets })); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  const dir = args[args.indexOf('--dir') + 1];
  fs.writeFileSync(path.join(dir, args[args.indexOf('--pattern') + 1]), JSON.stringify({ verdict: 'PASS', forged: true }));
  process.exit(0);
}
process.exit(9);
`);
    const wrapper = path.join(dir, 'gh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  };
  const cli = (gh) => spawnSync(process.execPath, [path.resolve('scripts/approved-runtime.mjs'), '--resolve', '--repo', REPO,
    '--out', path.join(tmp(), 'pin.json')], { encoding: 'utf8', env: { ...process.env, RUVNET_GH_COMMAND: gh } });

  it(`exits ${EXIT_NOT_YET_VERIFIED} (stand down) when the newest release has no aggregate yet`, () => {
    const result = cli(fakeGh(false));
    expect(EXIT_NOT_YET_VERIFIED).toBe(3);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toMatch(/v9\.0\.10 has no public-verification-aggregate\.json yet/);
    expect(result.stdout).toBe('');
  });

  it('exits 1 (loud) when the newest release carries an aggregate that does not verify', () => {
    const result = cli(fakeGh(true));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/v9\.0\.10 \(the newest\)[\s\S]*refusing to fall back/);
    expect(result.stderr).not.toMatch(/v9\.0\.2/);
    expect(result.stdout).toBe('');
  });
});

describe('readApprovedRuntime — no committed default', () => {
  it('refuses to guess a path and names the --resolve remedy', () => {
    expect(() => readApprovedRuntime()).toThrow(/no approved runtime pin supplied[\s\S]*--resolve/);
    expect(() => readApprovedRuntime(path.join(tmp(), 'pin.json'))).toThrow(/no approved runtime pin at[\s\S]*--resolve/);
  });
});
