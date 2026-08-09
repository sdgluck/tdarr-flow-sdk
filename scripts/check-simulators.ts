/**
 * Asserts every simulator still describes a plugin that exists, with the number
 * of outputs it claims.
 *
 * `src/simulate/plugins.ts` is a transcription of the vendored plugin bodies, and
 * a transcription rots the moment upstream moves. This cannot prove the logic
 * still matches - only reading the source can do that - but it catches the
 * failure that actually happens: a plugin gaining or losing an output between
 * versions. `compareFileSizeRatio` went from 2 outputs at `@1.0.0` to 3 at
 * `@2.0.0`, and a simulator still branching two ways would route files
 * confidently down a path that no longer means what it meant.
 *
 * Wired into `pnpm check` beside `catalog:check`.
 */

import { getPluginByRef } from '../src/catalog/index.ts';
import type { PluginRefString } from '../src/types/catalog.ts';
import { SIMULATORS } from '../src/simulate/index.ts';

const problems: string[] = [];

for (const [ref, simulator] of Object.entries(SIMULATORS)) {
  if (simulator.ref !== ref) {
    problems.push(`${ref} is registered under a key that does not match its own ref `
      + `("${simulator.ref}")`);
  }

  const entry = getPluginByRef(ref as PluginRefString);
  if (!entry) {
    problems.push(`${ref} is not in the catalog. Either the plugin was removed upstream or the `
      + 'ref is a typo; a simulator for a plugin that does not exist can never fire.');
    continue;
  }

  const declared = Object.keys(simulator.handles).map(Number).sort((a, b) => a - b);
  const actual = entry.outputs.length;

  if (declared.length !== actual) {
    problems.push(`${ref} declares ${declared.length} handles (${declared.join(', ')}) but the `
      + `catalog says it has ${actual} outputs. Re-read `
      + `vendor/FlowPlugins/CommunityFlowPlugins/${entry.category}/${entry.name}/${entry.version}`
      + '/index.js and update the simulator.');
    continue;
  }

  const expected = Array.from({ length: actual }, (_, index) => index + 1);
  if (declared.join(',') !== expected.join(',')) {
    problems.push(`${ref} declares handles ${declared.join(', ')} but outputs are 1-based and `
      + `contiguous, so they should be ${expected.join(', ')}.`);
  }
}

if (problems.length) {
  console.error('simulators are out of step with the vendored plugins:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`${Object.keys(SIMULATORS).length} simulators match the catalog`);
