// correction-detect.mjs — decide whether a user utterance is a BEHAVIOURAL CORRECTION.
//
// This is the missing beginning of the learning pipeline. ADR-033 measured the gap: 14 lessons in
// the store, 14 of them transcribed by hand, 0 captured from a live correction. The middle and the
// end were built (store, trust boundary, gate); nothing ever answered "where does a lesson come
// from?". This module answers exactly that question and nothing else — it is pure, does no I/O,
// reads no transcript, writes no store. It is given one utterance and one piece of context, and it
// returns a candidate or, far more often, null.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT THE DETECTOR ADR-033 FIRST DESCRIBED
//
// ADR-033 §1 specifies a conjunction of four signals. Two independent adversarial reviews took that
// specification apart before a line was written, and both were right. The corrections they forced
// are the whole substance of this file:
//
//  • FABLE'S F1 — the load-bearing finding. Signals 2 ("directed at behaviour") and 4 ("negative
//    valence") were specified as semantic-role and sentiment problems with NO lexical realization
//    given, while LLM detection was simultaneously refused — a spec for a deadlock. Worse, a
//    15-utterance hand-walk showed the conjunction as written FIRES on the two classes that
//    dominate a coding transcript:
//
//        "It always crashes when I pass null — fix it."               ← a bug report
//        "Make sure the parser never accepts unquoted keys."          ← spec-speak
//
//    Signal 3 was quantifying over PROGRAM EXECUTIONS and over REQUIREMENTS, not over occasions of
//    agent behaviour, and no stated rule could tell the domains apart. With a 1.2% base rate, the
//    allowed false-positive rate is ~0.07% per turn; requirements dialect natively uses always/never,
//    so that FP class alone buries the detector.
//
//    THE FIX, which is Fable's own (a) and the single most important idea here: Signal 3 does not
//    look for a quantifier. It looks for a quantifier SYNTACTICALLY BOUND TO THE SECOND PERSON —
//    `you always`, `every time you`, `you keep`, `stop <gerund>`, or a quantifier in CLAUSE-INITIAL
//    IMPERATIVE position with nothing but discourse fillers in front of it. "the parser never" has a
//    third-person nominal subject and is refused; "Never just link to the HTML page" has an empty
//    clause prefix and is kept. That one syntactic move is what separates a rule about the agent
//    from a rule about a program, and it is implementable in exactly the lexical terms ADR-033
//    demands.
//
//    Because that same test IS the honest realization of Signal 2 (is the complaint about something
//    the agent did?), signals 2 and 3 are implemented as ONE predicate and said so out loud. Two
//    names for one test would be a claim of independent evidence we do not have — the precise
//    dishonesty lesson-store.mjs was built to refuse elsewhere.
//
//  • SOL'S C5 — the quote must come from the authenticated user utterance, not a reconstruction.
//    `plugin/scripts/ground-ruvnet.sh:19` already reads `.prompt` off the UserPromptSubmit payload;
//    that IS the user's words, structurally labelled as theirs by the harness. Hence the signature:
//    `promptText` is the payload, and `context` carries only what the payload cannot know (what the
//    assistant did immediately before). A transcript is never the source of the words.
//
//  • SOL'S C2 — `makeLesson()` destructures a fixed key list and silently DROPS unknown keys, so
//    every rich evidence field ADR-033 §3 specifies (quote, respondingTo, source, signals) would
//    vanish on the way into the store, leaving the human ratifier with no sentence to read. The one
//    array that passes through whole is `evidence[]`. So everything rides INSIDE evidence[0], and
//    `observed` is populated because `lesson-gate.mjs:75` is what actually prints it.
//
//  • SOL'S C7 + the meta-risk — hypotheticals, delegated instructions ("tell the subagent to
//    always…"), quoted policy, and this repository's OWN design documents (which are wall-to-wall
//    quantified second-person rules) are all live false-positive classes. They are excluded
//    structurally, before any signal is evaluated.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OPERATING POINT, and why silence is the default
//
// ADR-033 §2 settles the asymmetry with a structural argument, not a preference: a miss costs one
// repetition and is SELF-HEALING (the repeat is itself ADR-030's escalation signal). A false
// positive becomes a candidate, then a ratification prompt, then noise the user learns to skip — and
// at the end of that road it reaches ADR-031 §4's objective function, where a search pursues it
// faithfully and at scale. Recall is a convenience. Precision is a safety property.
//
// So this module returns null on every doubt, and several genuine corrections are knowingly let go.
// The accepted misses are enumerated in ACCEPTED_MISSES below rather than left to be rediscovered —
// under-enumeration being its own recorded failure here (L10).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MEASURED ON THE REAL CORPUS, 2026-07-23 — a held-out re-measurement, and what it still does NOT prove
//
// The 2026-07-22 measurement below (n=4, kept for provenance) was two orders of magnitude short of
// ADR-033 §2's ≥100-detection floor, so this round built the harness the floor requires: a candidate
// pool pulled from this project's live transcript corpus (`scripts/correction-detect-measure.mjs`,
// same corpus ADR-033 measured, 1,328 files at the time of this snapshot and still growing — this is
// an active project, not a frozen fixture), SPLIT BY TRANSCRIPT FILE into a 55/45 tune/holdout
// partition BEFORE any hand-labelling — so heuristics were only ever adjusted against the tune half,
// and the numbers below are the detector's FIRST look at the holdout half. Reproduce with
// `node scripts/correction-detect-measure.mjs --dump-pool <path> --split holdout` (expect small drift
// run to run: the corpus is live).
//
//     adjacency-satisfying candidates (signal 1)     1,338   (554 tune / 784 holdout)
//     hand-labelled via a loose superset lexical net    271   (112 tune / 159 holdout)
//
// Five real, load-bearing bugs surfaced by mining the TUNE half (never the holdout — the fifth was
// self-inflicted, caught by the new tests before shipping, not by the holdout), each fixed and
// commented at its site:
//  1. THIRD_PERSON_QUANT was case-sensitive, so its `[A-Z][\w.'-]*` proper-noun catch-all also
//     matched sentence-initial "You" and "I" — silently rejecting this file's OWN canonical example
//     ("You never bump the version.") as third-person. Every shipped positive-table case with that
//     shape only passed because a second sentence happened to mask it.
//  2. BOUND_SECOND_PERSON required "you" to DIRECTLY precede the quantifier, missing the extremely
//     common copula form "you are/were never…", "you're always…".
//  3. No pattern existed for "I never/always want/expect/need you to <verb>" — a quantifier bound to
//     the agent's occasions, just phrased as the speaker's expectation rather than second person.
//  4. `write-code`'s trigger vocabulary had "wrote" but not bare "write/writing/written".
//  5. The FIRST version of fix #2 required whitespace between "you" and the auxiliary — `you\s+(?:
//     are|'re|…)` — which matches "you are never" but not "you're never" (no space before a
//     contraction's apostrophe). Masked the same way as bug #1: an isolated "You're never…" sentence
//     with no other qualifying sentence in the same utterance is what a new regression test caught,
//     before this ever reached measurement.
// Two harness-artifact tags seen live in the corpus (`<local-command-caveat>`, `<task-notification>`)
// were added to HARNESS_TEMPLATES on the same hygiene principle as the existing entries, though
// neither was independently responsible for a false positive — signal 2+3 already killed them.
// One change was TRIED AND REJECTED: raising MAX_UTTERANCE_CHARS (to admit longer real corrections
// that were being length-gated) was tested against the full tune pool at 2000 chars and produced
// exactly one new detection — a false positive (a one-off "get this working perfectly" demand) — and
// not one of the four length-gated true positives it was meant to rescue, because each of those was
// independently blocked by a different signal anyway. Reverted; the 800-char bound stands.
//
// RESULT, holdout half only (the number that counts — nothing above was tuned against it):
//
//     holdout candidates                    784
//     DETECTIONS                              4      0.510% (was 2 pre-fix, same holdout)
//     hand-labelled TRUE (unambiguous)         2      clickable-link's sibling (scores-out-of-100,
//                                                      already known) + "partial solutions" (ship)
//     hand-labelled BORDERLINE                 2      "get the operating guide to the point you'd
//                                                      never repeat this mistake" (finish), and "you're
//                                                      still writing code that fakes results — that's
//                                                      toxic" (write-code) — both defensible, genuinely
//                                                      arguable calls, counted as false positives below
//
//     PRECISION, holdout, strict     2/4 = 50.0%   (only the two unambiguous ones count)
//     PRECISION, holdout, lenient    4/4 = 100%    (if both borderline cases are ratified as real)
//     PRECISION, tune (4 detections, all 4 unambiguous — but this is the set the fixes were derived
//                      against, so it is not independent evidence; reported for completeness only)
//                4/4 = 100%
//     PRECISION, combined (tune+holdout, all 8 detections)   6/8 = 75.0% strict, 8/8 = 100% lenient
//
//     RECALL is the harder number and the one most worth being honest about. Against the 2 unambiguous
//     genuine corrections found by hand-labelling the 159-item holdout pool, recall is 2/2 — but that
//     denominator is too small to mean anything on its own (n=2). Widening the ground truth to every
//     utterance in that same 159 that a human WOULD plausibly ratify as a real standing order — most
//     phrased as an impersonal "it must never / it should always" system-property claim (structurally
//     identical to the bug-report false-positive class Fable's review killed, e.g. "npx/npm/GitHub
//     getting out of sync should never happen" — verified this exact shape also appears as a genuine
//     BUG REPORT elsewhere in the same corpus), or carried only by repeated reproach with no explicit
//     always/never lexeme, or with its trigger vocabulary sitting in a sentence adjacent to — but not
//     inside — the one that actually carries the quantifier (the SAME shape that sank a "always push
//     through them… close the issue and comment" detection in the tune half; deliberately not widened,
//     since re-including neighbour sentences reopens the exact cross-turn vocabulary bug fixed by
//     narrowing to bearing sentences) — puts the denominator closer to 15, of which 2-4 are caught:
//     roughly 15-25%. Ranges are reported because the true denominator is a judgment call, not because
//     any single number flatters the result.
//
// WHAT THIS DOES NOT ESTABLISH, stated plainly because the gate is a number and this is not it:
//  • ADR-033 §2 requires ≥90% precision on ≥100 detections. This round's holdout sample is n=4
//    detections (159 hand-labelled candidates, not 100 detections) — still far short of the floor's
//    actual denominator. Precision measured on so few firings swings by a whole detection: the
//    difference between 50% and 100% here is TWO borderline judgment calls out of four total firings.
//  • The classification is the detector author's own — this has NOT been independently graded, same
//    caveat as 2026-07-22.
//  • The residual misses are not random noise; they cluster in named, understood shapes (impersonal
//    system-property phrasing, adjacent-sentence trigger vocabulary, no-lexical-quantifier reproach
//    chains) that were deliberately left unaddressed because closing them lexically reopens the
//    bug-report and spec-language false-positive classes the original adversarial review killed.
// The honest status: precision on the specific bugs fixed is high (all clean synthetic regression
// cases), two real latent bugs were found and fixed, but the live-corpus holdout sample is both too
// small (n=4) and too ambiguous (half its firings are defensible-but-arguable) to claim it clears
// ADR-033's floor, and the residual recall gap looks structural to a pure-lexical approach on THIS
// corpus, not a tuning oversight. See `scripts/correction-detect-measure.mjs`'s own header for the
// full methodology and how to reproduce or extend this measurement.
//
// ── 2026-07-22 baseline, kept for provenance ───────────────────────────────────────────────────────
// Run over this project's 1,299 transcripts, before any of the fixes above:
//     user-role turns                 2,768
//     with a preceding agent action   1,451
//     DETECTIONS                          4      0.276% of considered turns
// All four hand-classified as genuine durable behavioural corrections. THREE independently
// rediscovered standing orders a human had already transcribed by hand into the project memory index
// — the clickable-link rule, the scores-out-of-100 rule, and "never show me a page you haven't gone
// through and checked visually" (ADR-033 §5's own worked example). Recall then: ~9% against 45+ known
// standing orders. That measurement's own three earlier revisions (temporal-scope double-count, the
// contentless `stop doing that`, and whole-turn trigger inference) remain fixed and commented at their
// sites; nothing about them changed in this round.
//
// WHAT THIS CAN NEVER DO. Every returned candidate is `origin: model-inferred`, `status: candidate`,
// unconditionally — INCLUDING when the user's words are quoted verbatim, and including when the
// utterance is a flawless imitation of a correction. ADR-033 §4: `user-stated` means a human
// asserted this rule, not that a string was found which looks like one. An automatic extractor that
// could mint `user-stated` would be the injection path of the original adversarial review,
// industrialised. `confidence` orders the ratification queue and does nothing else — a confidence
// threshold is just ratification with the human removed and the word "confidence" in front of it.

import { HARNESS_GENERATED_PATTERNS } from '../plugin/scripts/hook-input.mjs';

/** Corrections are short. The measured tightened detector used this bound; specs and briefs exceed it. */
export const MAX_UTTERANCE_CHARS = 800;

/** `makeLesson()` refuses a statement under 15 chars ("must say what to DO, specifically"). */
const MIN_STATEMENT_CHARS = 15;

/** Verbatim is the point (ADR-033 §3), but a ratification card must fit on one screen. */
const MAX_STATEMENT_CHARS = 300;
const MAX_QUOTE_CHARS = 600;

/**
 * Genuine corrections this detector KNOWINGLY drops. Written down because "a satisfyingly round
 * number is evidence of rounding" (L10), and because the next person to widen a rule should have to
 * argue against a named cost rather than discover it.
 */
export const ACCEPTED_MISSES = Object.freeze([
  'Recurrence carried only by "again" with no second-person binding — "I asked for a table. This is prose again."',
  'Bare prohibitions with no scope over occasions — "Don\'t do that." (also below the 15-char statement floor)',
  'Purely positive standing orders with no rejection anywhere — "Always give me a table." is indistinguishable from an ordinary instruction or a project convention.',
  'Corrections whose subject matter maps to no trigger in the closed TRIGGERS enum — a lesson that cannot name when it fires is prose, and the store refuses it anyway.',
  'Corrections phrased as a request to write a rule elsewhere — "add to CLAUDE.md that…" — which are authoring tasks, not corrections of the turn.',
  'Corrections that tie across two or more triggers. They fire at more than one moment, and picking one by list order would interrupt at the wrong one.',
]);

// ── HARD EXCLUSIONS ──────────────────────────────────────────────────────────────────────────────
// Applied before any signal. Each entry killed a real false-positive class, named in the comment.

/**
 * Not an utterance at all. The single highest-scoring hit in ADR-033's measurement was one of these.
 *
 * EXPORTED as of 2026-07-24 so the MEASUREMENT harness can apply the same filter when it writes the
 * hand-labelling pool. It could not before, and the consequence was measured rather than guessed: in
 * a 28-row sample of the holdout pool, EIGHT (29%) were `<local-command-caveat>` blocks — not user
 * speech at all. The detector was right to ignore them; the pool handed them to a human to label
 * anyway, burning ~29% of the scarcest resource in this whole problem (labelled examples) on rows
 * whose answer is definitionally "no", and diluting the base rate with them.
 *
 * H2 (2026-09-26): re-exported from plugin/scripts/hook-input.mjs's HARNESS_GENERATED_PATTERNS
 * rather than kept as this file's own literal array. Other UserPromptSubmit consumers
 * (unprompted-runtime.mjs, capacity-aware-parallel-work.mjs, grounding-turn-mark.mjs) needed the
 * exact same recognition and, before this fix, had no shared place to get it from — hook-input.mjs
 * is that ONE owner now; this name stays so correction-detect-measure.mjs and this file's own test
 * do not need to change.
 */
export const HARNESS_TEMPLATES = HARNESS_GENERATED_PATTERNS;

/**
 * Pasted content, not speech. Includes markdown structure — this repository's own ADRs and DDDs are
 * dense with quantified second-person rules, so its design documents are a minefield for its own
 * detector (Sol C7, meta-risk). A document is never a correction.
 */
const DOCUMENT_MARKERS = [
  /```/,                       // code fence
  /^\s*(?:\+\+\+|---\s|@@ )/m, // diff
  /^\s*#{1,6}\s+\S/m,          // markdown heading
  /^\s*\|.*\|/m,               // markdown table
  /^\s*[-*•]\s+\S/m,           // bullet list
  /^\s*\d+\.\s+\S/m,           // numbered list
  /^\s*\{\s*"/m,               // JSON blob
  /^\s+at\s+\S+\s*\(/m,        // stack frame
];

/**
 * THE INJECTION KILLER. A real user does not refer to themselves in the third person. Every planted
 * "the user told me to always…" — the exact sentence the original adversarial review used to
 * demonstrate the attack — carries this tell, because it is written ABOUT a user by something that
 * is not one.
 */
const USER_THIRD_PERSON = [
  /\bthe user\b/i,
  /\bthe owner\s+(?:said|told|wants|corrected|asked)/i,
  /\buser\s+(?:told|said|corrected|instructed)\s+(?:me|you|us|the model|the assistant)\b/i,
  /\bper the user\b/i,
  /\bas instructed by\b/i,
];

/** Reported policy. Quoting a rule is not issuing one — "CLAUDE.md already says never pin versions". */
const ATTRIBUTION = [
  /\b(?:says?|said|states?|reads?|specifies|requires|mandates)\b[^.!?]{0,40}?\b(?:always|never)\b/i,
  /\baccording to\b/i,
  /\b(?:CLAUDE\.md|the\s+(?:docs?|readme|adr|rules?|spec|guide|standing order|policy|instructions))\b[^.!?]{0,30}?\b(?:says?|said|states?|tells?)\b/i,
  /\brule\s*\d+\b/i,
];

/** Delegated instruction: the quantified action's subject is a third party, not this agent. */
const DELEGATION = [
  /\b(?:tell|ask|have|make|instruct|remind|get)\s+(?:the\s+|a\s+|an\s+|my\s+|your\s+)?[\w-]+\s+to\s+(?:always|never|not\b)/i,
  /\b(?:add|write|put|append|record|save)\b[^.!?]{0,50}?\b(?:to|in|into)\b[^.!?]{0,25}?(?:CLAUDE\.md|memory|the rules?|a rule|the store|the lessons?)\b/i,
];

/** Spec dialect. "make sure the X never…" is a requirement about an artifact, not about the agent. */
const SPEC_FRAME = /\b(?:make sure|ensure|guarantee)\s+(?:that\s+)?(?:the|a|an|it|this|these|those|my|our|your)\b/i;

/**
 * Third-person subject immediately governing a quantifier. Belt-and-braces behind the clause test:
 * it closes the conjunct leak where "Make sure the parser never accepts unquoted keys AND always
 * preserves order" splits on `and` and hands the second conjunct a clause with an empty prefix.
 * `you` is excluded from the subject set by lookahead — "You never bump the version" must survive.
 */
// FIX (found on the real corpus, 2026-07-23): this regex is deliberately case-SENSITIVE so `[A-Z]
// [\w.'-]*` only catches genuine capitalized proper nouns ("Vercel always…", "npm never…") and not
// every capitalized common word — but that same catch-all also swallows "You" and "I" whenever they
// start a sentence, since a capital letter is a capital letter regardless of which pronoun it opens.
// The old `(?!(?:you)\b)` guard only excluded LOWERCASE "you", so it did nothing for sentence-initial
// "You" — meaning "You never bump the version." (this file's own canonical example, cited below as
// text that "must survive") was silently swallowed as a third-person subject and REJECTED. Confirmed
// live against the shipped detector before this fix: a single-sentence "You always hand-roll instead
// of searching for the tool." — which should fire — returned null, and every positive-table case with
// this shape only passed because a second sentence happened to carry an independent clause-initial
// quantifier that masked the defect. Excluding "You" and "I" explicitly (both cases, since the match
// is case-sensitive) closes it without touching `[A-Z]`'s actual job of catching real proper nouns.
const THIRD_PERSON_QUANT =
  /\b(?!(?:you|You|I)\b)(?:it|they|he|she|we|this|that|these|those|there|[A-Z][\w.'-]*|(?:the|a|an|my|our|its|their|his|her)\s+[\w.'-]+)\s+(?:(?:should|must|shall|will|would|can|could|may|might|does|do|did|is|are|was|were|has|have|had|keeps?|seems?|tends? to)\s+)*(?:always|never)\b/;

/** Hedges and hypotheticals — thinking aloud is not instructing (Sol C7). Applied per sentence. */
const HEDGE =
  /\b(?:maybe|perhaps|possibly|might want|what if|suppose|hypothetically|for example|for instance|e\.?g\.?|imagine|let'?s say|in theory|i wonder|not sure if|thinking out loud|just brainstorming)\b/i;

// ── SIGNAL 3 (+2): A QUANTIFIER BOUND TO THE AGENT ───────────────────────────────────────────────

/** Explicit second-person subject. The quantified occasions are unambiguously the agent's. */
const BOUND_SECOND_PERSON = [
  /\byou\s+(?:always|never|constantly|repeatedly|keep|keep on)\b/i,
  /\byou'?(?:ve|\s+have)\s+(?:always|never|repeatedly|constantly)\b/i,
  /\b(?:every|each|any)\s*time\s+you\b/i,
  /\bwhenever\s+you\b/i,
  /\b(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time\s+(?:you|i'?ve|i have)\b/i,
  // A copula/modal between "you" and the quantifier — "you are never", "you're always", "you were
  // never" — is the SAME binding as the bare form above, just with an auxiliary in between. Found on
  // the real corpus (2026-07-23): "You are never, ever, ever supposed to do things from memory" and
  // "You're never supposed to take things from old memory" both missed the bare-form regex because of
  // the copula, even though the subject is unambiguously "you". Mirrors the modal list THIRD_PERSON_
  // QUANT already uses for third-person subjects — this was an asymmetry, not a deliberate choice.
  /\byou(?:\s+(?:are|were|was|do|does|did|have|had|will|would|should|must|shall|can|could|may|might)|'re|'ve)\s+(?:always|never|constantly|repeatedly|still)\b/i,
  // "I never/always want/expect/need/require you to <verb>" quantifies over the AGENT's occasions
  // exactly as much as "you never <verb>" does — it is just phrased as the speaker's expectation
  // rather than a direct second-person claim. Found on the real corpus: "I never, ever, ever, ever,
  // ever expect you to do shit from memory" and "One thing I always, always, always want you to do
  // is..." both carry a clean quantifier bound to "you to <verb>", and neither matched anything above
  // because the quantifier's grammatical subject is "I", not "you". The bound occasions are still the
  // agent's, so this earns the same signal.
  /\bi\s+(?:always|never)(?:[\s,]+(?:always|never|ever))*\s+(?:want(?:ed)?|expect(?:ed)?|need(?:ed)?|require[ds]?|ask(?:ed)?)\s+you\s+to\b/i,
];

/**
 * `stop <gerund>` is inherently imperative-to-you and is in ADR-033 §1's own Signal 3 list. The
 * gerund requirement is load-bearing: it is what separates "Stop giving me scores out of 10" (a
 * rule) from "Stop and clear it" (the tail of a rant at Vercel, Fable's N4).
 *
 * The PRO-VERB exclusion was added after a corpus run: "Stop doing that." fired, and it is a
 * correction — but `doing`/`being`/`having` carry no transferable content, so the resulting lesson
 * is the literal string "Stop doing that", which would interrupt a future gate with a rule nobody
 * can act on. A statement must carry content beyond the correction frame itself, or it is a
 * deictic pointing at a moment that has already passed.
 */
const STOP_GERUND = /\bstop\s+(?:\w+\s+){0,2}?(?!(?:doing|being|having)\b)\w+ing\b/i;

/**
 * AGENT-DIRECTED IMPERATIVE (added 2026-07-24 for N3 recall — GATED, see the detector).
 *
 * The detector's recall was measured at ~3%: it fired only on utterances carrying an explicit
 * quantifier ("you always/never", "from now on"). Most real corrections are plain directives with no
 * quantifier at all — "I want you to pick it up", "you need to run both suites". This catches the
 * class the quantifier net structurally cannot.
 *
 * It is grammatically AGENT-BOUND by construction — the object of the directive is "you" — which is
 * exactly what keeps it clear of the negative classes that sink a naive broadening. Every false-
 * positive class in the test suite addresses an ARTIFACT, not the agent: "Make sure the parser never
 * accepts…", "The retry policy should always back off", "It always crashes". None of them say "you".
 * So "you need to / you must / I need you to" cannot match them.
 *
 * A directive is NOT a correction on its own, though — "you should add error handling here" is an
 * ordinary first-time request. So this binding is the ONE signal the detector refuses to let stand
 * alone: when it is the only quantifier signal, the detector requires STRONG negative valence
 * (a prohibition, reproach, or rejection — not a bare temporal scope) before it fires. A directive
 * that also REJECTS something is a correction; a directive that merely instructs is not. See the
 * `directive-imperative`-only gate in detectCorrection.
 */
const AGENT_DIRECTED_IMPERATIVE = [
  /\bi\s+(?:really\s+|just\s+)?(?:need|want|expect|require)\s+you\s+to\b/i,
  /\byou\s+(?:need|have|ought)\s+to\b/i,
  /\byou\s+(?:must|should)\b/i,
];

/**
 * Temporal scope markers. These quantify over future occasions, but say nothing about WHOSE — so
 * they only count when the utterance also addresses the agent (second person, or a clause-initial
 * prohibition). "From now on, close the issue yourself" counts; "From now on the parser should
 * validate input" does not.
 */
const TEMPORAL_SCOPE = /\b(?:from now on|going forward|in (?:the )?future|henceforth|next time)\b/i;
const ADDRESSES_AGENT = /\byou(?:r|rself)?\b/i;

/** Clause boundaries. Splitting on coordinators is why THIRD_PERSON_QUANT exists as a backstop. */
const CLAUSE_SPLIT = /\s*(?:[,;:—–]|\.\.\.|\band\b|\bbut\b|\bso\b|\bthen\b|\byet\b)\s*/i;

/** Discourse material that may precede a genuine imperative without giving it a subject. */
const FILLERS =
  '(?:please|just|also|again|ok|okay|well|right|look|hey|actually|honestly|seriously|by the way|btw|remember|note|and|but|from now on|going forward|in the future|in future|next time)';

/** A quantifier in clause-initial imperative position — nothing but fillers between it and the boundary. */
const CLAUSE_INITIAL_QUANT = new RegExp(
  `^(?:${FILLERS}[\\s,]+)*(always|never(?!\\s*mind)|no longer|no more|constantly|repeatedly)\\b`,
  'i',
);

// ── SIGNAL 4: NEGATIVE VALENCE TOWARD THE AGENT'S ACTION ─────────────────────────────────────────
// A bare positive standing order is refused. "Always use tabs" is indistinguishable from a project
// convention being stated for the first time; a CORRECTION rejects something that already happened.

const VALENCE = [
  ['prohibition', /\b(?:never(?!\s*mind)|don'?t|do not|stop|quit|no longer|no more|cut it out|knock it off)\b/i],
  ['reproach', /\b(?:you keep|you always|i (?:told|asked) you|i already (?:told|asked|said)|you (?:were supposed to|should have|failed to|forgot to|didn'?t)|why (?:did|didn'?t|are|aren'?t) you|(?:second|third|fourth|fifth|\d+(?:st|nd|rd|th))\s+time)\b/i],
  ['rejection', /\b(?:wrong|incorrect|that'?s not|not what i (?:asked|wanted|said)|instead of|rather than|isn'?t what)\b/i],
  ['change-of-behaviour', TEMPORAL_SCOPE],
];

// ── TRIGGER INFERENCE ────────────────────────────────────────────────────────────────────────────
// TRIGGERS is a CLOSED enum in lesson-store.mjs, and deliberately so: gates scale with decision
// types, lessons scale with experience. A correction that maps to no trigger is prose, and the store
// throws on prose — so failing to map is a silence, never a default bucket.
//
// A TIE IS ALSO A SILENCE, and that rule was earned rather than assumed. Scoring the ten genuine
// corrections in the test suite produced a strict winner for nine of them and a three-way tie at 1
// for "Every time you finish you skip the tests. From now on run both suites before you tell me it
// works" — which really does fire at three different moments (`finish`, `claim-done`, `choose-work`)
// depending on how it is read. The first implementation broke that tie by list order, which is an
// arbitrary mechanism wearing the costume of a decision. A lesson filed at the wrong trigger
// interrupts at the wrong moment, and a gate that fires at the wrong moment is the one users learn
// to scroll past (ADR-030 §5). So ambiguity resolves the same way every other doubt in this module
// resolves: nothing is emitted. Measured cost: one of ten.

const TRIGGER_VOCAB = [
  ['relay-number', /\b(?:scores?|scored|scoring|benchmarks?|metrics?|percent(?:age)?|out of \d+|ratings?|grades?|stats?|subagent'?s? (?:result|number))\b/gi],
  ['finish', /\b(?:finish(?:ed|ing)?|close the issue|closing the issue|wrap up|when you'?re done|hand (?:it )?back|sign off)\b/gi],
  // `push(?!\s+(?:through|back|forward))` — a corpus run filed "always push through them and do the
  // careful planning" (persevere) as a shipping rule. The idiom is common and it is not `git push`.
  ['ship', /\b(?:push(?:ed|ing|es)?(?!\s+(?:through|back|forward|on))|publish(?:ed|ing)?|releas(?:e|ed|ing)|deploy(?:ed|ing|ment)?|ship(?:ped|ping)?|commit(?:ted|ting|s)?|versions?|bump(?:ed|ing)?|npm publish|merge[ds]?)\b/gi],
  ['write-code', /\b(?:code|functions?|files?|refactor(?:ed|ing)?|implement(?:ed|ing)?|hardcod(?:e|ed|ing)|wr(?:ote|ites?|iting|itten)|edit(?:ed|ing)?|hand[- ]?roll(?:ed|ing)?|modules?|scripts?)\b/gi],
  ['recommend-architecture', /\b(?:architect(?:ure|ural)?|designs?|designed|approach(?:es)?|recommend(?:ed|ation|ing)?|suggest(?:ed|ion|ing)?|tradeoffs?|propos(?:e|ed|al))\b/gi],
  ['mutate-machine', /\b(?:install(?:ed|ing)?|uninstall|delet(?:e|ed|ing)|keychain|globally|launchagent|outside (?:this|the) repo|my machine)\b/gi],
  ['claim-done', /\b(?:done|finished|works?|working|verif(?:y|ied|ying)|tested|completed?|proven?|all set|it'?s live)\b/gi],
  ['assert-fact', /\b(?:assert(?:ed|ing|ion)?|claim(?:ed|ing)?|assum(?:e|ed|ing|ption)|guess(?:ed|ing)?|memory|recall(?:ed)?|live source|source of truth|the api|look(?:ed)? it up)\b/gi],
  ['report-status', /\b(?:status|report(?:ed|ing)?|progress|summar(?:y|ise|ize|ised|ized)|where (?:we|things) (?:are|stand)|update me|tables?|prose|narrative|clickable|links?|urls?|paths?|show me|present(?:ed|ing)?)\b/gi],
  ['choose-work', /\b(?:choose|chose|pick(?:ed)?|priorit(?:y|ise|ize|ised|ized)|work on|backlog|skip(?:ped|ping)?)\b/gi],
];

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Redaction runs before anything is returned. ADR-033 names the transcript corpus as "a new
 * secret-leakage surface"; a candidate is a durable artifact that a human will read and a store will
 * keep, so a key pasted into a correction must not survive into it.
 */
function redact(text) {
  return text
    .replace(/-----BEGIN[^-]{0,40}-----[\s\S]*?-----END[^-]{0,40}-----/g, '[redacted-pem]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-hex]')
    .replace(/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

const sentencesOf = (text) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const anyMatch = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * REPROACH-AS-QUESTION DISCRIMINATOR (found 2026-07-24: the corpus widened from 1 project to 9,
 * 4,083 transcripts, 19 detections, three blind independent raters — holdout precision came back at
 * 77.8%, below ADR-033 §2's ≥90% floor). Both holdout false positives, and every tune-half borderline,
 * were the SAME named shape: "you keep telling me it's working and then it doesn't — why?", "You keep
 * giving partial solutions. Do I need to restart?". These satisfy Signal 3 and Signal 4 on the SAME
 * lexical fact — "you keep" (or an ordinal "that's the third time you've…") is simultaneously a
 * BOUND_SECOND_PERSON hit and VALENCE's own "reproach" bucket — which is the identical double-hat
 * shape the temporal-scope guard above already refuses, just with a different marker. A real recurring
 * complaint like this states THAT something happened again; it states nothing about what should happen
 * instead, and a human reads it as complaint, not instruction.
 *
 * This is deliberately NOT "suppress anything with a question mark". An utterance carrying both the
 * reproach AND a stated rule ("…— from now on, never do that again") must still fire, and does: the
 * moment ANY hit is a genuine forward directive — an explicit "always/never"-class bound quantifier,
 * `stop <gerund>`, a clause-initial imperative, or a temporal-scope marker — isDirectiveHit is true for
 * that hit and the guard below does not apply, regardless of how many question marks are nearby. It
 * fires ONLY when every hit is a WEAK recurrence marker: bare "you keep"/"keep on", the copula "still"
 * form, or an ordinal "Nth time" — none of which assert a universal or an imperative on their own —
 * valence carries nothing but reproach, and the utterance asks a question somewhere. Two genuine true
 * positives already in this file's test suite share the exact same weak-marker shape with NO question
 * present ("You keep committing behaviour changes… Every push bumps it, same commit." / "That's the
 * third time you've hardcoded the version in the script.") and must keep firing — the question-mark
 * condition, not the marker, is what tells the two classes apart.
 */
const WEAK_RECURRENCE_MARKER = /\bkeep(?:\s+on)?\b|\bstill\b/;
const ORDINAL_TIME_MARKER = /\b(?:second|third|fourth|fifth|sixth|\d+(?:st|nd|rd|th))\s+time\b/;
function isDirectiveHit(hit) {
  // stop-gerund / clause-initial-imperative / temporal-scope are stated rules by construction — only
  // the second-person bucket mixes genuine universals ("you always/never") in with bare recurrence.
  if (hit.binding !== 'second-person') return true;
  return !(WEAK_RECURRENCE_MARKER.test(hit.marker) || ORDINAL_TIME_MARKER.test(hit.marker));
}

/**
 * SIGNALS 2+3, as one predicate — see the header. Returns the markers that bind a quantifier to the
 * agent within this sentence, or [] if the sentence quantifies over something else (a program, a
 * spec, a third party) or does not quantify at all.
 */
function agentBoundQuantifiers(sentence) {
  // A third-person subject governing the quantifier settles it: this is a claim about the world.
  if (THIRD_PERSON_QUANT.test(sentence)) return [];

  const hits = [];
  for (const re of BOUND_SECOND_PERSON) {
    const m = re.exec(sentence);
    if (m) hits.push({ marker: m[0].toLowerCase().replace(/\s+/g, ' '), binding: 'second-person' });
  }
  const stop = STOP_GERUND.exec(sentence);
  if (stop) hits.push({ marker: stop[0].toLowerCase(), binding: 'imperative' });

  // Agent-directed imperative — a directive whose object is "you". GATED: on its own it is an
  // ordinary request, so the detector fires on it only alongside strong rejection valence (see the
  // directive-imperative gate). Recorded here as its own binding so that gate can find it.
  for (const re of AGENT_DIRECTED_IMPERATIVE) {
    const m = re.exec(sentence);
    if (m) { hits.push({ marker: m[0].toLowerCase().replace(/\s+/g, ' '), binding: 'directive-imperative' }); break; }
  }

  for (const clause of sentence.split(CLAUSE_SPLIT)) {
    const m = CLAUSE_INITIAL_QUANT.exec(clause.trim());
    if (m) hits.push({ marker: m[1].toLowerCase(), binding: 'clause-initial-imperative' });
  }

  // Temporal scope quantifies over occasions but not over an agent — it counts only when the
  // utterance actually addresses this agent.
  if (TEMPORAL_SCOPE.test(sentence) && (ADDRESSES_AGENT.test(sentence) || hits.length)) {
    hits.push({ marker: TEMPORAL_SCOPE.exec(sentence)[0].toLowerCase(), binding: 'temporal-scope' });
  }
  return hits;
}

function inferTrigger(text) {
  const scored = TRIGGER_VOCAB
    .map(([key, re]) => ({ key, score: (text.match(new RegExp(re.source, 'gi')) || []).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;                                   // no trigger → prose → silence
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;  // ambiguous → silence
  return scored[0];
}

// ── The detector ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} promptText  the user's own words, from the UserPromptSubmit payload's `.prompt`
 *                             (Sol C5: the authenticated utterance, never a transcript reconstruction)
 * @param {object} context
 *   @param {object|null} context.precedingAssistantAction  what the agent did immediately before —
 *          `{ tool?, summary? }`. REQUIRED: Signal 1 (adjacency). Its absence means there is nothing
 *          for the utterance to be correcting, which is how the harness-injected turn — the single
 *          highest-scoring hit in the corpus — is refused structurally rather than by blacklist.
 *   @param {string} [context.transcriptPath]  provenance only, so a ruling can be checked
 *   @param {number} [context.turnIndex]
 *   @param {string} [context.timestamp]
 * @returns {null | {statement, trigger, evidence, confidence, origin, status}}
 */
export function detectCorrection(promptText, context = {}) {
  if (typeof promptText !== 'string') return null;
  const raw = promptText.trim();
  if (!raw || raw.length > MAX_UTTERANCE_CHARS || raw.length < MIN_STATEMENT_CHARS) return null;

  // SIGNAL 1 — adjacency. No preceding agent action, no correction.
  const prior = context.precedingAssistantAction;
  const respondingTo = prior && (prior.summary || prior.tool) ? String(prior.summary || prior.tool).slice(0, 200) : null;
  if (!respondingTo) return null;

  // Hard exclusions — cheapest first, and every one of them is a named FP class.
  if (anyMatch(HARNESS_TEMPLATES, raw)) return null;   // not an utterance
  if (anyMatch(DOCUMENT_MARKERS, raw)) return null;    // pasted content, incl. this repo's own ADRs
  if (anyMatch(USER_THIRD_PERSON, raw)) return null;   // the injection tell
  if (anyMatch(ATTRIBUTION, raw)) return null;         // quoting a rule is not issuing one
  if (anyMatch(DELEGATION, raw)) return null;          // the subject is a third party
  if (SPEC_FRAME.test(raw)) return null;               // requirement about an artifact
  if (raw.startsWith('/')) return null;                // slash command, not speech

  // SIGNALS 2+3 — a quantifier bound to the agent, in a sentence that is neither a question nor a
  // hypothetical. Both filters are applied per sentence: "Always give me a link. Does that work?"
  // must survive its own trailing question.
  const bearing = [];
  const signals = [];
  for (const sentence of sentencesOf(raw)) {
    if (sentence.endsWith('?')) continue;
    if (HEDGE.test(sentence)) continue;
    const hits = agentBoundQuantifiers(sentence);
    if (!hits.length) continue;
    bearing.push(sentence);
    signals.push(...hits.map((h) => ({ ...h, span: sentence.slice(0, 120) })));
  }
  if (!bearing.length) return null;

  // SIGNAL 4 — negative valence. A correction rejects something; a first-time convention does not.
  const valence = VALENCE.filter(([, re]) => re.test(raw)).map(([name]) => name);
  if (!valence.length) return null;

  // NO SINGLE MARKER MAY SATISFY TWO INDEPENDENT SIGNALS. A temporal scope marker ("in the future")
  // is the one token that appears in both tests — as a weak Signal 3 binding and as Signal 4's
  // change-of-behaviour valence — so an utterance carrying nothing else clears a four-signal
  // conjunction on the strength of one lexical fact wearing two hats.
  //
  // Found by running the real corpus, not by reasoning: both surviving false positives in 1,451
  // turns were this exact shape, and both were statements of DESIRE rather than correction —
  // "The point is I want you to be able to do it now and in the future." The genuine ones in the
  // same shape ("From now on, close the issue yourself — don't ask me") always carry an independent
  // prohibition. Requiring that independence drops both FPs and keeps every true positive.
  const bindings = new Set(signals.map((s) => s.binding));
  if (bindings.size === 1 && bindings.has('temporal-scope')
      && valence.length === 1 && valence[0] === 'change-of-behaviour') {
    return null;
  }

  // AGENT-DIRECTED-IMPERATIVE GATE. A directive whose only signal is "you need to / I want you to"
  // is an ordinary forward request unless it also REJECTS something. "You should add a test here" is
  // not a correction; "You should have run the tests — you keep skipping them" is. So when the
  // directive-imperative binding stands alone (no genuine quantifier beside it), require a STRONG
  // valence class — a prohibition, reproach, or rejection — and refuse on a bare change-of-behaviour
  // temporal marker, which any forward-looking request carries. This is the price of the recall the
  // binding buys: it fires on directives that reject, never on directives that merely instruct.
  const STRONG_VALENCE = new Set(['prohibition', 'reproach', 'rejection']);
  if (bindings.size === 1 && bindings.has('directive-imperative')
      && !valence.some((v) => STRONG_VALENCE.has(v))) {
    return null;
  }

  // REPROACH PHRASED AS A QUESTION — see isDirectiveHit's header comment for the full reasoning.
  // Fires only when nothing anywhere in the utterance is a genuine forward directive, valence is
  // reproach and nothing else, and the utterance asks a question somewhere: a recurring complaint
  // with no stated rule, not a standing order.
  const hasDirectiveSignal = signals.some(isDirectiveHit);
  if (!hasDirectiveSignal && valence.length === 1 && valence[0] === 'reproach' && /\?/.test(raw)) {
    return null;
  }

  const statement = redact(bearing.join(' ')).slice(0, MAX_STATEMENT_CHARS).trim();
  if (statement.length < MIN_STATEMENT_CHARS) return null;

  // The closed enum has the last word: no trigger, no lesson.
  //
  // Inferred from the CORRECTION SENTENCES, not from the whole turn. The first version scored the
  // whole utterance and the corpus caught it out: a turn whose rule was "never give me an issue
  // without a solution in the same line" (a status-reporting rule) filed as `ship`, because the
  // user had mentioned "version numbers" two sentences earlier about something else entirely.
  // Incidental vocabulary elsewhere in a turn should not decide when a rule interrupts — that is
  // the same misfiling that makes the tie-break rule above refuse rather than guess.
  const trigger = inferTrigger(statement);
  if (!trigger) return null;

  // Ordering only. Never a gate, never an auto-ratification threshold, and never 1.0.
  const corroboration = new Set(signals.map((s) => s.binding)).size + valence.length;
  const confidence = Math.min(0.9, 0.5 + 0.1 * (corroboration - 1));

  return {
    statement,
    trigger: trigger.key,

    // Sol C2: `makeLesson()` drops unknown top-level keys but passes `evidence[]` through whole, so
    // the entire ratification surface rides inside it. `observed` is what lesson-gate.mjs prints.
    evidence: [{
      observed: `you said: "${redact(raw).slice(0, MAX_QUOTE_CHARS)}"`,
      quote: redact(raw).slice(0, MAX_QUOTE_CHARS),
      respondingTo,
      signals,
      valence,
      detector: 'correction-detect',
      source: {
        transcriptPath: context.transcriptPath ?? null,
        turnIndex: context.turnIndex ?? null,
        timestamp: context.timestamp ?? null,
      },
    }],

    confidence,

    // ADR-033 §4, unconditional and with no override parameter — a caller cannot ask for anything
    // else, because the only honest answer to "who put this row in the store" is: a machine.
    origin: 'model-inferred',
    status: 'candidate',
  };
}
