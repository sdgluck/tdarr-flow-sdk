import * as plugins from '../catalog/factories.generated.ts';
import type { Cursor } from '../graph/builder.ts';
import type { SourceStep } from '../types/spec.ts';
import { recipe } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * The entry gates: which files this flow is willing to touch at all.
 *
 * Each gate is omitted rather than added-and-always-passed when it is not
 * wanted. A node that always takes handle 1 is not free - it is one more thing
 * to read in the editor, and one more place for a future edit to go wrong.
 *
 * The unmatched handles are deliberately left dangling: a file that is not a
 * video should stop, and stopping is what an unwired handle does. That produces
 * an `unwired-handle` warning, which is the correct signal - it is a decision
 * worth seeing, not an error.
 */
export function sourceFile(step: SourceStep): Recipe {
  return recipe('sourceFile', step, (entry) => {
    let cursor: Cursor = entry;

    if (step.requireMedium !== 'any') {
      const gate = cursor.then(plugins.checkFileMedium({}, {
        name: step.requireMedium === 'video' ? 'Readable Video?' : 'Readable Audio?',
      }));
      // checkFileMedium: 1 = video, 2 = audio, 3 = other.
      cursor = gate.at(step.requireMedium === 'video' ? 1 : 2);
    }

    if (step.extensions.mode !== 'any' && step.extensions.list.length) {
      const gate = cursor.then(plugins.checkFileExtension(
        { extensions: step.extensions.list.join(',') },
        { name: `${step.extensions.mode === 'include' ? 'Wanted' : 'Unwanted'} extension?` },
      ));
      cursor = gate.at(step.extensions.mode === 'include' ? 1 : 2);
    }

    if (step.minSizeMb > 0) {
      const gate = cursor.then(plugins.checkFileSize(
        { unit: 'MB', greaterThan: step.minSizeMb, lessThan: 1_000_000 },
        { name: `Larger than ${step.minSizeMb}MB?` },
      ));
      cursor = gate.at(1);
    }

    return cursor;
  });
}
