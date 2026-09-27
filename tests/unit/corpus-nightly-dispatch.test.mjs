import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
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

describe('the dispatcher is disarmed until step 16 has shipped (ADR-086 A7 ordering)', () => {
  it('stands down cleanly rather than dispatching before an owner-gated code release pins the runtime', () => {
    const source = read(DISPATCHER);
    expect(source).toContain('if [[ -s data/approved-runtime.json ]]; then');
    expect(source).toContain("echo 'armed=true' >> \"$GITHUB_OUTPUT\"");
    expect(source).toContain("echo 'armed=false' >> \"$GITHUB_OUTPUT\"");
    expect(source).toContain('corpus-nightly-dispatch is DISARMED');
    // Every step that can reach the release rail is gated on the armed state.
    const gated = source.match(/if: steps\.armed\.outputs\.armed == 'true'/g) || [];
    expect(gated.length).toBeGreaterThanOrEqual(2);
    const dispatchStep = source.split('name: Dispatch protected-release.yml on protected main in corpus mode')[1].split('- name:')[0];
    expect(dispatchStep).toContain("if: steps.armed.outputs.armed == 'true'");
    // Disarmed is NOT a failure: a nightly red X for a correctly-disarmed scheduler trains the owner
    // to ignore the alert that matters.
    const armedStep = source.split('name: Stand down until an owner-gated code release has armed unattended promotion')[1].split('- id:')[0].split('- name:')[0];
    expect(armedStep).not.toContain('exit 1');
    expect(armedStep).not.toContain('::error::');
  });
});
