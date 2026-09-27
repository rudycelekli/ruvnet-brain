import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  acceptanceGates,
  aggregate,
  benchmarkExitCode,
  evaluateSemanticEvidence,
} from '../../scripts/top100-benchmark.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function row(overrides = {}) {
  return {
    level: 'expert',
    axis: 'implementation-evidence',
    latencyMs: 100,
    grounded: true,
    routed: true,
    sufficientEvidence: true,
    groundingReceipt: true,
    enforceableReceipt: true,
    semanticPassed: true,
    error: false,
    ...overrides,
  };
}

describe('Top-100 acceptance is stricter than the legacy routing proxy', () => {
  it('--help exits without starting the expensive MCP benchmark', () => {
    const output = execFileSync(process.execPath, ['scripts/top100-benchmark.mjs', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 2_000,
    });
    expect(output).toContain('--ids top-001,top-093');
    expect(output).toContain('--no-write');
    expect(output).not.toContain('forge-mcp-all: serving');
  });

  it('runs the candidate worker code through the stable spine while keeping installed KB data', () => {
    const benchmark = fs.readFileSync(path.join(ROOT, 'scripts/top100-benchmark.mjs'), 'utf8');
    const server = fs.readFileSync(path.join(ROOT, 'plugin/mcp/server.mjs'), 'utf8');
    expect(benchmark).toContain(
      "RUVNET_BRAIN_CHILD_MCP: path.join(ROOT, 'kb', 'forge-mcp-all.mjs')",
    );
    expect(server).toContain(
      "process.env.RUVNET_BRAIN_CHILD_MCP || path.join(KB, 'forge-mcp-all.mjs')",
    );
  });

  it('lets the supervised worker own cancellation before the benchmark transport deadline', () => {
    const benchmark = fs.readFileSync(path.join(ROOT, 'scripts/top100-benchmark.mjs'), 'utf8');
    const server = fs.readFileSync(path.join(ROOT, 'plugin/mcp/server.mjs'), 'utf8');
    const benchmarkTimeout = Number(
      benchmark.match(/TOP100_RPC_TIMEOUT_MS\)\s*\|\|\s*([\d_]+)/)?.[1]?.replaceAll('_', ''),
    );
    const workerTimeout = Number(
      server.match(/RUVNET_BRAIN_CALL_TIMEOUT_MS\)\s*\|\|\s*([\d_]+)/)?.[1]?.replaceAll('_', ''),
    );
    expect(benchmarkTimeout).toBeGreaterThan(workerTimeout);
  });

  it('fails a superficially well-routed run that has an outage and no semantic assertions', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i === 0
      ? { error: true, grounded: false, routed: false, sufficientEvidence: false, latencyMs: 120_001 }
      : {}));
    const metrics = aggregate(rows);
    expect(metrics.overall.legacyRoutingProxyPct).toBeGreaterThan(98);

    const acceptance = acceptanceGates(metrics, { semanticAssertionsPresent: false });
    expect(acceptance.pass).toBe(false);
    expect(acceptance.gates.find((g) => g.id === 'no-errors')?.pass).toBe(false);
    expect(acceptance.gates.find((g) => g.id === 'max-at-most-4s')?.pass).toBe(false);
    expect(acceptance.gates.find((g) => g.id === 'semantic-answer-assertions')?.pass).toBe(false);
  });

  it('evaluates every required fact and accepts declared wording alternatives', () => {
    const required = [
      { label: 'storage', anyOf: ['single file', '.rvf'] },
      { label: 'index', anyOf: ['hnsw', 'hierarchical navigable small world'] },
    ];
    expect(evaluateSemanticEvidence('RVF is a single file containing an HNSW index.', required))
      .toMatchObject({ present: true, pass: true, matched: 2, required: 2 });
    expect(evaluateSemanticEvidence('RVF stores vectors.', required))
      .toMatchObject({ present: true, pass: false, matched: 0, required: 2 });
    expect(evaluateSemanticEvidence('anything', []))
      .toMatchObject({ present: false, pass: false, matched: 0, required: 0 });
  });

  it('fails semantic acceptance when assertions exist but answers do not satisfy them', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i < 94 ? {} : { semanticPassed: false }));
    const acceptance = acceptanceGates(aggregate(rows), { semanticAssertionsPresent: true });
    const semantic = acceptance.gates.find((g) => g.id === 'semantic-answer-accuracy-95pct');
    expect(semantic?.pass).toBe(false);
    expect(semantic?.actual).toBe(0.94);
  });

  it('passes only when every explicit gate is satisfied', () => {
    const metrics = aggregate(Array.from({ length: 100 }, () => row()));
    const acceptance = acceptanceGates(metrics, { semanticAssertionsPresent: true, fullCorpus: true });
    expect(acceptance.pass).toBe(true);
    expect(acceptance.gates.every((g) => g.pass)).toBe(true);
  });

  it('never accepts a selected-ID diagnostic as the full Top-100 gate', () => {
    const metrics = aggregate(Array.from({ length: 3 }, () => row()));
    const acceptance = acceptanceGates(metrics, {
      semanticAssertionsPresent: true,
      fullCorpus: false,
    });
    expect(acceptance.pass).toBe(false);
    expect(acceptance.gates.find((g) => g.id === 'full-corpus-100')?.pass).toBe(false);
  });

  it('fails a full benchmark process on rejected acceptance but keeps diagnostics inspectable', () => {
    expect(benchmarkExitCode({ pass: true }, { diagnostic: false })).toBe(0);
    expect(benchmarkExitCode({ pass: false }, { diagnostic: false })).toBe(1);
    expect(benchmarkExitCode({ pass: false }, { diagnostic: true })).toBe(0);
  });
});
