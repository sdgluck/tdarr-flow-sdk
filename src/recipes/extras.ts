import { localNode, node } from '../graph/builder.ts';
import type { Cursor } from '../graph/builder.ts';
import { getPluginByRef } from '../catalog/index.ts';
import type { ExtraAnchor, ExtraNode } from '../types/spec.ts';
import { recipe } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * Nodes the wizard has no opinion about, spliced in at their anchor.
 *
 * These come from two places that behave identically once here: a plugin the
 * user picked from the full catalog, and a node an importer could not attribute
 * to any recipe. The second case is why this exists at all - dropping what we
 * failed to understand would make importing a flow actively destructive.
 */
export function extrasSegment(extras: readonly ExtraNode[], anchor: ExtraAnchor): Recipe {
  const mine = extras.filter((extra) => extra.anchor === anchor);

  return recipe('extras', { anchor, count: mine.length }, (entry) => {
    let cursor: Cursor = entry;
    for (const extra of mine) cursor = cursor.then(toNodeSpec(extra));
    return cursor;
  });
}

function toNodeSpec(extra: ExtraNode) {
  const ref = `${extra.pluginName}@${extra.version}`;
  const options = {
    id: extra.id,
    ...(extra.name ? { name: extra.name } : {}),
    sourceRepo: extra.sourceRepo,
  };

  // A catalogued plugin keeps its catalogued shape; anything else has to have
  // brought a declared one, or the linter can say nothing about it.
  if (getPluginByRef(ref) && extra.sourceRepo === 'Community') {
    return node(ref as never, extra.inputs as never, options);
  }

  return localNode({
    ...options,
    pluginName: extra.pluginName,
    version: extra.version,
    outputs: extra.shape?.outputs ?? 1,
    error: extra.shape?.error ?? false,
    terminal: extra.shape?.terminal ?? false,
    inputs: extra.inputs,
  });
}
