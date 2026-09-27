import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PLAN = path.join(ROOT, 'docs/qe/AGENTIC-QE-4.0-MASTER-PLAN.md');

const risks = [
  ['QE-INS-001', 'installer', 'tests/qe/release/packed-clean-install.test.mjs'],
  ['QE-INS-002', 'installer', 'tests/unit/npm-tarball-codex.test.mjs'],
  ['QE-HOST-001', 'host-parity', 'tests/unit/codex-lifecycle-hooks.test.mjs'],
  ['QE-HOST-002', 'host-parity', 'tests/unit/codex-console-invocation.test.mjs'],
  ['QE-UPD-001', 'update-trust', 'tests/qe/security/release-abuse-cases.test.mjs'],
  ['QE-UPD-002', 'update-trust', 'tests/qe/release/stable-spine-recovery.test.mjs'],
  ['QE-MEM-001', 'learning', 'tests/unit/learning-replay.test.mjs'],
  ['QE-MEM-002', 'learning', 'tests/qe/gpt56/live-toolchain-health.test.mjs'],
  ['QE-CON-001', 'console', 'tests/unit/console-advocacy-dial.test.mjs'],
  ['QE-CON-002', 'console', 'tests/unit/console-advocacy-precision.test.mjs'],
  ['QE-RES-001', 'resources', 'tests/unit/mcp-timeout-outage.test.mjs'],
  ['QE-RES-002', 'resources', 'tests/qe/gpt56/worker-concurrency-retirement.test.mjs'],
  // release-publish-contract.test.mjs was retired in 00526b12 (2026-09-07, "qualify reviewed
  // candidate once and retire automatic hooks"); its "GitHub Release/tag/assets/npm = one exact
  // candidate" concern is now exercised by public-verification-lane's own identity-drift cases
  // (e.g. its "public package drift" case, which mutates publication.npm.artifactSha256 and
  // expects the exact /public byte identity/ rejection this risk names).
  ['QE-REL-001', 'release', 'tests/unit/public-verification-lane.test.mjs'],
  ['QE-REL-002', 'release', 'tests/qe/release/packed-clean-install.test.mjs'],
  ['QE-FLT-001', 'fault-recovery', 'tests/unit/mcp-timeout-outage.test.mjs'],
  ['QE-FLT-002', 'fault-recovery', 'tests/qe/security/release-abuse-cases.test.mjs'],
  ['QE-BRN-001', 'source-grounding', 'tests/qe/gpt56/live-brain-search.test.mjs'],
  ['QE-TOOL-001', 'toolchain', 'tests/qe/gpt56/live-toolchain-health.test.mjs'],
];

describe('the 4.0 critical-risk matrix is executable', () => {
  it('maps every required quality domain to at least one concrete test', () => {
    const domains = new Set(risks.map(([, domain]) => domain));
    expect(domains).toEqual(new Set([
      'installer',
      'host-parity',
      'update-trust',
      'learning',
      'console',
      'resources',
      'release',
      'fault-recovery',
      'source-grounding',
      'toolchain',
    ]));
  });

  it('keeps every mapped test in the repository with real assertions', () => {
    for (const [id, , relative] of risks) {
      const file = path.join(ROOT, relative);
      expect(fs.existsSync(file), `${id} lost its executable evidence: ${relative}`).toBe(true);
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${id} has no assertion in ${relative}`).toMatch(/\bexpect\s*\(|\bassert(?:\.|\s*\()/);
    }
  });

  it('keeps the stored plan and executable map in lockstep', () => {
    const plan = fs.readFileSync(PLAN, 'utf8');
    for (const [id, , relative] of risks) {
      expect(plan, `${id} is missing from the stored plan`).toContain(`| ${id} |`);
      expect(plan, `${id} does not name ${relative}`).toContain(`\`${relative}\``);
    }
  });

  it('does not allow a P0 live check to become an unconditional skip', () => {
    const live = fs.readFileSync(path.join(ROOT, 'tests/qe/gpt56/live-toolchain-health.test.mjs'), 'utf8');
    expect(live).toContain("process.env.RUVNET_QE_LIVE === '1'");
    expect(live).toContain('describe.skipIf(!LIVE)');
    expect(live).not.toMatch(/\bit\.skip\s*\(/);
    expect(live).not.toMatch(/\bit\.todo\s*\(/);
  });
});
