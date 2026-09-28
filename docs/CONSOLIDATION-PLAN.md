# Consolidation Plan — fewer seams, proven at real entry points

> **Superseded 2026-09-26** — history only. Current status lives in docs/WORK-REGISTER.md.

Updated: 2026-07-13

`Created: 2026-07-13` · The plan Stuart approved after the 2.5.x diagnosis. **Read this first after any compaction.**

## The diagnosis this exists to fix

Tonight (2026-07-12/13) I added **10 new components**; the repo now has **52 scripts**.
**Zero of the night's failures were component bugs. Every single one was a SEAM** — the piece worked,
and nothing connected it:

| piece | worked? | the seam that didn't exist |
|---|---|---|
| gong system | ✅ | job liveness |
| nightly script | ✅ | launchd's working directory |
| `metaharness-router.mjs` (7 tests) | ✅ | **the engine that actually runs** |
| the engine | ✅ | the npm `files` whitelist |
| dispatch hook | ✅ | other users' consent |
| the test suite | ✅ | Windows spawn latency |

**I test what I build. I do not test what CONSUMES what I build.** Seams grow ~n², verification grows
~n — so v2.5 is *more capable and less trustworthy* than v1.5. That is real, not an excuse.

## The rule that changes (the actual fix)

> **DONE means: a test runs the REAL entry point a user touches — the installed npm package, the
> loaded hook, the CLI — and observes the effect.**
> Unit tests are necessary and INSUFFICIENT. 399 green unit tests coexisted with a shipped lie.

## Phases — in this order, no skipping

### Phase 0 — ENTRY-POINT TESTS FIRST (the safety net; do NOT merge anything before this)
Consolidation without a net is just more churn. Write tests that exercise what a user actually runs:
- `npm pack` the tarball → install it into a temp dir → run `bin/install.mjs` offline → assert the
  router tools materialize AND `model-router-engine.mjs` can `import` its deps. (This is the test that
  would have caught `metaharness-router.mjs` missing from `files`.)
- Run `model-router-engine.mjs` as a CLI and assert `routedBy` names WHO decided.
- Run each plugin hook the way Claude Code runs it (stdin JSON → exit code), incl. `route-dispatch.sh`.
- Run `scripts/nightly-watchdog.mjs` against a fixture registry + fixture heartbeats.

### Phase 1 — collapse ROUTING (10 files → 1 entry point)
`model-router-engine` · `model-router-setup` · `model-router-status` · `model-router-outcome` ·
`route-cheap` · `dispatch-receipt` · `metaharness-receipts` · `metaharness-router` · `codex-routed.sh`
· `goldie-research`
→ **one `scripts/router.mjs`** with subcommands (`route` / `setup` / `status` / `receipt` / `receipts`).
Keep `@metaharness/router` as the decision-maker. The local layer stays what it should always have
been: **a price transform** (subscription-covered ⇒ `costPerMTok = 0`).

### Phase 2 — collapse JOB SUPERVISION (4 files → 2)
`nightly-watchdog` + `clear-claude-tmp` + `scheduled-jobs.json` → **one `scripts/jobs.mjs`**
(`watch` / `list` / `clean`). `job-heartbeat.sh` MUST stay a standalone shell script — it wraps
launchd jobs and cannot depend on node.

### Phase 3 — collapse QA GATES into ONE
`falsify.mjs` becomes the single gate and CALLS the others (`sync-version --check`,
`claims-verify`, `no-silent-substitution`). CI runs one command. One gate nobody can forget.

### Phase 4 — DELETE
Anything in `scripts/` not reachable from an entry point or a test. Report the count removed.
**Target: fewer than 30 scripts.** A negative component count is the goal of this release.

### Phase 5 — ONE honest release (2.6.0)
Publish once, with the measured numbers and an explicit "what I did NOT test" section — the way rUv's
ADRs do it (ADR-043 reports a TIE against baseline rather than dressing it as a win).

## Standing rules from this incident
- Never call your own code by a rUv tool's name. `npm run substitution:check` enforces it.
- A check that passes on the bug it was written for is worse than no check. **Re-introduce the bug and
  watch the check fail** before trusting it. (My first "does the package ship what it promises" check
  reported ✅ on the broken state.)
- When I say "shipped," the right question is: **"which entry point did you run, and what did it output?"**
