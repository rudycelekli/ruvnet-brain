// scripts/corpus-currency.mjs — ADR-0091 D7.1: the honest content-currency block of manifest.json.
//
// There is no single honest "content as of" date for a corpus that mixes current and carried stores:
// `builtUtc` is restamped to "now" every round (corpus-aggregates.mjs, refresh-capability-only-store.mjs)
// and `manifest.generated` is the ASSEMBLY time. So the manifest reports what is actually known:
//
//   observedAt     when upstream heads were read (the sealed observation). Every CURRENT store equals
//                  upstream as of that instant. null when nothing was observed (legacy/bootstrap path).
//   generationTag  the corpus generation this archive was assembled FROM, when the build knows it (a
//                  code release built from a published generation). null for a nightly candidate, whose
//                  own tag is corpus-sha256-<this archive's sha256> and so cannot be written inside it.
//   counts         eligible repository rows by status, plus fixture repositories RETIRED (no row at all
//                  in a complete observation, scripts/fixture-denominator.mjs -- the one shared rule).
//                  null when nothing was observed.
//   oldestCarried  the carried (STALE + carry) store whose content is oldest. Its committedAt comes only
//                  from carry.carriedCommittedAt; when any carried store's date is unknown the oldest
//                  cannot be known, so an undated one is reported with committedAt null. Never estimated.
//
// Stated plainly, a surface reads it as "N of M repositories match upstream as of <observedAt>".

import { retiredFixtureStores } from './fixture-denominator.mjs';

export const CURRENCY_BASIS = Object.freeze({
  SEALED: 'sealed-observation',
  LEGACY: 'legacy-seed-projection-unobserved',
  NONE: 'no-observation',
});

const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

function oldestCarriedOf(rows) {
  const carried = rows.filter((row) => row.status === 'STALE' && row.carry && typeof row.carry === 'object');
  if (!carried.length) return null;
  const byStore = (a, b) => String(a.artifact?.store).localeCompare(String(b.artifact?.store));
  const undated = carried.filter((row) => isoOrNull(row.carry.carriedCommittedAt) === null).sort(byStore);
  const pick = undated[0]
    || [...carried].sort((a, b) => Date.parse(a.carry.carriedCommittedAt) - Date.parse(b.carry.carriedCommittedAt) || byStore(a, b))[0];
  return {
    store: pick.artifact?.store ?? null,
    sourceCommit: pick.carry.carriedSourceCommit ?? null,
    committedAt: isoOrNull(pick.carry.carriedCommittedAt),
  };
}

/**
 * `coverage`: the sealed ruvnet-brain-corpus-coverage this archive was bound to (already validated by
 * the caller), or null. `basis` says why it is null. `fixtureStores`: the frozen fixture's stores, or
 * null when the runtime has no fixture (then `retired` is null, not 0 -- unknown is not none).
 */
export function corpusCurrencyBlock({ coverage = null, basis, generationTag = null, fixtureStores = null }) {
  if (!Object.values(CURRENCY_BASIS).includes(basis)) throw new Error(`unknown corpus currency basis ${basis}`);
  if (basis !== CURRENCY_BASIS.SEALED || !coverage) {
    return { basis, observedAt: null, generationTag: generationTag ?? null, counts: null, oldestCarried: null };
  }
  const eligible = (coverage.rows || []).filter((row) => row?.kind === 'repository' && row.disposition === 'eligible');
  const count = (status) => eligible.filter((row) => row.status === status).length;
  return {
    basis,
    observedAt: isoOrNull(coverage.observedAt),
    generationTag: generationTag ?? null,
    counts: {
      eligible: eligible.length,
      current: count('CURRENT'),
      stale: count('STALE'),
      missing: count('MISSING'),
      unverified: count('UNVERIFIED'),
      retired: fixtureStores ? retiredFixtureStores({ coverage, fixtureStores }).length : null,
    },
    oldestCarried: oldestCarriedOf(eligible),
  };
}
