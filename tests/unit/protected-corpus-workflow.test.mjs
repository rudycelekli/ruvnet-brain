import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const workflow = () => read('.github/workflows/protected-release.yml');
const seedWorkflow = () => read('.github/workflows/corpus-seed.yml');

const CODE_JOBS = ['identity', 'verified-candidate', 'seal-payload', 'publish', 'public-verification', 'finalize-public-verification'];
const CORPUS_JOBS = ['corpus-identity', 'corpus-prepare', 'corpus-no-change', 'corpus-authorize', 'corpus-publish', 'corpus-terminal-outcome'];

/**
 * Comments stripped, exactly as scripts/release-authority.mjs:16-23 does before it looks for
 * publication actions. This repo has burned itself twice on prose-matching gates — wired-check v1
 * counted a comment as a caller, and the #84 guard flagged a comment that merely NAMED a variable —
 * so a forbidden-token scan here must read what the runner executes, not what the file explains.
 */
const executable = (block) => block
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** Split a workflow into `{ name: body }`. Job headers are the only keys at exactly two spaces. */
function jobBlocks(source) {
  const jobsAt = source.indexOf('\njobs:\n');
  expect(jobsAt, 'workflow must declare jobs').toBeGreaterThan(-1);
  const body = source.slice(jobsAt + '\njobs:\n'.length);
  const headers = [...body.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)];
  const blocks = {};
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : body.length;
    blocks[match[1]] = body.slice(start, end);
  });
  return blocks;
}

describe('protected-release corpus chain (ADR-086 steps 9 + 17)', () => {
  it('declares exactly the two chains, with no job left ungated', () => {
    const blocks = jobBlocks(workflow());
    expect(Object.keys(blocks)).toEqual([...CODE_JOBS, ...CORPUS_JOBS]);
    for (const job of CODE_JOBS) {
      expect(blocks[job], `${job} must be skipped in corpus mode`).toContain("if: inputs.mode != 'corpus'");
    }
    for (const job of CORPUS_JOBS) {
      expect(blocks[job], `${job} must run only in corpus mode`).toContain("inputs.mode == 'corpus'");
    }
  });

  it('WRONG MODE: the corpus identity job refuses a run that is not actually corpus mode', () => {
    const blocks = jobBlocks(workflow());
    // The `if:` selects; this asserts. Belt and braces on purpose: an `if:` typo silently skips a
    // job, while a failed `test` inside it is loud.
    expect(blocks['corpus-identity']).toContain('test "$RELEASE_MODE" = corpus');
    expect(workflow()).toContain("RELEASE_MODE: ${{ inputs.mode || 'code' }}");
  });

  it('CAPABILITY BOUNDARY: no corpus job can reach npm publication', () => {
    const blocks = jobBlocks(workflow());
    for (const job of CORPUS_JOBS) {
      const block = executable(blocks[job]);
      for (const forbidden of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'registry-url', 'npm publish', 'npm dist-tag', 'id-token']) {
        expect(block, `${job} must not carry ${forbidden}`).not.toContain(forbidden);
      }
      expect(block, `${job} must never bind the npm-scoped environment`).not.toContain('Production – ruvnet-brain');
      expect(block, `${job} must never invoke the product publisher`).not.toMatch(/release\.mjs --publish/);
    }
    // The code chain's environment binding count is unchanged by this work.
    expect(workflow().match(/environment: Production – ruvnet-brain/g)).toHaveLength(3);
    expect(workflow().match(/environment: Production – corpus/g)).toHaveLength(1);
    expect(blocks['corpus-publish']).toContain('environment: Production – corpus');
    expect(blocks['corpus-publish']).toContain('node scripts/release.mjs --corpus-seed --promote-latest');
  });

  it('TRACKED PATHS: every corpus payload lands in runner storage and the checkout stays clean', () => {
    const blocks = jobBlocks(workflow());
    const publish = blocks['corpus-publish'];
    expect(publish).toContain('"$RUNNER_TEMP/corpus-prepared.zip"');
    expect(publish).toContain('unzip -q "$RUNNER_TEMP/corpus-prepared.zip" -d "$RUNNER_TEMP/corpus-import"');
    // The known open correction: the code lane unzips into `release-evidence/` INSIDE the checkout
    // (protected-release.yml's verified-candidate job). A corpus job doing that would fail its own
    // clean-worktree assertion.
    for (const job of CORPUS_JOBS) {
      expect(executable(blocks[job]), `${job} must not import into the checkout`).not.toContain('release-evidence');
    }
    // Asserted after import, after re-verification, after signing, and on both sides of publication.
    expect((publish.match(/test -z "\$\(git status --porcelain\)"/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it('WRONG DIGEST: the publisher re-measures the archive and receipt against the sealed identities', () => {
    const publish = jobBlocks(workflow())['corpus-publish'];
    expect(publish).toContain('EXPECTED_ARCHIVE_SHA256: ${{ needs.corpus-prepare.outputs.archive_sha256 }}');
    expect(publish).toContain('EXPECTED_RECEIPT_SHA256: ${{ needs.corpus-prepare.outputs.receipt_sha256 }}');
    expect(publish).toContain('test "$archive_sha256" = "$EXPECTED_ARCHIVE_SHA256"');
    expect(publish).toContain('test "$receipt_sha256" = "$EXPECTED_RECEIPT_SHA256"');
    expect(publish).toContain('grep -Fxq "candidate_sha=$CANDIDATE_SHA" "$staged/corpus-preparation.identity"');
    // Shape and digests are not truth. The candidate is re-derived from the archive's own bytes.
    expect(publish).toContain('node scripts/corpus-candidate.mjs --verify');
  });

  it('WRONG RUNTIME BYTES: promotion is refused unless the archive ships the approved shipped runtime', () => {
    const blocks = jobBlocks(workflow());
    expect(workflow()).not.toContain('data/approved-runtime.json'); // ADR-0091 D3: never a committed pin
    expect(blocks['corpus-identity']).toContain('node scripts/approved-runtime.mjs --resolve --repo "$GITHUB_REPOSITORY"');
    expect(blocks['corpus-publish']).toContain('node scripts/approved-runtime.mjs --verify --archive-manifest');
    const publish = blocks['corpus-publish'];
    // The publisher re-resolves EXACTLY the release identity approved, on its own runner, requires it to
    // name this candidate, and verifies against that pin — it never trusts a pin handed over as output.
    expect(publish).toContain('--resolve --repo "$GITHUB_REPOSITORY" --tag "$APPROVED_TAG"');
    expect(publish).toContain('--pin "$RUNNER_TEMP/approved-runtime.json"');
    expect(publish.indexOf('approved-runtime.mjs --resolve')).toBeLessThan(publish.indexOf('approved-runtime.mjs --verify'));
    // The pin must be checked BEFORE anything is signed: a signature over unapproved executables is
    // the exact artifact this guard exists to never produce.
    expect(publish.indexOf('approved-runtime.mjs --verify')).toBeLessThan(publish.indexOf('sign-bundle.mjs'));
  });

  it('SIGNATURE: the existing signing implementation produces it and the existing verifier proves it', () => {
    const publish = jobBlocks(workflow())['corpus-publish'];
    const sign = publish.indexOf('node scripts/sign-bundle.mjs --bundle');
    const verify = publish.indexOf('node scripts/verify-bundle.mjs');
    const release = publish.indexOf('node scripts/release.mjs --corpus-seed');
    expect(sign).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(sign);
    expect(release).toBeGreaterThan(verify);
    expect(publish).toContain('RUVNET_SIGNING_KEY: ${{ secrets.RUVNET_SIGNING_KEY }}');
  });

  it('STALE / CONCURRENT: corpus and code promotion serialize in one group that never cancels', () => {
    const source = workflow();
    expect(source).toContain('group: ruvnet-brain-release');
    expect(source).toContain('cancel-in-progress: false');
    // One group for both modes: two release-moving runs must never overlap.
    expect(source.match(/^concurrency:$/gm)).toHaveLength(1);
  });

  it('NO-CHANGE ROUND: an unchanged reconciliation publishes nothing and mints no tag', () => {
    const blocks = jobBlocks(workflow());
    const unchanged = "needs.corpus-prepare.outputs.archive_sha256 == needs.corpus-prepare.outputs.seed_sha256";
    const changed = "needs.corpus-prepare.outputs.archive_sha256 != needs.corpus-prepare.outputs.seed_sha256";
    expect(blocks['corpus-no-change']).toContain(unchanged);
    expect(blocks['corpus-authorize']).toContain(changed);
    expect(blocks['corpus-publish']).toContain(changed);
    expect(blocks['corpus-no-change']).not.toContain('release.mjs');
  });

  it('ORDER: authenticate, then import, then publish — bound to the authorized candidate SHA', () => {
    const blocks = jobBlocks(workflow());
    expect(blocks['corpus-prepare']).toContain('uses: ./.github/workflows/corpus-seed.yml');
    expect(blocks['corpus-authorize']).toContain('needs: [corpus-identity, corpus-prepare]');
    expect(blocks['corpus-publish']).toContain('needs: [corpus-identity, corpus-prepare, corpus-authorize]');
    expect(blocks['corpus-publish']).toContain('CORPUS_ARTIFACT_ID: ${{ needs.corpus-authorize.outputs.artifact_id }}');
    // main can move during a multi-hour preparation; the publisher must stay on the SHA that was
    // authorized, or it would ship a runtime nobody checked.
    expect(blocks['corpus-publish']).toContain('ref: ${{ needs.corpus-identity.outputs.candidate_sha }}');
    expect(blocks['corpus-publish']).toContain('test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"');
  });
});

describe('corpus-seed.yml preparation contract', () => {
  it('holds no publication authority of its own', () => {
    const source = seedWorkflow();
    expect(source).toMatch(/^permissions:\n {2}actions: read\n {2}contents: read$/m);
    for (const forbidden of ['gh release create', 'gh release edit', 'npm publish', 'npm dist-tag', 'RUVNET_SIGNING_KEY', 'NPM_TOKEN', 'environment:']) {
      expect(executable(source), `corpus-seed.yml must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('accepts a runtime seed override only as a complete content-addressed identity', () => {
    const source = seedWorkflow();
    expect(source).toContain('a runtime seed override must supply seed_tag, seed_sha256 and seed_bytes together');
    expect(source).toContain("[[ \"$INPUT_SEED_SHA256\" =~ ^[0-9a-f]{64}$ ]]");
    expect(source).toContain("[[ \"$INPUT_SEED_BYTES\" =~ ^[1-9][0-9]*$ ]]");
    expect(source).toContain('seed_tag must never be the mutable latest pointer');
    // No override supplied → the committed bootstrap/recovery pointer, unchanged.
    expect(source).toContain('RESOLVED_SEED_ORIGIN=committed-bootstrap');
    expect(source).toContain('RESOLVED_SEED_ORIGIN=runtime-generation');
    // And the seed digest is still checked against the downloaded bytes.
    expect(source).toContain('sha256sum --check --strict');
  });

  it('uploads one flat artifact root outside the tracked tree, with the identities the consumer checks', () => {
    const source = seedWorkflow();
    expect(source).toContain('path: ${{ runner.temp }}/corpus-prepared/');
    expect(source).not.toMatch(/path: \|\n(\s+\S+\n)*\s+release-evidence\//);
    for (const output of ['artifact_name', 'archive_sha256', 'receipt_sha256', 'seed_sha256']) {
      expect(source, `workflow_call must expose ${output}`).toContain(`${output}:\n        description:`);
    }
    expect(source).toContain('RUVNET_GISTS_TOKEN:');
  });
});

describe('missing owner prerequisites fail loudly rather than silently', () => {
  it('names the exact owner action when the corpus signing environment has no key', () => {
    // GitHub auto-creates an unknown environment with no secrets, so `Production – corpus` being
    // absent yields an EMPTY key rather than a failed job. An empty key must be named, not inferred.
    const publish = jobBlocks(workflow())['corpus-publish'];
    expect(publish).toContain('if [[ -z "${RUVNET_SIGNING_KEY:-}" ]]; then');
    expect(publish).toContain('OWNER ACTION: create the environment `Production – corpus`');
    // The message must NOT spell the npm token's literal name: the capability gate above is a
    // string match, and a gate that has to allow one spelling in prose can be defeated by that
    // spelling in code. Prose gives way to the gate, never the other way round.
    expect(publish).toMatch(/hold no npm publication credential/);
    const guard = publish.split('if [[ -z "${RUVNET_SIGNING_KEY:-}" ]]; then')[1].split('fi')[0];
    expect(guard).toContain('exit 1');
    // And it fires before signing is attempted.
    expect(publish.indexOf('RUVNET_SIGNING_KEY:-')).toBeLessThan(publish.indexOf('node scripts/sign-bundle.mjs'));
  });

  it('builds ONLY at exact protected main HEAD, which must BE the newest install-verified release (no ancestor, no fallback)', () => {
    // Independent review of ADR-0091 D3 (2026-09-28): accepting an ancestor of GITHUB_SHA let the
    // unattended job promote an OLDER runtime over the live code release as releases/latest.
    const blocks = jobBlocks(workflow());
    const identity = blocks['corpus-identity'];
    expect(identity).toContain('test "$GITHUB_SHA" = "$EXPECTED_SHA"');
    expect(identity).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
    expect(identity).toContain('test "$(git rev-parse origin/main)" = "$EXPECTED_SHA"');
    expect(identity).toContain('test "$(node -p "require(\'./package.json\').version")" = "$EXPECTED_VERSION"');
    expect(workflow()).not.toContain('merge-base --is-ancestor');
    // The candidate must be exactly the resolved approved source, and the refusal says why.
    const guard = identity.split('if [[ "$approved_sha" != "$EXPECTED_SHA" ]]; then')[1].split(/\n\s*fi\n/)[0];
    expect(guard).toContain('is not the approved runtime');
    expect(guard).toContain('exit 1');
    // ADR-0091 D4: the seed chain no longer consults the pin. It is judged by the approved runtime's
    // own readers (the source corpus-prepare builds at), materialized from EXPECTED_SHA.
    const seedStep = identity.slice(identity.indexOf('node scripts/corpus-next-seed.mjs'));
    expect(seedStep.split('\n').slice(0, 3).join('\n')).not.toMatch(/--pin/);
    expect(identity).toContain('git worktree add --detach "$approved_source" "$EXPECTED_SHA"');
    expect(identity).toContain('--runtime-root "$approved_source" --out "$RUNNER_TEMP/next-seed.json"');
    expect(identity.indexOf('git worktree add --detach "$approved_source"')).toBeLessThan(identity.indexOf('corpus-next-seed.mjs'));
    expect(identity.indexOf('approved-runtime.mjs --resolve')).toBeLessThan(identity.indexOf('corpus-next-seed.mjs'));
    // Provenance binds the run AND the artifact to the one candidate identity.
    const authorize = blocks['corpus-authorize'];
    expect(authorize).not.toContain('RUN_HEAD_SHA');
    expect(authorize).toContain('run.head_sha === sha');
    expect(authorize).toContain('artifact.workflow_run.head_sha === sha');
    expect(authorize).toContain('const artifactName = `corpus-seed-prepared-${sha}`');
    // The code that verifies, signs and publishes runs at THIS run's own commit, never an older one.
    const publish = blocks['corpus-publish'];
    expect(publish).toContain('test "$CANDIDATE_SHA" = "$GITHUB_SHA"');
    expect(publish).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(publish.indexOf('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"')).toBeLessThan(publish.indexOf('sign-bundle.mjs'));
  });
});
