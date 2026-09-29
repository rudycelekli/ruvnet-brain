import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// WHY THIS EXISTS (2026-09-29). scripts/release.mjs confirmed a promoted corpus release with
// `gh release view <tag> --json tagName,isDraft,isLatest,isPrerelease,assets`. `isLatest` is NOT a
// `gh release view` field (gh 2.101.0: "Unknown JSON field"; it exists only on `gh release list`), so
// the one publisher's final confirmation could never succeed against the real CLI -- and its test
// never noticed, because the fake gh answered any field it was asked for. This test reads every
// `gh release view|list ... --json <fields>` call site in the shipped tree and checks each field
// against the field lists captured from the real CLI (tests/fixtures/gh-json-fields.json).

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIELDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/gh-json-fields.json'), 'utf8'));
const SCAN_ROOTS = ['scripts', 'bin', 'kb', 'plugin', '.github'];
const SCANNED = /\.(mjs|cjs|js|sh|ya?ml)$/;
const CALL = /\brelease\b['"]?\s*,?\s*['"]?(view|list)\b/g;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git') && entry.name !== '.github') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile() && SCANNED.test(entry.name)) yield file;
  }
}

/** Comment lines out, so prose that merely NAMES `gh release list --json` is never read as a call. */
const executable = (text) => text.split('\n')
  .map((line) => (/^\s*(\/\/|\*|\/\*|#)/.test(line) ? '' : line)).join('\n');

/** Every `gh release view|list` call with a literal --json field list: { line, command, fields }. */
function scanGhJsonCalls(text) {
  const source = executable(text);
  const calls = [];
  const starts = [...source.matchAll(CALL)];
  starts.forEach((match, index) => {
    const before = source.slice(Math.max(0, match.index - 80), match.index);
    if (!/gh/.test(before)) return;
    const hardEnd = Math.min(index + 1 < starts.length ? starts[index + 1].index : source.length, match.index + 400);
    let window = source.slice(match.index + match[0].length, hardEnd);
    // One statement only: a newline ends it unless the line continues (bash `\`, a JS array/arg list).
    const lines = window.split('\n');
    const kept = [lines[0]];
    for (let i = 1; i < lines.length && /[\\,([]\s*$/.test(kept[kept.length - 1]); i += 1) kept.push(lines[i]);
    window = kept.join('\n');
    const json = window.match(/--json['"]?\s*,?\s*['"]?([A-Za-z]+(?:,[A-Za-z]+)*)/);
    if (!json) return;
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      command: `release ${match[1]}`,
      fields: json[1].split(','),
    });
  });
  return calls;
}

const inventory = () => SCAN_ROOTS.flatMap((root) => [...walk(path.join(ROOT, root))])
  .flatMap((file) => scanGhJsonCalls(fs.readFileSync(file, 'utf8'))
    .map((call) => ({ file: path.relative(ROOT, file), ...call })));

describe('every gh release --json field is one the real CLI accepts', () => {
  it('the captured field lists are the real ones (isLatest is list-only)', () => {
    expect(FIELDS.ghVersion).toMatch(/^2\.101\.0/);
    expect(FIELDS['release view']).toContain('tagName');
    expect(FIELDS['release view']).not.toContain('isLatest');
    expect(FIELDS['release list']).toContain('isLatest');
  });

  it('the scanner finds the call sites it must find (a scanner that finds nothing proves nothing)', () => {
    const calls = inventory();
    const at = (file, command) => calls.filter((call) => call.file === file && call.command === command);
    // Single-line JS, multi-line JS array, and a bash call continued with `\`.
    expect(at('scripts/release.mjs', 'release view').length).toBeGreaterThanOrEqual(3);
    expect(at('scripts/approved-runtime.mjs', 'release list')).toEqual([
      expect.objectContaining({ fields: ['tagName', 'isDraft', 'isPrerelease'] })]);
    expect(at('.github/workflows/corpus-seed.yml', 'release view')).toEqual([
      expect.objectContaining({ fields: ['tagName', 'isDraft', 'isPrerelease', 'assets'] })]);
    expect(at('scripts/corpus-next-seed.mjs', 'release list').length).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('the scanner reports an invalid field and ignores prose that merely names one', () => {
    const bad = scanGhJsonCalls("const v = gh(['release', 'view', tag, '--json', 'tagName,isLatest', '--repo', r]);");
    expect(bad).toEqual([{ line: 1, command: 'release view', fields: ['tagName', 'isLatest'] }]);
    expect(scanGhJsonCalls(' * `gh release list --json` page -- both spellings are accepted')).toEqual([]);
    expect(scanGhJsonCalls('  # gh release view --json isLatest')).toEqual([]);
  });

  it('no shipped call asks gh for a field it does not have', () => {
    const invalid = inventory().flatMap((call) => call.fields
      .filter((field) => !FIELDS[call.command].includes(field))
      .map((field) => `${call.file}:${call.line} ${call.command} --json ${field}`));
    expect(invalid).toEqual([]);
  });
});
