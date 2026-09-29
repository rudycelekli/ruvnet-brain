// ADR-0091 D5 — per-store failure isolation for corpus reconciliation.
//
// One store failing to refresh must not abort the whole generation. This module owns the three
// pure decisions that make that safe, so the reconciler, the rehearsal and the tests share them:
//
//   1. WHICH failures are retried. Only transient ones (clone, fetch, runner I/O), exactly once, in a
//      fresh worker directory. A corpus-qa failure is never retried: the round-trip sample is
//      deterministic (FNV-1a, corpus-qa.mjs), so a retry re-embeds the whole store to reproduce it.
//      The class comes from WHERE the worker failed and from forge-refresh's exit status, never
//      from log text.
//   2. HOW MANY stores may be carried or missing before the failure is systemic and the generation
//      must fail loudly: carried + missing <= max(3, 5% of eligible).
//   3. WHETHER a degraded generation may be published at all. Installed clients judge every bundle
//      with their INSTALLED validator, and every validator shipped before this change rejects any
//      non-CURRENT eligible row. ADR-0091 D10 therefore gates degraded publication behind a
//      transition release plus a 14-day soak; until D10 records that transition, a degraded
//      generation is built and sealed but never published.

/** kb/forge-refresh.mjs exits with this status when corpus-qa rejected its candidate. */
export const CORPUS_QA_FAILED_EXIT = 3;

export const FAILURE_CLASS = Object.freeze({
  TRANSIENT: 'transient',
  QA: 'qa',
  BUILD: 'build',
  INTEGRITY: 'integrity',
});

/** A worker failure carrying its structured class. `detail` is for logs only, never for shipped rows. */
export class StoreWorkerError extends Error {
  constructor({ store, stage, failureClass, detail = '' }) {
    super(`[corpus-reconcile] ${store}: ${stage} failed (${failureClass})${detail ? ` (${detail})` : ''}`);
    this.name = 'StoreWorkerError';
    this.store = store;
    this.stage = stage;
    this.failureClass = failureClass;
  }
}

export function isRetryable(error) {
  return error instanceof StoreWorkerError && error.failureClass === FAILURE_CLASS.TRANSIENT;
}

/**
 * The shipped, machine-readable reason. Stage and class only: stderr can quote runner paths, and a
 * coverage row travels to every user.
 */
export function failureReason(error) {
  if (error instanceof StoreWorkerError) return `${error.failureClass}: ${error.stage} failed`;
  return `${FAILURE_CLASS.INTEGRITY}: worker failed`;
}

/** Fixed rule: the failure is systemic above max(3, 5% of eligible). */
export function degradedBound(eligibleCount) {
  if (!Number.isSafeInteger(eligibleCount) || eligibleCount < 0) throw new Error('eligible count must be a non-negative integer');
  return Math.max(3, Math.floor(eligibleCount * 0.05));
}

/**
 * ADR-0091 D10 owns this value. It stays null until the transition release N (the first release
 * shipping the tolerant validator while its own coverage is all-CURRENT) has become releases/latest;
 * D10 then records { version, latestSince } here. Null means no transition: never publish degraded.
 */
export const VALIDATOR_TRANSITION = null;
export const TRANSITION_SOAK_DAYS = 14;

export function degradedPublication({ transition = VALIDATOR_TRANSITION, now = new Date() } = {}) {
  if (!transition) {
    return { allowed: false,
      reason: 'no tolerant-validator transition release is recorded (ADR-0091 D10); installed clients would reject a non-CURRENT row' };
  }
  const since = Date.parse(transition.latestSince);
  if (typeof transition.version !== 'string' || !transition.version || !Number.isFinite(since)) {
    return { allowed: false, reason: 'the recorded validator transition is malformed' };
  }
  const soakEnds = since + TRANSITION_SOAK_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() < soakEnds) {
    return { allowed: false,
      reason: `validator transition ${transition.version} soaks until ${new Date(soakEnds).toISOString()} (ADR-0091 D10)` };
  }
  return { allowed: true, reason: `validator transition ${transition.version} has soaked ${TRANSITION_SOAK_DAYS} days` };
}
