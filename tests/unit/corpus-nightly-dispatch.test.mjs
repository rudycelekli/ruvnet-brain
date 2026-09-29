import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPublisherActions } from '../../scripts/release-authority.mjs';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const DISPATCHER = '.github/workflows/corpus-nightly-dispatch.yml';
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const executable = (block) => block.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');

describe('corpus nightly dispatcher (ADR-086 step 18)', () => {
  it('turns a schedule into a genuine workflow_dispatch on protected main in corpus mode', () => {
    const source = read(DISPATCHER);
    expect(source).toMatch(/^on:\n {2}schedule:\n {4}# [^\n]*\n {4}- cron: '[^']+'\n {2}workflow_dispatch: \{\}$/m);
    expect(source).toContain('gh workflow run protected-release.yml');
    expect(source).toContain('--ref main');
    expect(source).toContain('-f mode=corpus');
    expect(source).toContain('-f "candidate_sha=$CANDIDATE_SHA"');
    expect(source).toContain('-f "version=$CANDIDATE_VERSION"');
  });

  it('PRESERVES the invocation identity predicate rather than weakening it', () => {
    // scripts/protected-release-invocation.mjs is why the dispatcher exists at all. If a future
    // change admits `schedule` there, this dispatcher becomes pointless AND the boundary is gone.
    const invocation = read('scripts/protected-release-invocation.mjs');
    expect(invocation).toContain("env.GITHUB_EVENT_NAME !== 'workflow_dispatch'");
    expect(invocation).toContain("env.GITHUB_WORKFLOW !== PROTECTED_WORKFLOW");
    expect(invocation).toContain("env.GITHUB_REF_PROTECTED !== 'true'");
    expect(invocation).not.toContain("'schedule'");
    // And protected-release.yml itself still carries no schedule trigger.
    expect(read('.github/workflows/protected-release.yml')).not.toMatch(/^\s{2}schedule:/m);
  });

  it('NO SIGNING OR PUBLICATION AUTHORITY: contents:read and actions:write, nothing more', () => {
    const source = executable(read(DISPATCHER));
    expect(source).toMatch(/^permissions:\n {2}contents: read\n {2}actions: write$/m);
    expect(source.match(/permissions:\n {6}contents: read\n {6}actions: write/g)).toHaveLength(1);
    for (const forbidden of [
      'contents: write', 'id-token', 'environment:', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
      'RUVNET_SIGNING_KEY', 'sign-bundle.mjs', 'release.mjs', 'gh release', 'npm publish', 'npm dist-tag',
    ]) {
      expect(source, `the dispatcher must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // The only secret-shaped expression permitted is the built-in Actions token.
    const secretRefs = [...source.matchAll(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/g)].map(([match]) => match);
    expect(secretRefs).toEqual([]);
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('is invisible to the one-publisher source gate', () => {
    // The same predicate CI runs. A dispatcher that tripped it would be a second publisher.
    expect(detectPublisherActions(DISPATCHER, read(DISPATCHER))).toEqual([]);
  });

  it('never dispatches from a fork that merely inherited the schedule', () => {
    expect(read(DISPATCHER)).toContain("if: github.repository == 'stuinfla/ruvnet-brain'");
  });

  it('FAILS the night when gh workflow run produces no target run — the A5 run record is mandatory', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('event=workflow_dispatch');
    expect(source).toContain('test "$run_event" = workflow_dispatch');
    expect(source).toContain('no protected-release run with event=workflow_dispatch appeared');
    // A missing record must exit non-zero, not warn: "reported success but nothing ran" is exactly
    // the silent-failure shape this project has been bitten by before.
    const guard = source.split('if [[ -z "$record" ]]; then')[1]?.split('fi')[0] || '';
    expect(guard).toContain('exit 1');
    expect(source).toContain('dispatched-run.json');
  });


  it('POLLS the protected child to a terminal state and fails when it did not succeed (2026-09-27 correction)', () => {
    // A prior version of this test (#315, 2026-09-21) forbade polling here, on the theory that
    // ntfy-alerts.yml's `workflow_run` listener on protected-release's own completion would carry
    // visibility instead. That theory is false, and provably so: GitHub's own documented behavior
    // is that a workflow_dispatch made with the automatic GITHUB_TOKEN (exactly what the dispatch
    // step below does) runs the target workflow, but workflow_dispatch/repository_dispatch are the
    // ONLY two events exempt from "GITHUB_TOKEN-triggered events do not create new workflow runs" —
    // workflow_run is not exempt. So protected-release's completion, when dispatched this way, can
    // never fire a `workflow_run` listener, no matter what is on its watch list. Checked against
    // live run history 2026-09-27: every corpus-mode protected-release failure from 2026-09-21
    // through 2026-09-27 (nine of them) produced zero ntfy-alerts runs within 15 minutes, including
    // the two that happened AFTER protected-release was added to the watch list on 2026-09-26 —
    // proving the watch-list entry could never have worked regardless of its presence.
    //
    // The fix does not reintroduce the "duplicate polling" #315 removed (two things polling the
    // same run): it is the ONE poller, living here, in the dispatcher — which is the one part of
    // this chain that runs on a genuine `schedule:` trigger, so ITS OWN completion IS a real
    // platform event `workflow_run` correctly fires for (and `corpus-nightly-dispatch` was already,
    // correctly, on ntfy-alerts.yml's watch list). A failed poll or a non-success child conclusion
    // becomes this job's own failure, which the already-working listener then pages on.
    const source = executable(read(DISPATCHER));
    expect(source).toContain('while [ "$(date +%s)" -lt "$deadline" ]; do');
    expect(source).toContain('gh run view "$run_id"');
    expect(source).toContain('sleep 60');
    expect(source).toMatch(/if \[ "\$status" != completed \]; then\s*\n\s*echo "::error::/);
    expect(source).toMatch(/if \[ "\$conclusion" != success \]; then\s*\n\s*echo "::error::/);
    // Both non-success paths exit non-zero -- a red dispatcher is the alert.
    const timeoutBranch = source.split('if [ "$status" != completed ]; then')[1]?.split('fi')[0] || '';
    const conclusionBranch = source.split('if [ "$conclusion" != success ]; then')[1]?.split('fi')[0] || '';
    expect(timeoutBranch).toContain('exit 1');
    expect(conclusionBranch).toContain('exit 1');
  });

  it('stays secret-free while fixing alerting -- exit 1 is the entire mechanism', () => {
    // The dispatcher's zero-secrets boundary (asserted below in the signing/publication-authority
    // test) is deliberate and must survive this fix intact: no direct ntfy call here. A red
    // dispatcher reaches the phone through corpus-nightly-dispatch's own, already-correctly-wired
    // workflow_run listener -- nothing new to leak, nothing new to rotate.
    const source = executable(read(DISPATCHER));
    expect(source).not.toContain('NTFY_TOPIC');
    expect(source).not.toContain('ntfy.sh');
  });

  it('still bounds the poll within its own job timeout, with real margin', () => {
    const source = read(DISPATCHER);
    const jobTimeout = Number((source.match(/timeout-minutes: (\d+)\n\s+permissions:\n\s+contents: read\n\s+actions: write/) || [])[1]);
    const pollBudget = Number((executable(source).match(/deadline=\$\(\( \$\(date \+%s\) \+ (\d+) \* 60 \)\)/) || [])[1]);
    expect(jobTimeout).toBe(360);
    expect(pollBudget).toBeGreaterThan(0);
    expect(pollBudget).toBeLessThan(jobTimeout);
  });

  it('records the dispatch against the exact candidate it dispatched', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('node scripts/corpus-dispatch-receipt.mjs');
    expect(source).toContain('corpus_dispatch_id=$CORPUS_DISPATCH_ID');
    const selector = read('scripts/corpus-dispatch-receipt.mjs');
    expect(selector).toContain('run.head_sha === sha');
    expect(selector).toContain('Date.parse(run.created_at) >= Date.parse(notBefore)');
  });
});

describe('the dispatcher arms only on the owner switch plus a resolved install-verified runtime (ADR-0091 D3)', () => {
  const armedStep = () => read(DISPATCHER)
    .split('name: Stand down unless the owner armed the nightly and an install-verified runtime resolves')[1]
    .split('- name:')[0];

  it('never reads a committed pin; it resolves the approved runtime from the signed install verification', () => {
    const source = read(DISPATCHER);
    expect(source).not.toContain('data/approved-runtime.json');
    expect(armedStep()).toContain('node scripts/approved-runtime.mjs --resolve --repo "$GITHUB_REPOSITORY"');
    // merge-base --is-ancestor needs history, so the checkout must not be shallow.
    expect(source).toMatch(/fetch-depth: 0/);
  });

  it('the kill switch: only CORPUS_NIGHTLY == on arms it; unset or anything else stands down cleanly', () => {
    const step = armedStep();
    expect(step).toContain('CORPUS_NIGHTLY: ${{ vars.CORPUS_NIGHTLY }}');
    const offBranch = step.split('if [[ "${CORPUS_NIGHTLY:-}" != on ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(offBranch).toContain("echo 'armed=false' >> \"$GITHUB_OUTPUT\"");
    expect(offBranch).toContain('corpus-nightly-dispatch is DISARMED');
    expect(offBranch).toContain('exit 0');
    // The switch is checked BEFORE anything is resolved or downloaded.
    expect(step.indexOf('!= on ]]')).toBeLessThan(step.indexOf('approved-runtime.mjs --resolve'));
  });

  // Independent review of ADR-0091 D3 (2026-09-28): NO fallback to an older release. main HEAD must BE
  // the newest install-verified release; otherwise stand down (not yet verified) or fail (evidence bad).
  it('never dispatches an approved runtime that is not exactly main HEAD', () => {
    const step = executable(armedStep());
    expect(step).toContain('if [[ "$approved_sha" != "$CANDIDATE_SHA" ]]; then');
    expect(step).toContain('CANDIDATE_SHA: ${{ steps.candidate.outputs.candidate_sha }}');
  });

  it('distinguishes "not yet verified" (exit 3: stand down) from invalid evidence (anything else: loud)', () => {
    const step = executable(armedStep());
    const notYet = step.split('if [[ "$resolve_status" -eq 3 ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(notYet).toContain("echo 'armed=false'");
    expect(notYet).toContain('exit 0');
    const loud = step.split('if [[ "$resolve_status" -ne 0 ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(loud).toContain('::error::');
    expect(loud).toContain('exit 1');
    expect(step.indexOf('-eq 3 ]]')).toBeLessThan(step.indexOf('-ne 0 ]]'));
  });
  it('dispatches the RESOLVED identity, and every step that can reach the release rail is gated on armed', () => {
    const source = read(DISPATCHER);
    const dispatchStep = source.split('name: Dispatch protected-release.yml on protected main in corpus mode')[1].split('- name:')[0];
    expect(dispatchStep).toContain("if: steps.armed.outputs.armed == 'true'");
    expect(dispatchStep).toContain('CANDIDATE_SHA: ${{ steps.armed.outputs.approved_sha }}');
    expect(dispatchStep).toContain('--ref main');
    // The run-record selector still matches the dispatched run by ITS head (main HEAD), not the corpus source.
    const record = source.split('name: Record the target run this schedule actually created')[1].split('- name:')[0];
    expect(record).toContain('CANDIDATE_SHA: ${{ steps.candidate.outputs.candidate_sha }}');
    expect(dispatchStep).toContain('CANDIDATE_VERSION: ${{ steps.armed.outputs.approved_version }}');
    const gated = source.match(/if: steps\.armed\.outputs\.armed == 'true'/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(2);
    expect(armedStep()).toContain("echo 'armed=true'");
  });
});

// Behaviour, not text: execute the real `armed` step's bash with CORPUS_NIGHTLY=on, crossing the process
// boundary. `git fetch` is stubbed (no network); everything else is real bash + real node.
describe('the armed step, executed (independent review of ADR-0091 D3)', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
  const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-armed-')); dirs.push(dir); return dir; };
  const HEAD_SHA = 'a'.repeat(40);

  const script = () => {
    const step = read(DISPATCHER)
      .split('name: Stand down unless the owner armed the nightly and an install-verified runtime resolves')[1]
      .split('- name:')[0];
    const lines = step.split('run: |\n')[1].split('\n');
    const indent = lines[0].match(/^ */)[0].length;
    return lines.map((line) => line.slice(indent)).join('\n');
  };

  /** Run the step. `resolver`: { status, release } fakes approved-runtime.mjs; or { gh } runs the REAL resolver against a fake gh. */
  function runArmed({ resolver, candidateVersion = '9.0.10' }) {
    const dir = tmp();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n[ "$1" = fetch ] && exit 0\nexec ${JSON.stringify(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim())} "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    if (resolver.release !== undefined || resolver.status !== undefined) {
      fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(resolver.release ?? {}));
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
if [ "$1" = scripts/approved-runtime.mjs ]; then cat ${JSON.stringify(path.join(dir, 'release.json'))}; exit ${resolver.status ?? 0}; fi
exec ${JSON.stringify(process.execPath)} "$@"\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    }
    fs.chmodSync(path.join(bin, 'node'), 0o755);
    const output = path.join(dir, 'github-output');
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', ['-c', script()], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CORPUS_NIGHTLY: 'on', GITHUB_OUTPUT: output, RUNNER_TEMP: dir, GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
        CANDIDATE_SHA: HEAD_SHA, CANDIDATE_VERSION: candidateVersion,
        ...(resolver.gh ? { RUVNET_GH_COMMAND: resolver.gh } : {}),
      },
    });
    return { ...result, output: fs.readFileSync(output, 'utf8') };
  }

  const fakeGh = (withAggregate) => {
    const dir = tmp();
    const script = path.join(dir, 'gh.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'list') { process.stdout.write(JSON.stringify([{ tagName: 'v9.0.10' }, { tagName: 'v9.0.2' }])); process.exit(0); }
if (args[0] === 'api') {
  const assets = [{ name: 'ruvnet-brain.zip' }];
  if (${withAggregate}) assets.push({ name: 'public-verification-aggregate.json' });
  process.stdout.write(JSON.stringify({ assets })); process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], args[args.indexOf('--pattern') + 1]), '{"verdict":"PASS","forged":true}');
  process.exit(0);
}
process.exit(9);
`);
    const wrapper = path.join(dir, 'gh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  };

  it('REAL resolver, newest release has no aggregate yet -> stands down cleanly (exit 0, armed=false)', () => {
    const result = runArmed({ resolver: { gh: fakeGh(false) } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('armed=false');
    expect(result.output).not.toContain('armed=true');
    expect(result.stdout).toMatch(/not reached install-verified yet/);
  });

  it('REAL resolver, newest release aggregate present but invalid -> fails LOUDLY (exit 1), never an older release', () => {
    const result = runArmed({ resolver: { gh: fakeGh(true) } });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('armed=true');
    expect(result.stdout).toMatch(/::error::.*does not hold/);
    expect(result.stderr).toMatch(/v9\.0\.10 \(the newest\)[\s\S]*refusing to fall back/);
  });

  it('newest verified release is exactly main HEAD -> armed with that identity', () => {
    const result = runArmed({ resolver: { release: { tag: 'v9.0.10', version: '9.0.10', sourceSha: HEAD_SHA } } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('armed=true');
    expect(result.output).toContain(`approved_sha=${HEAD_SHA}`);
  });

  it('main HEAD is a newer version not yet verified -> stands down; the older verified release is NOT dispatched', () => {
    const result = runArmed({ candidateVersion: '9.0.11',
      resolver: { release: { tag: 'v9.0.10', version: '9.0.10', sourceSha: 'b'.repeat(40) } } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('armed=false');
    expect(result.output).not.toContain('armed=true');
    expect(result.output).not.toContain('b'.repeat(40));
  });

  it('same version verified at a different commit than main HEAD -> loud failure', () => {
    const result = runArmed({ resolver: { release: { tag: 'v9.0.10', version: '9.0.10', sourceSha: 'b'.repeat(40) } } });
    expect(result.status).toBe(1);
    expect(result.output).not.toContain('armed=true');
    expect(result.stdout).toMatch(/::error::release v9\.0\.10 was verified at b{40}/);
  });
});
