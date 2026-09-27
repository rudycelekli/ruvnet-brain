// tests/unit/forge-update-currency-verdict.test.mjs — kb/forge-update.mjs's currencyVerdict()
// (S2, gate 3/4 spec), replacing the deleted isBehind() (formerly tests/unit/forge-update-isbehind
// .test.mjs, whose tiers 1-3 pinned the exact builtUtc/sourceCommit fallback this function deletes
// outright rather than preserves).
//
// isBehind()'s tiers 2-3 compared the CANDIDATE's pre-fetch manifest timestamp (a GitHub Release's
// publish time, always later than the KB inside it was forged) against the installed copy's own forge
// time — the measured redownload loop recorded in this file's header and in
// kb/corpus-release-identity.mjs's header. currencyVerdict() never falls back to a locally-observed
// timestamp: absent a genuine ordering key it reports UNKNOWN, never CURRENT, never BLOCKED.
//
// Truth table covered below: code-vs-code, code-supersedes-corpus, corpus-same, corpus-unknown
// (no installed generation stamp), corpus-fallback (candidate has no generation identity),
// corpus-newer, corpus-older-REFUSED, corpus-equal-generation-different-bytes, unparseable stamps,
// and the 'other' (non-release-shaped manifest) case that used to fall through to timestamps.
import { describe, it, expect } from 'vitest';

// Importing is safe: forge-update.mjs runs main() only when import.meta.url matches argv[1].
const { currencyVerdict, installedCurrencyIdentity, candidateCurrencyIdentity } =
  await import('../../kb/forge-update.mjs');

const CORPUS_A = `corpus-sha256-${'a'.repeat(64)}`;
const CORPUS_B = `corpus-sha256-${'b'.repeat(64)}`;

describe('currencyVerdict — code release transitions', () => {
  it('CURRENT: same code tag already installed', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null },
      { kind: 'code', tag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null },
    );
    expect(result.verdict).toBe('CURRENT');
  });

  it('UPDATE_AVAILABLE: a different code tag', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.0.7', corpusReleaseTag: null, corpusGeneration: null },
      { kind: 'code', tag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null },
    );
    expect(result.verdict).toBe('UPDATE_AVAILABLE');
  });

  it('CODE SUPERSEDES CORPUS: a code release always supersedes an installed corpus generation, whatever it is', () => {
    // The installed tree took corpus A on top of runtime v4.0.7. A NEW code release always wins,
    // regardless of corpusReleaseTag/corpusGeneration — its bundle IS the corpus (the same rationale
    // recordCorpusTransportIdentity documents for clearing a stale corpusReleaseTag).
    const result = currencyVerdict(
      { releaseTag: 'v4.0.7', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' },
      { kind: 'code', tag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null },
    );
    expect(result.verdict).toBe('UPDATE_AVAILABLE');
  });
});

describe('currencyVerdict — corpus release transitions', () => {
  it('CURRENT: same corpus tag already installed, whatever the generation fields say', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' },
      { kind: 'corpus', tag: CORPUS_A, corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-05T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-05T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('CURRENT');
  });

  it('UNKNOWN: installed carries no verifiable corpus generation stamp (today\'s pre-S2 installs) — never REFUSED, never CURRENT', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: null },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: '2026-09-05T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-05T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('UNKNOWN: installed generation stamp is present but unparseable', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: 'not-a-date' },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: '2026-09-05T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-05T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('UNKNOWN');
  });

  it('UPDATE_AVAILABLE (fallback to transport tag): candidate carries no generation identity of its own', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: null, corpusGenerationEpoch: null },
    );
    expect(result.verdict).toBe('UPDATE_AVAILABLE');
    expect(result.reason).toMatch(/no generation identity/);
  });

  it('UPDATE_AVAILABLE: candidate generation strictly newer than installed', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: '2026-09-05T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-05T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('UPDATE_AVAILABLE');
  });

  it('REFUSED (rollback protection): candidate generation strictly OLDER than installed', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-05T00:00:00.000Z' },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: '2026-09-01T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-01T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('REFUSED');
    expect(result.reason).toMatch(/predates installed generation/);
  });

  it('UPDATE_AVAILABLE: EQUAL generation epoch is not older — a genuinely different tag still moves forward', () => {
    const stamp = '2026-09-01T00:00:00.000Z';
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: CORPUS_A, corpusGeneration: stamp },
      { kind: 'corpus', tag: CORPUS_B, corpusReleaseTag: CORPUS_B, corpusGeneration: stamp, corpusGenerationEpoch: Date.parse(stamp) },
    );
    expect(result.verdict).toBe('UPDATE_AVAILABLE');
  });

  it('this brain has never taken a corpus release: UNKNOWN, not REFUSED and not CURRENT', () => {
    const result = currencyVerdict(
      { releaseTag: 'v4.9.0', corpusReleaseTag: null, corpusGeneration: null },
      { kind: 'corpus', tag: CORPUS_A, corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z', corpusGenerationEpoch: Date.parse('2026-09-01T00:00:00.000Z') },
    );
    expect(result.verdict).toBe('UNKNOWN');
  });
});

describe('currencyVerdict — no recognizable release identity (the deleted timestamp-fallback case)', () => {
  it('UNKNOWN, never falling back to comparing local builtUtc/sourceCommit timestamps', () => {
    // Before S2 this shape fell through isBehind()'s tier 2/3 and could read "behind" purely off a
    // manifest publish-time skew. currencyVerdict() must never do that: no tag, no verdict but UNKNOWN.
    const result = currencyVerdict(
      { releaseTag: 'v4.0.7', corpusReleaseTag: null, corpusGeneration: null },
      { kind: 'other', tag: null, corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null },
    );
    expect(result.verdict).toBe('UNKNOWN');
  });
});

describe('installedCurrencyIdentity(source)', () => {
  it('reads the three top-level fields and defaults absent ones to null', () => {
    expect(installedCurrencyIdentity({ releaseTag: 'v4.0.8' }))
      .toEqual({ releaseTag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null });
    expect(installedCurrencyIdentity({}))
      .toEqual({ releaseTag: null, corpusReleaseTag: null, corpusGeneration: null });
    expect(installedCurrencyIdentity({ releaseTag: 'v4.0.8', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' }))
      .toEqual({ releaseTag: 'v4.0.8', corpusReleaseTag: CORPUS_A, corpusGeneration: '2026-09-01T00:00:00.000Z' });
  });
});

describe('candidateCurrencyIdentity(canon)', () => {
  it('a non-GitHub-release manifest (shapes 1/2) carries no release identity at all', () => {
    expect(candidateCurrencyIdentity({ generated: '2026-09-01T00:00:00.000Z', stores: {} }))
      .toEqual({ kind: 'other', tag: null, corpusReleaseTag: null, corpusGeneration: null, corpusGenerationEpoch: null });
  });

  it('a code release payload never parses a generation, even if the body happens to contain one', () => {
    const result = candidateCurrencyIdentity({ tag_name: 'v4.0.8', body: 'Corpus generation: 2026-09-01T00:00:00.000Z' });
    expect(result).toMatchObject({ kind: 'code', tag: 'v4.0.8', corpusReleaseTag: null, corpusGeneration: null });
  });

  it('a corpus release payload parses the "Corpus generation:" line from its body', () => {
    const result = candidateCurrencyIdentity({ tag_name: CORPUS_A, body: [
      'RuvNet Brain corpus generation — signed, content-addressed, and promoted to latest.',
      'Corpus generation: 2026-09-05T12:00:00.000Z',
      'Archive SHA-256: deadbeef',
    ].join('\n') });
    expect(result.kind).toBe('corpus');
    expect(result.corpusReleaseTag).toBe(CORPUS_A);
    expect(result.corpusGeneration).toBe('2026-09-05T12:00:00.000Z');
    expect(result.corpusGenerationEpoch).toBe(Date.parse('2026-09-05T12:00:00.000Z'));
  });

  it('a corpus release payload with no body (or no matching line) carries no generation identity', () => {
    expect(candidateCurrencyIdentity({ tag_name: CORPUS_A }).corpusGeneration).toBe(null);
    expect(candidateCurrencyIdentity({ tag_name: CORPUS_A, body: 'no generation line here' }).corpusGeneration).toBe(null);
  });

  it('a tag matching neither the code nor the corpus pattern is "other"', () => {
    expect(candidateCurrencyIdentity({ tag_name: 'latest' }).kind).toBe('other');
  });
});
