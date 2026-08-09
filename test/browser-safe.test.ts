/**
 * The web app imports this package's main entry directly as TypeScript source
 * through Vite. Any `node:fs` that creeps into that import graph breaks the app
 * at bundle time - and it would creep in easily, because the Node-only vendoring
 * helpers live one directory away.
 *
 * So the constraint is a test rather than a convention: walk every module
 * reachable from src/index.ts and assert none of them reaches for Node.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FORBIDDEN_MODULES = [
  'node:fs',
  'node:path',
  'node:os',
  'node:url',
  'node:module',
  'node:child_process',
  'node:crypto',
  'fs',
  'path',
  'os',
  'child_process',
];

function reachableFrom(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);

    for (const match of source.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'/g)) {
      const specifier = match[1] ?? match[2]!;
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

describe('browser safety', () => {
  const modules = reachableFrom(resolve(srcDir, 'index.ts'));

  it('reaches a meaningful number of modules', () => {
    // Guards the walker itself: a broken regex would make every other
    // assertion here pass vacuously.
    expect(modules.size).toBeGreaterThan(8);
  });

  it('imports no Node built-ins', () => {
    const offenders: string[] = [];
    for (const [file, source] of modules) {
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        if (FORBIDDEN_MODULES.includes(match[1]!)) {
          offenders.push(`${file.replace(srcDir, 'src')} imports ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not reference process', () => {
    const offenders = [...modules]
      .filter(([, source]) => /\bprocess\s*\.\s*(env|argv|cwd|exit|platform)\b/.test(source))
      .map(([file]) => file.replace(srcDir, 'src'));
    expect(offenders).toEqual([]);
  });

  it('does not reach into src/node', () => {
    const offenders = [...modules.keys()]
      .filter((file) => file.includes(`${srcDir}/node/`))
      .map((file) => file.replace(srcDir, 'src'));
    expect(offenders).toEqual([]);
  });

  it('covers the modules the app runs a library scan through', () => {
    // The checks above only see what `src/index.ts` reaches. A module that stops
    // being exported from the barrel silently leaves the guard, and these two
    // are the ones the browser leans on hardest: the scanner pulls tens of
    // megabytes over fetch, and the interpreter runs per record in the tab.
    const covered = [...modules.keys()].map((file) => file.replace(srcDir, 'src'));
    expect(covered).toContain('src/server/library.ts');
    expect(covered).toContain('src/simulate/interpret.ts');
    expect(covered).toContain('src/simulate/record.ts');
  });
});
