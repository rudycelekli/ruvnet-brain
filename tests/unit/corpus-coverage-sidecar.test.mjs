// ADR-0091 D6.2 — the coverage sidecar's own contract: it names one generation, binds exact coverage
// bytes, the coverage must describe exactly the receipt's stores, and the degraded summary a later
// reader (D10's publisher check, D11's outcome reporter) sees is RECOMPUTED, never trusted.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindCoverageToReceipt, createCoverageReceipt, main, verifyCoverageSidecar,
} from '../../scripts/corpus-coverage-sidecar.mjs';
import { writeCoverageFor } from '../helpers/corpus-seed-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const SHA = 'd'.repeat(64);
const TAG = `corpus-sha256-${SHA}`;
const alpha = { name: 'alpha', kind: 'repository', sourceCommit: 'a'.repeat(40), files: [{ file: 'alpha.big.rvf', sha256: '1'.repeat(64), bytes: 9 }] };

async function coverage(options = {}, receipt = { stores: [alpha] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-sidecar-'));
  dirs.push(dir);
  const file = path.join(dir, 'coverage.json');
  const parsed = await writeCoverageFor(receipt, file, options);
  return { file, parsed, bytes: fs.readFileSync(file), dir };
}

describe('corpus coverage sidecar (ADR-0091 D6.2)', () => {
  it('round-trips: create -> verify, with the degraded summary recomputed from the bytes', async () => {
    const { bytes } = await coverage({ carried: true });
    const sidecar = createCoverageReceipt({ generationTag: TAG, archiveSha256: SHA, archiveBytes: 10, coverageBytes: bytes });
    expect(sidecar.degraded).toEqual({ carried: ['alpha'], missing: [] });
    expect(verifyCoverageSidecar({ sidecar, coverageBytes: bytes, generationTag: TAG, archiveSha256: SHA, archiveBytes: 10 }).degraded)
      .toEqual({ carried: ['alpha'], missing: [] });
    expect(() => verifyCoverageSidecar({ sidecar: { ...sidecar, archiveBytes: 11 }, coverageBytes: bytes, generationTag: TAG,
      archiveSha256: SHA, archiveBytes: 10 })).toThrow(/coverage receipt names/);
    expect(() => verifyCoverageSidecar({ sidecar: { ...sidecar, extra: 1 }, coverageBytes: bytes, generationTag: TAG,
      archiveSha256: SHA })).toThrow(/shape is not recognized/);
  });

  it('refuses a generation tag that is not the archive digest', async () => {
    const { bytes } = await coverage();
    expect(() => createCoverageReceipt({ generationTag: 'v4.3.35', archiveSha256: SHA, archiveBytes: 10, coverageBytes: bytes })) // sync-version-ignore: fixture
      .toThrow(/corpus-sha256-<the archive sha256>/);
  });

  it('binds only when the coverage accounts for exactly the receipt\'s repository stores', async () => {
    const { parsed } = await coverage();
    expect(bindCoverageToReceipt({ coverage: parsed, receipt: { stores: [alpha] } })).toEqual({ carried: [], missing: [] });
    const extra = { stores: [alpha, { ...alpha, name: 'beta', files: [{ file: 'beta.big.rvf', sha256: '2'.repeat(64) }] }] };
    expect(() => bindCoverageToReceipt({ coverage: parsed, receipt: extra })).toThrow(/receipt binds repository store\(s\) the coverage does not ship: beta/);
    expect(() => bindCoverageToReceipt({ coverage: parsed, receipt: { stores: [{ ...alpha, sourceCommit: 'b'.repeat(40) }] } }))
      .toThrow(/different alpha source generation/);
    expect(() => bindCoverageToReceipt({ coverage: parsed, receipt: { stores: [] } })).toThrow(/names store alpha, which the receipt does not bind/);
  });

  it('CLI --verify exits 0 on a bound sidecar and 1 on tampered coverage', async () => {
    const { bytes, file, dir } = await coverage();
    const sidecarFile = path.join(dir, 'coverage-receipt.json');
    fs.writeFileSync(sidecarFile, JSON.stringify(createCoverageReceipt({ generationTag: TAG, archiveSha256: SHA, archiveBytes: 10, coverageBytes: bytes })));
    const sink = { write: () => {} };
    const argv = ['--verify', '--sidecar', sidecarFile, '--coverage', file, '--tag', TAG, '--archive-sha256', SHA, '--archive-bytes', '10'];
    expect(main(argv, { stdout: sink, stderr: sink })).toBe(0);
    fs.appendFileSync(file, ' ');
    expect(main(argv, { stdout: sink, stderr: sink })).toBe(1);
  });
});
