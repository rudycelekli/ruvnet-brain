Updated: 2026-09-26 09:29:53 EDT | Version 1.0.1
Created: 2026-07-29 22:24:00 EDT

# RuvNet Brain 4.0 Agentic-QE master plan

## Decision and ownership

This is the stored, executable quality contract for the 4.0 release. It is a
two-model review:

- GPT-5 owns the integration, security, packaging, and release-candidate lane.
- GPT-5.6 independently owns the risk model, coverage contract, live-toolchain
  checks, and resource-lifecycle adversarial tests.

Passing this plan is necessary for release. It is not a promise that software
can never have another defect. The defensible promise is narrower: every known
P0/P1 risk has a falsifiable gate, the gate is bound to the actual artifact or
runtime it claims to test, failures cannot be rendered as success, and the
matrix fails when a required test disappears.

ADR-011 is Accepted but not fully Implemented; this plan advances its
machine-checkable quality program. ADR-052 is Accepted; its five 4.0
preconditions remain the release authority. ADR-053 is Accepted; the tests
below use its experience-level approach rather than line coverage alone.

## Test regimes

| Regime | Scope | Network | Mutates real user state | Release meaning |
|---|---|---:|---:|---|
| H — hermetic | temp homes, temp AgentDB stores, packed local artifact, stub children | no | no | required on every candidate |
| A — artifact | `npm pack`, unpacked install, signature/digest, exact files | no | no | required on every candidate |
| L — live machine | installed global Ruflo, Agentic-QE, active Brain worker | local tools may load models | no; temp projects only | required before declaring the machine healthy |
| C — channel | exact-SHA CI, npm, GitHub Release, signed release assets, clean install | yes | immutable publication only after all earlier gates | required before “shipped” |

Unknown, skipped, unavailable, quota-limited, or degraded is never PASS. A
process exit code is not enough: each live test asserts substantive output or
retrieved state.

## Executable risk matrix

The `QE-*` identifiers below are parsed by
`tests/qe/gpt56/critical-risk-map.test.mjs`. Deleting or renaming a mapped test
breaks the contract.

| ID | Priority | Domain | Failure being prevented | Primary executable evidence | Regime |
|---|---:|---|---|---|---|
| QE-INS-001 | P0 | installer | npm tarball omits the files the installer resolves | `tests/qe/release/packed-clean-install.test.mjs` | A |
| QE-INS-002 | P0 | installer | retry tears or rewrites a working Codex registration | `tests/unit/npm-tarball-codex.test.mjs` | A |
| QE-HOST-001 | P0 | Claude/Codex parity | one host lacks lifecycle, grounding, write, or learning hooks | `tests/unit/codex-lifecycle-hooks.test.mjs` | H |
| QE-HOST-002 | P1 | Claude/Codex parity | `/rvbc` or console invocation is discoverable on only one host | `tests/unit/codex-console-invocation.test.mjs` | H |
| QE-UPD-001 | P0 | update trust | traversal or symlink payload escapes the version root | `tests/qe/security/release-abuse-cases.test.mjs` | H |
| QE-UPD-002 | P0 | update recovery | a broken candidate destroys the last known-good generation | `tests/qe/release/stable-spine-recovery.test.mjs` | H |
| QE-MEM-001 | P0 | AgentDB/Ruflo | a write exits zero but cannot be found through the real search path | `tests/unit/learning-replay.test.mjs` | H/L |
| QE-MEM-002 | P0 | AgentDB/Ruflo | project A memory silently contaminates project B | `tests/qe/gpt56/live-toolchain-health.test.mjs` | L |
| QE-CON-001 | P0 | 1–5 control | the advocacy dial is cosmetic or persisted to the wrong file | `tests/unit/console-advocacy-dial.test.mjs` | H |
| QE-CON-002 | P0 | honest measurement | empty evidence is displayed as a fabricated precision score | `tests/unit/console-advocacy-precision.test.mjs` | H |
| QE-RES-001 | P0 | resources | an idle Brain child remains resident indefinitely | `tests/unit/mcp-timeout-outage.test.mjs` | H |
| QE-RES-002 | P0 | resources | idle retirement kills an in-flight or concurrent query | `tests/qe/gpt56/worker-concurrency-retirement.test.mjs` | H |
| QE-REL-001 | P0 | provenance | GitHub Release, tag, assets, and npm are not one exact candidate | `tests/unit/public-verification-lane.test.mjs` | A/C |
| QE-REL-002 | P0 | clean install | source checkout masks a missing published file | `tests/qe/release/packed-clean-install.test.mjs` | A |
| QE-FLT-001 | P0 | fault injection | timeout burns CPU while stale health remains green | `tests/unit/mcp-timeout-outage.test.mjs` | H |
| QE-FLT-002 | P0 | recovery | compression bomb or deceptive expansion leaves partial output | `tests/qe/security/release-abuse-cases.test.mjs` | H |
| QE-TOOL-001 | P0 | QE toolchain | Agentic-QE prints initialization failure but exits zero | `tests/qe/gpt56/live-toolchain-health.test.mjs` | L |
| QE-TOOL-002 | P1 | QE toolchain | coverage absence is mislabeled as measured 0% | live `hooks_coverage_gaps`; evidence rules below | L |
| QE-BRN-001 | P0 | source grounding | `search_ruvnet` is registered but the live worker times out | `tests/qe/gpt56/live-brain-search.test.mjs` | L |

## Exhaustive scenario inventory

### Installer and host parity

- Empty home, existing Claude-only home, existing Codex-only home, both hosts,
  neither host, paths containing spaces and quotes.
- First install, reinstall, interrupted write, stale managed block, user-owned
  conflicting block, missing source, packed artifact only.
- Claude and Codex event-name translation, raw tool-name translation,
  advisory/blocking parity, skill discovery, MCP initialize/tools-list/call.
- Explicit alias coverage for `/rvbc`, `/rvcb`, `/brain-console`, and the native
  Codex skill surface.

### Update trust and recovery

- Exact version grammar, traversal, absolute paths, separators, shell-looking
  bytes, nested symlinks, symlinked root, FIFO/device rejection.
- Missing/wrong/tampered Ed25519 signature; missing digest; mismatched bundle
  version; tag collision; exact-SHA release binding.
- Crash before copy, during copy, before active flip, after active flip, and
  during garbage collection.
- Retry idempotency, rollback, lease-held generation preservation, last-known-
  good preservation, archive count/size/ratio ceilings.

### AgentDB and learning across projects

- Initialize, store, retrieve, keyword search, semantic search, and substantive
  hit assertion through the global Ruflo binary.
- Two independent source projects promote only after the real twice-observed
  rule; a third project receives only promoted knowledge.
- Per-project operational memory remains isolated; explicit `--path` never
  silently falls back to another store.
- Concurrent append-only checkpoints do not overwrite each other.
- WAL-safe backup, distillation, corruption detection, false exit-zero
  retrieval, empty-store control, process restart, and nightly generation
  replacement.

### Console and proactivity

- Levels 1–5 have observably different delivery behavior and preserve legacy
  migration semantics.
- Invalid dial values fail without touching the settings file.
- Precision is “accruing/not judgeable” at n=0, shows n and interval when
  evidence exists, and never uses a point estimate without sample size.
- Console cache is project-scoped and never displays another project’s memory
  or capability state.

### Performance and resource lifecycle

- Cold start and warm request budgets are measured separately.
- Timeout kills the abandoned worker, marks health down, and recovers lazily.
- Idle retirement occurs only with zero pending work.
- Concurrent and in-flight calls survive the idle deadline; exactly one
  replacement starts after the quiescent interval.
- Repeated timeouts cannot accumulate children, leases, timers, or model
  workers.

### Release and channel provenance

- The candidate is a clean immutable commit.
- Full local gates and exact-SHA required CI are green before publication.
- Bundle, `.sig`, and `.sha256` are created before the first remote mutation.
- The remote tag resolves to the candidate commit, including annotated tags.
- npm version/dist-tag, GitHub Release, manifest, installed artifact, and
  self-update all agree.
- A fresh isolated install is exercised from the downloaded/published artifact,
  never from checkout files.

## Agentic-QE and evidence integrity

The real Agentic-QE CLI is used when it is healthy. The 2026-07-29 live run
found:

1. `agentic-qe health --format json` printed `Failed to initialize
   UnifiedMemoryManager` and `NODE_MODULE_VERSION` mismatch, then exited `0`.
   `QE-TOOL-001` therefore inspects output, not only exit status.
2. Ruflo `hooks_coverage_gaps` returned 145 source files at literal `0%` while
   no coverage artifact was supplied. Until the tool distinguishes “not
   measured” from zero, that output is a routing hint only, never a quality
   score. `QE-TOOL-002` may pass only when a pinned coverage artifact is named
   and its measured denominator is non-zero.
3. A live `search_ruvnet` call ended with `brain worker timed out after 240s on
   tools/call`. Registration and tools/list are not health evidence;
   `QE-BRN-001` requires a substantive source result.

## Commands

Hermetic and artifact lanes:

```bash
npx vitest run --config tests/qe/gpt56/vitest.config.mjs
npx vitest run --config tests/qe/release/vitest.config.mjs
npx vitest run tests/unit/codex-lifecycle-hooks.test.mjs tests/unit/codex-console-invocation.test.mjs tests/unit/npm-tarball-codex.test.mjs tests/unit/learning-replay.test.mjs tests/unit/console-advocacy-dial.test.mjs tests/unit/console-advocacy-precision.test.mjs tests/unit/mcp-timeout-outage.test.mjs
```

Live machine lane (uses throwaway projects; never the current AgentDB):

```bash
RUVNET_QE_LIVE=1 npx vitest run --config tests/qe/gpt56/vitest.config.mjs tests/qe/gpt56/live-toolchain-health.test.mjs
```

The live Brain source-result smoke is intentionally separate because a cold
model load can be minutes. It must run through the active MCP before shipping,
and its receipt must name a real returned `repo/path`.

## Exit policy

- P0 FAIL: stop release and fix.
- P0 UNKNOWN/SKIP/DEGRADED: stop release; gather the missing evidence.
- P1 FAIL: stop 4.0 unless the owner explicitly accepts a time-bounded,
  documented exception.
- P2 FAIL: may ship only when it cannot invalidate a user-facing claim or
  security boundary and a dated issue owns it.
- No percentage or score is reported without the artifact, numerator,
  denominator, exclusions, and exact source state.
