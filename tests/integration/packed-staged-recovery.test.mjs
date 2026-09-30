import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'packed-recovery-')));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

// The installer launches this entry point with spawnSync, rather than importing it. Import
// closure checks missed it, so checkout-only recovery tests passed while npm installs failed.
it('the actual npm artifact launches authenticated staged recovery and refuses unsigned bytes', () => {
  const isWin = process.platform === 'win32';
  const packed = JSON.parse(execFileSync(isWin ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    { cwd: root, encoding: 'utf8', timeout: 120_000, shell: isWin }))[0];
  execFileSync('tar', ['-xzf', path.join(scratch, packed.filename), '-C', scratch]);
  const home = path.join(scratch, 'home');
  const live = path.join(home, 'kb');
  const staged = path.join(scratch, 'staged');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(staged);
  const privateBytes = Buffer.from('private bytes that recovery must preserve');
  fs.writeFileSync(path.join(live, 'private.rvf'), privateBytes);
  const bundlePath = path.join(scratch, 'bundle.zip');
  const signaturePath = `${bundlePath}.sig`;
  fs.writeFileSync(bundlePath, 'untrusted archive');
  fs.writeFileSync(signaturePath, Buffer.alloc(64));
  const descriptor = path.join(scratch, 'recovery-input.json');
  fs.writeFileSync(descriptor, JSON.stringify({ stagedDir: staged, liveDir: live,
    bundlePath, signaturePath, expectedRuntimeVersion: packed.version }));
  const result = spawnSync(process.execPath,
    [path.join(scratch, 'package', 'kb', 'forge-update.mjs'), '--staged-release', descriptor],
    { cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home,
      XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config'),
      RUVNET_BRAIN_HOME: path.join(home, 'brain'), RUVNET_BRAIN_KB: live,
      RUVNET_TURN_CAPTURE: 'off' }, timeout: 20_000 });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('staged release signature verification failed');
  expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
  expect(fs.readFileSync(path.join(live, 'private.rvf'))).toEqual(privateBytes);
  expect(fs.readdirSync(live)).toEqual(['private.rvf']);
  expect(fs.readdirSync(staged)).toEqual([]);
}, 120_000);
