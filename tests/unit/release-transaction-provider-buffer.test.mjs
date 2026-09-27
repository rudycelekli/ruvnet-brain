import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'release-transaction-provider.mjs'), 'utf8');

// Regression for 2026-09-27: finalize-public-verification failed with
// `public-verification-finalizer: spawnSync gh ENOBUFS` while finalizing v4.3.30. Root cause: the
// shared `command()` helper (which `refresh()` uses to slurp EVERY release's paginated metadata)
// never overrode execFileSync's 1MB default maxBuffer, and the repo's accumulated release history
// (several releases now carrying 14-15 chained transaction receipts as assets each) finally crossed
// it — the same failure shape as the documented #77 bundle-download ENOBUFS, at a different call
// site the original fix never covered.
describe('release-transaction-provider: gh metadata calls have real buffer margin over the 1MB default', () => {
  it('the shared command() helper passes an explicit maxBuffer well above the 1MB default', () => {
    const m = SOURCE.match(/const command = \(name, args, options = \{\}\) => execFileSync\(name, args, \{[^}]*maxBuffer:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    expect(m, "command() must pass an explicit maxBuffer, not inherit execFileSync's 1MB default").not.toBeNull();
    const maxBufferMb = Number(m[1]);
    expect(maxBufferMb).toBeGreaterThan(1);
  });

  it("refresh()'s paginated releases listing is routed through the buffered command() helper, not a bare execFileSync", () => {
    expect(SOURCE).toMatch(/const refresh = \(\) => \{\s*const pages = json\('gh', \['api', `repos\/\$\{REPO\}\/releases\?per_page=100`, '--paginate', '--slurp'\]\)/);
  });
});
