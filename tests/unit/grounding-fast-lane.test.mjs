import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { groundedToolResult } from '../../kb/grounded-response.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const homes = [];
function fixture({ installed = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-card-'));
  homes.push(home);
  const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
    RUVNET_BRAIN_STATE_DIR: path.join(home, '.config/ruvnet-brain'),
    RUVNET_BRAIN_HOME: path.join(home, '.cache/ruvnet-brain'),
    RUVNET_GROUNDING_TURN_DIR: path.join(home, '.cache/ruvnet-brain/grounding-turn'),
    RUVNET_EVIDENCE_FILE: path.join(home, 'evidence.jsonl'), RUVNET_BRAIN_METER: '0', RUVNET_TURN_CAPTURE: 'off',
    CLAUDE_PLUGIN_ROOT: path.join(ROOT, 'plugin'), PLUGIN_ROOT: path.join(ROOT, 'plugin') };
  if (installed) {
    const generation = path.join(env.RUVNET_BRAIN_HOME, 'versions/test');
    fs.mkdirSync(generation, { recursive: true });
    fs.cpSync(path.join(ROOT, 'plugin/scripts'), path.join(generation, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(env.RUVNET_BRAIN_HOME, 'active.json'), JSON.stringify({ codeRoot: 'versions/test', generation: 1 }));
    fs.writeFileSync(path.join(env.RUVNET_BRAIN_HOME, '.spine-seeded'), 'test');
  }
  return { home, cwd, env };
}
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function stamps(f) {
  const dir = path.join(f.home, '.cache/ruvnet-brain/grounded');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
function fire(f, host, id, payload) {
  const script = host === 'codex' ? 'codex-hook-wrapper.mjs' : 'hook-shim.mjs';
  return spawnSync(process.execPath, [path.join(ROOT, 'plugin/scripts', script), id], {
    cwd: f.cwd, env: f.env, input: JSON.stringify({ cwd: f.cwd, ...payload }), encoding: 'utf8', timeout: 10_000,
  });
}
function post(query, response) {
  return { hook_event_name: 'PostToolUse', tool_name: 'mcp__ruvnet_brain__search_ruvnet', tool_input: { query }, tool_response: response };
}
async function liveCard(f, query) {
  const kb = path.join(f.home, 'kb'); fs.mkdirSync(kb);
  fs.copyFileSync(path.join(ROOT, 'kb/capability-cards.md'), path.join(kb, 'capability-cards.md'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'kb/forge-mcp-all.mjs')], { cwd: f.cwd, env: { ...f.env, KB_DIR: kb, RUVNET_BRAIN_KB: kb } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`RPC timeout: ${err}`)); }, 12_000);
    child.stdout.on('data', d => {
      out += d;
      if (!out.includes('\n')) return;
      clearTimeout(timer); child.kill();
      try { resolve(JSON.parse(out.split('\n')[0]).result); } catch (e) { reject(e); }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { if (!out.includes('\n')) { clearTimeout(timer); reject(new Error(`RPC exit ${code}: ${err}`)); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_ruvnet', arguments: { query } } }) + '\n');
  });
}
describe('fast lane grounding evidence (remaining #316 case)', () => {
  it.each(['claude', 'codex'])('a real MCP card answer satisfies Stop through the %s entrypoints', async host => {
    const f = fixture({ installed: true });
    const query = 'Which RuvNet tool should I use to cache repeated vector queries?';
    const session_id = 'card-search';
    const mark = fire(f, host, 'grounding-turn-mark', { hook_event_name: 'UserPromptSubmit', session_id, prompt: query });
    expect(mark.status).toBe(0);
    const response = await liveCard(f, query);
    expect(response.isError).toBe(false);
    expect(response.structuredContent.cardLane.repo).toBe('rulake');
    expect(response.content[0].text).not.toMatch(/Searched \d+ RuvNet repos/);
    const stamp = fire(f, host, 'grounding-stamp', post(query, response));
    expect(stamp.status).toBe(0);
    expect(stamp.stderr).toBe('');
    expect(stamps(f)).toContain('.any-search');
    expect(stamps(f)).not.toContain('ruflo');
    expect(stamps(f)).not.toContain('agentdb');
    const stop = fire(f, host, 'grounding-turn-gate', { hook_event_name: 'Stop', session_id, stop_hook_active: false });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    expect(stop.stderr).toBe('');
  });

  const query = 'how should agent handoffs stay consistent';
  function validResult() {
    return groundedToolResult({ query, k: 1, body: 'An inspectable cited capability card.',
      results: [{ repo: 'ruflo', path: 'capability-cards.md#ruflo', text: 'An inspectable cited capability card.' }],
      extra: { cardLane: { repo: 'ruflo', path: 'capability-cards.md#ruflo' } } });
  }
  it.each([false, true])('accepts a valid card result with a generic query (JSON encoded: %s)', encoded => {
    const f = fixture();
    const result = validResult();
    expect(fire(f, 'claude', 'grounding-stamp', post(query, encoded ? JSON.stringify(result) : result)).status).toBe(0);
    expect(stamps(f)).toEqual(['.any-search']);
  });
  it.skipIf(process.platform === 'win32')('uses the absolute shim interpreter when PATH contains Bash but no Node', () => {
    const f = fixture();
    const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
    for (const command of ['bash', 'mkdir', 'date', 'stat']) {
      const resolved = spawnSync('bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
      fs.symlinkSync(resolved, path.join(bin, command));
    }
    f.env.PATH = bin;
    f.env.RUVNET_GROUNDING_NODE = '/must-be-overridden-by-shim';
    expect(spawnSync('node', ['--version'], { env: f.env }).error?.code).toBe('ENOENT');
    const stamp = fire(f, 'claude', 'grounding-stamp', post(query, validResult()));
    expect(stamp.status).toBe(0);
    expect(stamp.stderr).toBe('');
    expect(stamps(f)).toEqual(['.any-search']);
  });
  it.each(['claude', 'codex'])('Brain OFF prevents a valid card result from stamping through %s', host => {
    const f = fixture({ installed: true });
    fs.mkdirSync(f.env.RUVNET_BRAIN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(f.env.RUVNET_BRAIN_STATE_DIR, 'brain-off'), 'user switched off');
    const stamp = fire(f, host, 'grounding-stamp', post(query, validResult()));
    expect(stamp.status).toBe(0);
    expect(stamp.stdout).toBe('');
    expect(stamp.stderr).toBe('');
    expect(stamps(f)).toEqual([]);
  });

  const invalid = [
    ['error', r => { r.isError = true; }],
    ['disabled', r => { r.disabled = true; }],
    ['disabled metadata', r => { r._meta = { disabled: true }; }],
    ['empty retrieval', r => { r.structuredContent.retrieval.results = []; }],
    ['missing retrieval', r => { delete r.structuredContent.retrieval; }],
    ['wrong query', r => { r.structuredContent.retrieval.query = 'different request'; }],
    ['wrong source digest', r => { r.structuredContent.retrieval.results[0].contentSha256 = '0'.repeat(64); }],
    ['unpresented source', r => { r.content = [{ type: 'text', text: 'No cited answer.' }]; }],
    ['wrong card identity', r => { r.structuredContent.cardLane.repo = 'agentdb'; }],
    ['unsafe source path', r => { r.structuredContent.cardLane.path = r.structuredContent.retrieval.results[0].path = '../outside'; }],
    ['wrong schema', r => { r.structuredContent.retrieval.schemaVersion = 2; }],
    ['wrong rank', r => { r.structuredContent.retrieval.results[0].rank = 2; }],
    ['invalid depth', r => { r.structuredContent.retrieval.k = 0; }],
    ['multiple card hits', r => { r.structuredContent.retrieval.results.push({ ...r.structuredContent.retrieval.results[0], rank: 2 }); }],
  ];
  it.each(invalid)('refuses %s and leaves the Stop gate armed', (_name, mutate) => {
    const f = fixture();
    const session_id = 'invalid-card';
    fire(f, 'claude', 'grounding-turn-mark', { hook_event_name: 'UserPromptSubmit', session_id, prompt: 'Explain ruflo memory.' });
    const response = validResult(); mutate(response);
    const stamp = fire(f, 'claude', 'grounding-stamp', post(query, response));
    expect(stamp.status).toBe(0);
    expect(stamp.stderr).toBe('');
    expect(stamps(f)).toEqual([]);
    const stop = fire(f, 'claude', 'grounding-turn-gate', { hook_event_name: 'Stop', session_id, stop_hook_active: false });
    expect(stop.stdout).toContain('no successful');
  });
  it.each([undefined, '', 'not JSON', 'FAST LANE — zero-ML keyword match'])('does not stamp a missing or prose-only response: %s', response => {
    const f = fixture();
    const stamp = fire(f, 'claude', 'grounding-stamp', post(query, response));
    expect(stamp.status).toBe(0);
    expect(stamps(f)).toEqual([]);
  });
});
