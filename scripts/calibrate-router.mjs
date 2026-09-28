#!/usr/bin/env node
// calibrate-router.mjs — measure the cheap→frontier tiers on REAL runs so "faster" and
// "cheaper" are measured claims, and feed the learned router contrastive labels.
//
// WHY (2026-07-13, Stuart): "Nobody cares that they're saving 20 seconds. They care that
// they're doing things 40% faster… cheaper AND faster = fundamentally more efficient."
// A faster-% needs a measured baseline — this harness produces it. No number here is invented:
// every duration is a wall-clock measurement of a real run, every quality label is a
// deterministic check against a known answer, and failures are recorded as failures.
//
// BILLING SAFETY (the $1,600 / issue-#557 lesson): every spawned `claude -p` runs with
// ANTHROPIC_API_KEY / CLAUDE_API_KEY / ANTHROPIC_AUTH_TOKEN stripped from its environment —
// subscription billing only; worst case is plan throttling, never a surprise bill.
//
// FAIRNESS NOTE: durations include the CLI's startup overhead, identically for every tier —
// the tier-vs-tier ratio is apples-to-apples; absolute numbers are "task via harness", not
// raw model latency.
//
// Writes:
//   • labels → recordOutcome(prompt, {model: quality, ...})  — one contrastive row per task,
//     all tiers scored (the DRACO row shape rUv's router trains on)
//   • receipts → ~/.claude/metaharness/routing-receipts.jsonl with source:'calibration',
//     duration_ms (cheap tier) + baseline_duration_ms (frontier) → powers the ⚡ faster-% card
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordOutcome } from './metaharness-router.mjs';
import { CLAUDE_MODEL_IDS, estimateCosts, estTokens } from './route-cheap.mjs';

const CLAUDE = path.join(os.homedir(), '.npm-global/bin/claude');
const RECEIPTS = process.env.METAHARNESS_RECEIPTS
  || path.join(os.homedir(), '.claude', 'metaharness', 'routing-receipts.jsonl');

const MODELS = [
  { alias: 'haiku', name: CLAUDE_MODEL_IDS.haiku },
  { alias: 'sonnet', name: CLAUDE_MODEL_IDS.sonnet },
  { alias: 'opus', name: CLAUDE_MODEL_IDS.opus },   // the baseline tier
];
const BASELINE = CLAUDE_MODEL_IDS.opus;

// Deterministic tasks: known answers, graded by regex — no LLM judge, no judgment calls.
const TASKS = [
  { class: 'mechanical', prompt: 'Reply with exactly this single word and nothing else: CALIBRATED', pass: /CALIBRATED/ },
  { class: 'mechanical', prompt: 'List only the function names, comma-separated, from this code and say nothing else:\nfunction parseHeader(x){}\nconst mapRows = (y) => y;\nasync function flushQueue(){}', pass: /parseHeader.*mapRows.*flushQueue/s },
  { class: 'analytical', prompt: 'What is 17 * 23? Reply with the number only.', pass: /\b391\b/ },
  { class: 'analytical', prompt: "In JavaScript, what does this print? console.log(0.1 + 0.2 === 0.3, (0.1 + 0.2).toFixed(1) === '0.3'). Reply with exactly the two words printed, space-separated.", pass: /false\s+true/i },
  { class: 'analytical', prompt: 'In JavaScript: for (var i = 0; i < 3; i++) { setTimeout(() => console.log(i)); } What three numbers print? Reply with them space-separated only.', pass: /3\s+3\s+3/ },
];

function runOnce(alias, prompt) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, ['-p', prompt, '--model', alias], { env, encoding: 'utf8', timeout: 180000 });
  return { ms: Date.now() - t0, out: (r.stdout || '').trim(), ok: r.status === 0 };
}

const results = [];
for (const [ti, task] of TASKS.entries()) {
  const row = { task, runs: {} };
  for (const m of MODELS) {
    const r = runOnce(m.alias, task.prompt);
    const passed = r.ok && task.pass.test(r.out);
    row.runs[m.name] = { ms: r.ms, passed, out: r.out.slice(0, 60) };
    console.log(`task ${ti + 1}/${TASKS.length} [${task.class}] ${m.name}: ${passed ? 'PASS' : 'FAIL'} in ${(r.ms / 1000).toFixed(1)}s${passed ? '' : ` — got: ${r.out.slice(0, 50) || '(no output)'}`}`);
  }
  results.push(row);

  // Label: one contrastive row per task, every tier scored. Failures ARE the valuable labels.
  const scores = {};
  for (const m of MODELS) scores[m.name] = row.runs[m.name].passed ? 0.95 : 0.1;
  await recordOutcome(task.prompt, scores);

  // Receipts: one row per cheap tier vs the frontier baseline, with MEASURED times both sides.
  const base = row.runs[BASELINE];
  for (const m of MODELS) {
    if (m.name === BASELINE) continue;
    const run = row.runs[m.name];
    const inTok = estTokens(task.prompt); const outTok = estTokens(run.out || 'x');
    const c = estimateCosts(m.name, inTok, outTok, BASELINE);
    if (!c) continue;
    fs.appendFileSync(RECEIPTS, JSON.stringify({
      ts: new Date().toISOString(), source: 'calibration', task_class: task.class,
      task: task.prompt.slice(0, 80), model: m.name, frontier_ref: BASELINE,
      est_in_tokens: inTok, est_out_tokens: outTok, token_source: 'estimated',
      est_cost: c.cost, est_frontier_cost: c.frontier, saved: c.saved,
      duration_ms: run.ms, baseline_duration_ms: base.ms, quality_pass: run.passed,
    }) + '\n');
  }
}

const cheap = results.flatMap((r) => [r.runs[CLAUDE_MODEL_IDS.haiku].ms]);
const base = results.map((r) => r.runs[BASELINE].ms);
const sum = (a) => a.reduce((s, x) => s + x, 0);
console.log(`\nhaiku total ${(sum(cheap) / 1000).toFixed(1)}s vs opus baseline ${(sum(base) / 1000).toFixed(1)}s on ${TASKS.length} tasks`);
console.log('labels + receipts written. Render: node scripts/metaharness-receipts.mjs');
