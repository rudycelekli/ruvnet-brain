import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';

const CHECKPOINT = path.resolve(import.meta.dirname, '../../plugin/scripts/project-progression-checkpoint.mjs');
const STORE = path.resolve(import.meta.dirname, '../../plugin/scripts/project-progression-store.mjs');
const roots = [];

// A spawned CLI fixture, not an injected runner: --path owns the canonical rows, while the
// mirror deliberately follows cwd, reproducing Ruflo's independent memory-root resolution.
const CLI = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const db = flag('--path');
fs.appendFileSync(process.env.PROGRESSION_CWD_CALLS, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
const rows = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {};
const identity = flag('--namespace') + '/' + flag('--key');
if (args[1] === 'store') {
  if (Object.hasOwn(rows, identity)) process.exit(1);
  rows[identity] = flag('--value');
  fs.writeFileSync(db, JSON.stringify(rows));
  const mirror = path.join(process.cwd(), '.swarm', 'agentdb-memory.db');
  fs.mkdirSync(path.dirname(mirror), { recursive: true });
  fs.writeFileSync(mirror, JSON.stringify(rows));
  console.log('stored');
} else if (args[1] === 'retrieve') {
  if (!Object.hasOwn(rows, identity)) process.exit(1);
  console.log(rows[identity]);
} else if (args[1] === 'list') {
  const entries = Object.keys(rows).filter((key) => key.startsWith(flag('--namespace') + '/'))
    .map((key) => ({ key: key.slice(key.indexOf('/') + 1), namespace: flag('--namespace') }));
  const offset = Number(flag('--offset'));
  const limit = Number(flag('--limit'));
  const page = entries.slice(offset, offset + limit);
  const hasMore = offset + page.length < entries.length;
  console.log(JSON.stringify({ entries: page, total: entries.length, offset, limit,
    hasMore, nextOffset: hasMore ? offset + page.length : null }));
} else process.exit(2);
`;

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-cwd-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [project, home, bin, path.join(project, '.swarm'), path.join(project, 'nested')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  execFileSync('git', ['init', '-q'], { cwd: project });
  const packageRoot = path.join(bin, 'node_modules', 'ruflo');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'ruflo', bin: 'cli.mjs' }));
  fs.writeFileSync(path.join(packageRoot, 'cli.mjs'), CLI);
  const binary = path.join(bin, process.platform === 'win32' ? 'ruflo.cmd' : 'ruflo.mjs');
  fs.writeFileSync(binary, CLI, { mode: 0o755 });
  const calls = path.join(root, 'calls.jsonl');
  // Only the disposable fixture is writable; inherited store pins cannot redirect this probe.
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    RUFLO_BIN: binary, RUFLO_DAEMON_AUTOSTART: '0', PROGRESSION_CWD_CALLS: calls,
  };
  return { root, project, calls, env, db: path.join(project, '.swarm', 'memory.db') };
}

function checkpoint(fx, projectDir, index) {
  return spawnSync(process.execPath, [CHECKPOINT, '--project-dir', projectDir,
    '--session', `cwd-session-${index}`, '--json', JSON.stringify({
      currentGoal: `Keep checkpoint ${index} in the canonical project`, nextAction: 'Verify its exact row',
    })], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 30_000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('checkpoint Ruflo working directory', () => {
  it.each(['root', 'subdirectory'])('keeps repeated %s checkpoints and CLI restoration in one project', (input) => {
    const fx = fixture();
    const projectDir = input === 'root' ? fx.project : path.join(fx.project, 'nested');
    const receipts = [];
    for (let index = 1; index <= 3; index += 1) {
      const result = checkpoint(fx, projectDir, index);
      expect(result.status, result.stderr).toBe(0);
      receipts.push(JSON.parse(result.stdout));
    }
    const rows = JSON.parse(fs.readFileSync(fx.db, 'utf8'));
    expect(Object.keys(rows)).toHaveLength(3);
    for (const receipt of receipts) {
      const snapshot = JSON.parse(rows[`project-progression/${receipt.eventKey}`]);
      expect(receipt.readbackVerified).toBe(true);
      expect(receipt.readbackDigest).toBe(snapshot.payloadDigest);
      expect(snapshot.projectIdentity.canonicalAgentDbPath).toBe(fx.db);
    }
    const restored = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { ProjectProgressionStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
      const store = new ProjectProgressionStore({ projectDir: process.argv[1], reader: null });
      console.log(JSON.stringify(store.restoreLatest({ pageSize: 1 })));
    `, projectDir], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 30_000 });
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout).payload.evidence.exactRetrieved).toBe(3);
    const calls = fs.readFileSync(fx.calls, 'utf8').trim().split('\n').map(JSON.parse);
    expect(new Set(calls.map((call) => call.args[1]))).toEqual(new Set(['store', 'retrieve', 'list']));
    expect(calls.every((call) => call.cwd === fx.project)).toBe(true);
    expect(calls.every((call) => call.args[call.args.indexOf('--path') + 1] === fx.db)).toBe(true);
    expect(digestCanonical(JSON.parse(fs.readFileSync(path.join(fx.project, '.swarm', 'agentdb-memory.db'), 'utf8'))))
      .toBe(digestCanonical(rows));
    expect(fs.existsSync(path.join(fx.project, '.swarm', '.swarm'))).toBe(false);
    expect(fs.existsSync(path.join(fx.project, 'nested', '.swarm'))).toBe(false);
  });

  it('refuses a missing root before invoking Ruflo', () => {
    const fx = fixture();
    const result = checkpoint(fx, path.join(fx.root, 'missing'), 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('projectDir does not exist');
    expect(fs.existsSync(fx.calls)).toBe(false);
  });

  it('refuses an escaping store symlink before invoking Ruflo', () => {
    const fx = fixture();
    const foreign = path.join(fx.root, 'foreign');
    fs.mkdirSync(foreign);
    fs.rmSync(path.join(fx.project, '.swarm'), { recursive: true });
    fs.symlinkSync(foreign, path.join(fx.project, '.swarm'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = checkpoint(fx, fx.project, 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('store symlink escape rejected');
    expect(fs.existsSync(fx.calls)).toBe(false);
    expect(fs.readdirSync(foreign)).toEqual([]);
  });
});
