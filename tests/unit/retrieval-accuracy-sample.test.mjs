// ADR-0091 D2 — the C3 diagnostic runs on a deterministic question sample in the corpus pipeline.
//
// What must hold, each proven below against the real runRetrievalAccuracy and the real reader:
//   1. the sample size is respected (n questions, both modes, and no more queries than that);
//   2. the report keeps the exact schema the downstream reader expects, and that reader accepts it;
//   3. the same seed selects the same questions, every time;
//   4. the full, unsampled audit still runs when no sample is requested;
//   5. corpus-seed.yml passes the same sample size the code declares.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  C3_DIAGNOSTIC_SAMPLE_QUESTIONS, DEFAULT_SAMPLE_SEED, readDiagnosticAccuracyReport, runRetrievalAccuracy,
  selectQuestionSample, sha256Of, validateAccuracyReport,
} from '../../scripts/oracle/retrieval-accuracy.mjs';
import { sealedCorpusBundle, SOURCE_COMMIT } from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-sample-'));
  dirs.push(dir);
  return dir;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// A legacy (schema-1) oracle shaped like the committed one: many partitions, uneven label counts.
// Every partition's store is `alpha`, the one store the fixture archive ships, so the FULL run is
// complete and the difference between full and sampled is the sample alone.
const PARTITIONS = 12;
function oracleRows() {
  const partitions = [];
  const labels = [];
  for (let p = 0; p < PARTITIONS; p += 1) {
    const partition = `p${String(p).padStart(2, '0')}`;
    partitions.push({ partition, kind: 'repository', store: 'alpha', sourceCommit: SOURCE_COMMIT });
    for (let q = 0; q < 1 + (p % 4); q += 1) {
      labels.push({
        id: `${partition}-${q}`, partition, question: `What does ${partition} question ${q} ask?`,
        span: `span ${partition} ${q}`, sourcePath: 'docs/zero.md',
        blobSha: sha256Of(`blob-${partition}-${q}`).slice(0, 40), unitSha256: sha256Of(`unit-${partition}-${q}`),
      });
    }
  }
  return { partitions, labels };
}

function writeOracle(dir) {
  const { partitions, labels } = oracleRows();
  const file = path.join(dir, 'oracle.json');
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1, kind: 'ruvnet-brain-retrieval-accuracy-oracle', oracleVersion: 'fixture/sample',
    partitions, labels, emptySources: [],
    seal: { labelsSha256: sha256Of(canonical(labels)), partitionsSha256: sha256Of(canonical(partitions)) },
  }, null, 2)}\n`);
  return { file, labels };
}

// Answers every question correctly and counts the queries it was asked.
function countingSearch(labels) {
  const byQuestion = new Map(labels.map((row) => [row.question, row]));
  const asked = [];
  const search = async ({ query, mode }) => {
    const label = byQuestion.get(query);
    asked.push({ id: label.id, mode });
    return { timedOut: false, results: [{ store: 'alpha', path: label.sourcePath, text: `... ${label.span} ...` }] };
  };
  return { search, asked };
}

async function bench(options = {}) {
  const dir = temp();
  const { bundle } = await sealedCorpusBundle(dir, { accuracy: null });
  const { file: oracleFile, labels } = writeOracle(dir);
  const { search, asked } = countingSearch(labels);
  const outFile = path.join(dir, 'ruvnet-brain.zip.accuracy.json');
  const { report } = await runRetrievalAccuracy({
    bundleFile: bundle, oracleFile, outFile, search, now: () => '2026-09-28T00:00:00.000Z', ...options,
  });
  return { dir, bundle, oracleFile, outFile, report, labels, asked };
}

describe('selectQuestionSample', () => {
  const { labels } = oracleRows();

  it('returns exactly the requested number of questions, spread one per partition first', () => {
    const sample = selectQuestionSample({ labels, size: 7 });
    expect(sample).toHaveLength(7);
    expect(new Set(sample.map((row) => row.partition)).size).toBe(7);
    const wider = selectQuestionSample({ labels, size: PARTITIONS + 3 });
    expect(wider).toHaveLength(PARTITIONS + 3);
    expect(new Set(wider.map((row) => row.partition)).size).toBe(PARTITIONS); // every partition reached
  });

  it('same seed, same questions; a different seed selects differently', () => {
    const ids = (seed) => selectQuestionSample({ labels, size: 7, seed }).map((row) => row.id);
    expect(ids(DEFAULT_SAMPLE_SEED)).toEqual(ids(DEFAULT_SAMPLE_SEED));
    expect(ids('another-seed')).toEqual(ids('another-seed'));
    expect(ids('another-seed')).not.toEqual(ids(DEFAULT_SAMPLE_SEED));
    // Input order does not matter: the rank is a hash of the seed and the id, not array position.
    expect(selectQuestionSample({ labels: [...labels].reverse(), size: 7 }).map((row) => row.id)).toEqual(ids(DEFAULT_SAMPLE_SEED));
  });

  it('a sample larger than the oracle is the whole oracle, never a duplicate', () => {
    const all = selectQuestionSample({ labels, size: labels.length + 50 });
    expect(all.map((row) => row.id).sort()).toEqual(labels.map((row) => row.id).sort());
  });

  it('refuses a non-positive size or an empty seed', () => {
    expect(() => selectQuestionSample({ labels, size: 0 })).toThrow(/positive integer/);
    expect(() => selectQuestionSample({ labels, size: 3, seed: '' })).toThrow(/non-empty/);
  });
});

describe('runRetrievalAccuracy with --sample-questions', () => {
  it('asks exactly size x 2 queries (both modes) and says so in the report', async () => {
    const { report, asked, labels } = await bench({ sampleQuestions: 5 });
    expect(asked).toHaveLength(10);
    expect(new Set(asked.map((row) => row.mode))).toEqual(new Set(['explicit-repository', 'full-corpus']));
    expect(report.totals.n).toBe(10);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.bounded.sample).toMatchObject({
      seed: DEFAULT_SAMPLE_SEED, requested: 5, questions: 5, oracleQuestions: labels.length,
    });
    expect(report.coverage.bounded.sample.labelIds)
      .toEqual(selectQuestionSample({ labels, size: 5 }).map((row) => row.id));
    expect(new Set(asked.map((row) => row.id))).toEqual(new Set(report.coverage.bounded.sample.labelIds));
    expect(report.coverage.bounded.reasons.join(' ')).toMatch(/--sample-questions 5/);
    expect(report.state).toBe('FAIL'); // bounded is never a corpus-wide pass, even at 100%
  });

  it('keeps the full report schema, and the downstream diagnostic reader accepts it', async () => {
    const full = await bench();
    const { report, outFile, bundle, oracleFile } = await bench({ sampleQuestions: 5 });
    expect(Object.keys(report).sort()).toEqual(Object.keys(full.report).sort());
    expect(Object.keys(report.partitions[0]).sort()).toEqual(Object.keys(full.report.partitions[0]).sort());
    expect(Object.keys(report.totals).sort()).toEqual(Object.keys(full.report.totals).sort());
    const archive = { file: path.basename(bundle), sha256: report.archive.sha256, bytes: fs.statSync(bundle).size };
    const read = readDiagnosticAccuracyReport({
      reportFile: outFile, archive,
      expectedOracleSha256: sha256Of(fs.readFileSync(oracleFile)),
      expectedGeneratorSha256: sha256Of(fs.readFileSync(path.join(ROOT, 'scripts/oracle/retrieval-accuracy.mjs'))),
    });
    expect(read.totals.n).toBe(10);
    // The retained STRICT reader (the C3 re-arm path) still refuses a sample as a corpus-wide pass.
    expect(() => validateAccuracyReport({ report, archive })).toThrow();
  });

  it('is deterministic: two runs with the same seed measure the same questions and write the same report', async () => {
    const one = await bench({ sampleQuestions: 6 });
    const two = await bench({ sampleQuestions: 6 });
    expect(two.report.coverage.bounded.sample.labelIds).toEqual(one.report.coverage.bounded.sample.labelIds);
    expect(two.asked).toEqual(one.asked);
    expect(two.report.partitions).toEqual(one.report.partitions);
  });

  it('with no sample the full audit still runs: every question, both modes, complete coverage', async () => {
    const { report, asked, labels } = await bench();
    expect(asked).toHaveLength(labels.length * 2);
    expect(report.totals.n).toBe(labels.length * 2);
    expect(report.coverage.complete).toBe(true);
    expect(report.coverage.bounded).toBeNull();
    expect(report.state).toBe('PASS');
  });

  it('refuses to combine a whole-oracle sample with a per-partition or store bound', async () => {
    await expect(bench({ sampleQuestions: 5, sampleLimit: 1 })).rejects.toThrow(/cannot be combined/);
    await expect(bench({ sampleQuestions: 5, storeLimit: 1 })).rejects.toThrow(/cannot be combined/);
  });
});

describe('corpus-seed.yml runs the declared sample', () => {
  it('passes --accuracy-sample equal to C3_DIAGNOSTIC_SAMPLE_QUESTIONS in the reconcile step', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/corpus-seed.yml'), 'utf8');
    const flags = [...workflow.matchAll(/^\s+--accuracy-sample (\d+) \\$/gm)].map((match) => Number(match[1]));
    expect(flags).toEqual([C3_DIAGNOSTIC_SAMPLE_QUESTIONS]);
  });
});
