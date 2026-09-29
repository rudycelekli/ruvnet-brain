import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'agentdb-fleet-doctor.mjs'), 'utf8');

function sql(db, q) {
  try { return execFileSync('sqlite3', ['-noheader', db, q], { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch { return null; }
}

// Regression: scripts/agentdb-fleet-doctor.mjs interpolated a project directory basename directly
// into SQL (WHERE namespace='${name}') with no escaping. `name` is an operator-chosen CLI arg, not
// adversarial input, but a project folder with an apostrophe in its name (e.g. "Bob's-project")
// broke the query's syntax outright -- a self-inflicted bug, not a security hole, but a real one.
describe('agentdb-fleet-doctor: namespace SQL is escaped against a quote in the project name', () => {
  it('the source escapes namespace before interpolating it into a query', () => {
    expect(SOURCE).toContain("name.replace(/'/g, \"''\")");
    expect(SOURCE).toMatch(/namespace='\$\{escapedName\}'/);
    expect(SOURCE).not.toMatch(/namespace='\$\{name\}'/);
  });

  it('a namespace containing a quote round-trips correctly through the same escaping this file uses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdb-fleet-doctor-sql-'));
    const db = path.join(dir, 'memory.db');
    try {
      execFileSync('sqlite3', [db, 'CREATE TABLE memory_entries (namespace TEXT, key TEXT);']);
      const name = "Bob's-project";
      const escaped = name.replace(/'/g, "''");
      execFileSync('sqlite3', [db, `INSERT INTO memory_entries VALUES ('${escaped}', 'k1');`]);

      const escapedResult = sql(db, `SELECT count(*) FROM memory_entries WHERE namespace='${escaped}';`);
      expect(escapedResult).toBe('1'); // sync-version-ignore: a sqlite row count, not a version

      // Sabotage check: the OLD, unescaped form must fail to even execute as valid SQL against
      // this exact quoted value -- proving the escaping is load-bearing, not decorative.
      const unescapedResult = sql(db, `SELECT count(*) FROM memory_entries WHERE namespace='${name}';`);
      expect(unescapedResult).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
