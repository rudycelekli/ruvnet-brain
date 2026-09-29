#!/usr/bin/env node
// scripts/knowledge-input-digest.mjs — "has anything the corpus is built FROM changed since the seed?"
//
// WHY (2026-09-29 nightly redesign). The old no-change test compared the NEW archive's digest with
// the seed archive's digest. It could never match: a rebuilt archive carries fresh builtUtc stamps,
// a fresh selection receipt and fresh aggregate receipts even when not one input moved, so every
// quiet night paid the full ~3 hours and minted a new generation anyway. The decision now happens
// BEFORE anything is built, over the inputs themselves, computed the same way for the seed (from the
// sealed evidence it carries) and for tonight (from the sealed observation and this checkout):
//
//   sourceObservationSha256  the sealed observation digest. Included on purpose (the conservative
//                            clause of the design): the aggregate builders consume more of the
//                            observation than head SHAs -- concepts.sources.json binds
//                            observationSha256 and the ruv-gists ledger row uses it as sourceCommit,
//                            and coverage rows ship each repository's description/homepage for routing.
//   repositories             every eligible repository store -> the commit tonight wants (upstream.sha)
//                            versus the commit the seed actually contains (artifact.sourceCommit),
//                            so a store the seed carried at old bytes can never read as unchanged.
//   gists                    every gist -> wanted version versus ingested version, same rule.
//   publicInputs             the byte identities of the fenced public prose (primers, topics, L2,
//                            capability cards, aliases) and the topic-ownership map.
//   embedding                the model:dimensions the runtime embeds with / the seed was embedded with.
//
// Every uncertainty resolves toward BUILDING: a seed without the evidence (the pre-contract bootstrap)
// yields null, and null is never "unchanged".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, digest as sha256Of } from './coverage-integrity.mjs';
import { materializePublicInputs, SELECTION_FILE } from './public-inputs.mjs';
import { parseBuildFingerprint } from './corpus-next-seed.mjs';

export const KNOWLEDGE_INPUT_KIND = 'ruvnet-brain-knowledge-input';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function fail(message) {
  throw new Error(`[knowledge-input-digest] ${message}`);
}

const lower = (value) => (value === null || value === undefined ? null : String(value).toLowerCase());

/** Canonical form: every list sorted, every commit lowercased, nothing else admitted. */
export function normalize(components) {
  const c = components || {};
  if (!HEX64.test(String(c.sourceObservationSha256 || ''))) fail('sourceObservationSha256 must be 64 lowercase hex');
  if (![c.repositories, c.gists, c.publicInputs?.files, c.embedding].every(Array.isArray)) {
    fail('repositories, gists, publicInputs.files and embedding must be arrays');
  }
  const repositories = c.repositories.map((row) => ({ store: lower(row?.store), sha: lower(row?.sha) }))
    .sort((a, b) => String(a.store).localeCompare(String(b.store)));
  if (repositories.some((row) => !row.store)) fail('a repository component has no store');
  if (new Set(repositories.map((row) => row.store)).size !== repositories.length) fail('duplicate repository store');
  const gists = c.gists.map((row) => ({ id: String(row?.id || ''), sha: lower(row?.sha) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (gists.some((row) => !row.id)) fail('a gist component has no id');
  const files = c.publicInputs.files.map((row) => ({ path: String(row?.path || ''), sha256: lower(row?.sha256), bytes: row?.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.some((row) => !row.path || !HEX64.test(String(row.sha256)) || !Number.isSafeInteger(row.bytes))) {
    fail('a public input file row is malformed');
  }
  const ownership = Object.fromEntries(Object.entries(c.publicInputs.ownership || {})
    .map(([slug, repo]) => [String(slug), String(repo)]).sort(([a], [b]) => a.localeCompare(b)));
  const embedding = [...new Set(c.embedding.map(String))].sort();
  if (!embedding.length) fail('no embedding model recorded');
  return {
    schemaVersion: 1, kind: KNOWLEDGE_INPUT_KIND, sourceObservationSha256: c.sourceObservationSha256,
    repositories, gists, publicInputs: { files, ownership }, embedding,
  };
}

/** One sha256 over the canonical components. Ordering of the inputs never matters. */
export function digest(components) {
  return sha256Of(canonicalJson(normalize(components)));
}

const eligibleRepositories = (coverage) => (coverage?.rows || [])
  .filter((row) => row?.kind === 'repository' && row?.disposition === 'eligible');
const gistRows = (coverage) => (coverage?.rows || []).filter((row) => row?.kind === 'gist');
const gistId = (row) => String(row?.key || '').replace(/^gist:/, '');

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The seed's knowledge inputs, read ONLY from evidence the sealed seed carries (its extracted assets):
 * CORPUS-COVERAGE.json, PUBLIC-INPUT-SELECTION.json and RVF-GENERATIONS.json. null when any is absent
 * or unreadable -- the caller must then build.
 */
export function fromSeed(assetsDir) {
  const assets = path.resolve(assetsDir || '');
  const coverage = readJsonIfPresent(path.join(assets, 'CORPUS-COVERAGE.json'));
  const selection = readJsonIfPresent(path.join(assets, SELECTION_FILE));
  const ledger = readJsonIfPresent(path.join(assets, 'RVF-GENERATIONS.json'));
  if (coverage?.kind !== 'ruvnet-brain-corpus-coverage' || !Array.isArray(coverage.rows)
    || !HEX64.test(String(coverage.sourceObservationSha256 || ''))) return null;
  if (!Array.isArray(selection?.files) || !ledger?.stores || typeof ledger.stores !== 'object') return null;
  const embedding = Object.values(ledger.stores)
    .filter((store) => store?.model && Number.isSafeInteger(store?.dimensions))
    .map((store) => `${store.model}:${store.dimensions}`);
  if (!embedding.length) return null;
  return {
    sourceObservationSha256: coverage.sourceObservationSha256,
    // What the seed CONTAINS: a carried (STALE) or MISSING store reads as its old/absent commit.
    repositories: eligibleRepositories(coverage).map((row) => ({ store: row.artifact?.store, sha: row.artifact?.sourceCommit ?? null })),
    gists: gistRows(coverage).map((row) => ({ id: gistId(row), sha: row.artifact?.sourceCommit ?? null })),
    publicInputs: { files: selection.files, ownership: selection.ownership || {} },
    embedding,
  };
}

/** The runtime's embedding profile, read from THAT runtime's own forge fingerprint. */
export async function runtimeEmbedding(root = DEFAULT_ROOT) {
  const forge = await import(pathToFileURL(path.join(path.resolve(root), 'kb', 'forge-corpus.mjs')).href);
  const { model, dimensions } = parseBuildFingerprint(forge.FORGE_BUILD_FINGERPRINT);
  return [`${model}:${dimensions}`];
}

/**
 * Tonight's knowledge inputs: the coverage measured from the sealed observation (what every source
 * WANTS to be), plus the public prose this checkout would select, materialized into a throwaway
 * directory by the one canonical selector -- never re-implemented here.
 */
export async function fromCoverage(coverage, root = DEFAULT_ROOT, {
  materialize = materializePublicInputs, embedding = null } = {}) {
  if (coverage?.kind !== 'ruvnet-brain-corpus-coverage' || !Array.isArray(coverage.rows)) {
    fail('tonight requires a measured ruvnet-brain-corpus-coverage object');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-input-'));
  let publicInputs;
  try {
    const selected = materialize({ builderRoot: path.resolve(root), outDir: path.join(scratch, 'public') });
    publicInputs = { files: selected.selectionReceipt.files, ownership: selected.selectionReceipt.ownership || {} };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return {
    sourceObservationSha256: coverage.sourceObservationSha256,
    repositories: eligibleRepositories(coverage).map((row) => {
      if (!COMMIT.test(lower(row.upstream?.sha) || '')) fail(`${row.artifact?.store || row.key} has no upstream sha`);
      return { store: row.artifact?.store, sha: row.upstream.sha };
    }),
    gists: gistRows(coverage).map((row) => ({ id: gistId(row), sha: row.upstream?.sha ?? null })),
    publicInputs,
    embedding: embedding || await runtimeEmbedding(root),
  };
}

/** { unchanged, seedSha256, tonightSha256 }. A seed without evidence is never unchanged. */
export function compareKnowledgeInputs({ seed, tonight }) {
  const tonightSha256 = digest(tonight);
  if (!seed) return { unchanged: false, seedSha256: null, tonightSha256, reason: 'the seed carries no knowledge-input evidence' };
  const seedSha256 = digest(seed);
  return {
    unchanged: seedSha256 === tonightSha256, seedSha256, tonightSha256,
    reason: seedSha256 === tonightSha256 ? 'every knowledge input equals the seed' : 'at least one knowledge input differs from the seed',
  };
}
