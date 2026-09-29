// scripts/fixture-denominator.mjs — ADR-0091 D6.4 (and the one retirement function D7.7 requires).
//
// The retrieval fixture is FROZEN (182 human questions, one per repository, digest-bound). Live
// coverage is not: 194+ eligible repositories and growing. The release canary used to demand that
// the two sets be EQUAL, which a living corpus can never satisfy. The reconciled decision:
//
//   available  = eligible repository rows that ship a store (CURRENT, or STALE with a verified carry)
//   retired    = fixture repositories with NO row at all in a complete coverage observation (D7.2)
//   questioned = fixture ∩ available            -- every one is asked its frozen question
//   blocking   = fixture − available − retired  -- the release refuses (e.g. MISSING, INELIGIBLE)
//   unfixturedEligible = available − fixture    -- RECORDED, never blocking; the fixture stays frozen
//
// Retirement only ever REMOVES a question from the denominator; it never adds a passing answer. The
// signal is "absent from a sealed, complete enumeration" -- it cannot tell deleted from privatized
// from renamed, which is acceptable for exactly that reason (ADR-0091 D7.2).

import { eligibleRepositoryStanding } from '../plugin/scripts/coverage-integrity.mjs';

const lower = (value) => String(value || '').toLowerCase();
// localeCompare, exactly as scripts/retrieval-canary.mjs orders and set-checks these lists. Default
// code-unit sort disagrees on real store names ('chatgpt-…' vs 'chatgpt_…'), which the canary's
// checkedSet rejects as 'eligible denominator set is invalid'.
const ordered = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/** True only for a repository enumeration the coverage itself proves complete and terminal. */
export function repositoryEnumerationComplete(coverage) {
  const repositories = (coverage?.rows || []).filter((row) => row?.kind === 'repository');
  const enumeration = coverage?.enumerationReceipt;
  return enumeration?.terminal === true && enumeration?.duplicateKeys === 0
    && enumeration?.repositories?.expected === repositories.length;
}

/** D7.2: fixture stores with no repository row at all, under a complete enumeration; else none. */
export function retiredFixtureStores({ coverage, fixtureStores }) {
  if (!repositoryEnumerationComplete(coverage)) return [];
  const present = new Set();
  for (const row of (coverage.rows || []).filter((entry) => entry?.kind === 'repository')) {
    present.add(lower(row.name));
    if (row.artifact?.store) present.add(lower(row.artifact.store));
  }
  return ordered(fixtureStores.map(lower).filter((store) => !present.has(store)));
}

export function fixtureDenominator({ coverage, fixtureStores }) {
  const fixture = ordered((fixtureStores || []).map(lower));
  if (!fixture.length || fixture.some((store) => !store)) throw new Error('fixture store set is empty or malformed');
  const eligible = (coverage?.rows || []).filter((row) => row?.kind === 'repository' && row.disposition === 'eligible');
  const available = new Map();
  for (const row of eligible) {
    if (eligibleRepositoryStanding(row) !== 'shipped') continue;
    const store = lower(row.artifact?.store);
    if (!store) throw new Error(`eligible repository row ${row.key} names no store`);
    if (available.has(store)) throw new Error(`eligible repository store ${store} is duplicated`);
    available.set(store, row);
  }
  const retired = new Set(retiredFixtureStores({ coverage, fixtureStores: fixture }));
  const questioned = fixture.filter((store) => available.has(store));
  const blocking = fixture.filter((store) => !available.has(store) && !retired.has(store)).map((store) => {
    const row = (coverage?.rows || []).find((entry) => entry?.kind === 'repository'
      && (lower(entry.artifact?.store) === store || lower(entry.name) === store));
    return { store, status: row?.status ?? null, disposition: row?.disposition ?? null };
  });
  const fixtureSet = new Set(fixture);
  return {
    fixture,
    questioned,
    questionedRows: questioned.map((store) => available.get(store)),
    retired: [...retired],
    blocking,
    unfixturedEligible: ordered([...available.keys()].filter((store) => !fixtureSet.has(store))),
  };
}
