// scripts/review-model-defaults.mjs — single source for the model IDs this repo SELECTS to run its
// own release-review and dual/tri-host deliberation pipelines (single-source contract B7, see
// scripts/single-source-check.mjs). Every value below is copied verbatim from wherever it used to be
// hard-coded — no ID has changed, so importing these constants changes no behavior.
//
// Two independent generations exist because they were pinned on different dates for different gates;
// they are NOT the same fact and are kept as two separate exports rather than merged into one.

// ── Legacy release-review pair (ADR-072 completion gate + public verification aggregate). ─────────
// Pinned identically, and independently, in three files before this consolidation:
// adr-072-completion.mjs (REQUIRED_REVIEWERS), independent-review-receipt.mjs
// (ALLOWED_INDEPENDENT_REVIEWERS) and public-verification-aggregate.mjs (REQUIRED_REVIEW_MODELS).
export const CLAUDE_FABLE_5_ID = 'claude-fable-5';
export const GPT_5_6_SOL_ID = 'gpt-5.6-sol';
export const LEGACY_REVIEW_MODEL_IDS = Object.freeze([CLAUDE_FABLE_5_ID, GPT_5_6_SOL_ID]);
export const LEGACY_REVIEWER_IDENTITIES = Object.freeze([
  Object.freeze({ identity: CLAUDE_FABLE_5_ID, model: CLAUDE_FABLE_5_ID, provider: 'firstParty' }),
  Object.freeze({ identity: GPT_5_6_SOL_ID, model: GPT_5_6_SOL_ID, provider: 'openai' }),
]);

// ── Native subscription-CLI dual/tri-host pair, verified against the live hosts 2026-09-10/13. ─────
// Pinned identically, and independently, in three files before this consolidation:
// dual-host-deliberation.mjs (TOP_SUBSCRIPTION_MODELS), oracle/producer-hosts.mjs (PRODUCER_MODELS)
// and trismart.mjs's --dry-run summary.
export const DUAL_HOST_MODEL_IDS = Object.freeze({ claude: 'claude-fable-5-1', codex: 'gpt-6-astra' });
export const TRI_HOST_MODEL_IDS = Object.freeze({ ...DUAL_HOST_MODEL_IDS, grok: 'grok-4.6' });
