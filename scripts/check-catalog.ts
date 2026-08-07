/**
 * Asserts the committed catalog still matches what the vendored plugin source
 * would generate. Wired into `pnpm check` and into the daily vendor-freshness
 * workflow, so a stale catalog rings the same alarm as a stale vendor tree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from './generate-catalog.ts';
import { packageRoot } from './plugin-repo.ts';

const dir = join(packageRoot, 'src', 'catalog');
const drifted: string[] = [];

for (const [name, expected] of Object.entries(generate())) {
  let actual: string;
  try {
    actual = readFileSync(join(dir, name), 'utf8');
  } catch {
    drifted.push(`${name} is missing`);
    continue;
  }
  if (actual !== expected) {
    const a = actual.split('\n');
    const b = expected.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    drifted.push(
      `${name} differs at line ${at + 1}\n`
        + `      committed: ${JSON.stringify(a[at]?.slice(0, 100))}\n`
        + `      generated: ${JSON.stringify(b[at]?.slice(0, 100))}`,
    );
  }
}

if (drifted.length) {
  console.error('generated catalog is out of date:\n');
  for (const line of drifted) console.error(`  ${line}`);
  console.error('\nrun `pnpm catalog:generate` and commit the result.');
  process.exit(1);
}

console.log('catalog is up to date');
