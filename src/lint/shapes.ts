/**
 * How the linter learns what a node's handles are.
 *
 * A *function* rather than a lookup table, deliberately. The web app has to
 * splice in shapes for Local plugins the catalog has never seen; the
 * tdarr-flow-test harness has its own simulation registry and needs to bridge
 * that in without duplicating a single rule. Both are a one-line adapter against
 * this signature.
 */

import { getPluginByRef, latestVersion } from '../catalog/index.ts';
import type { Shape } from '../graph/handles.ts';
import type { FlowNode } from '../types/flow.ts';

export type NodeShape = Shape;

export type ShapeResolver = (
  node: Pick<FlowNode, 'pluginName' | 'version' | 'sourceRepo'>,
) => NodeShape | undefined;

/**
 * Resolves against the generated catalog, exact version first.
 *
 * Falling back to the newest version when the exact one is missing is a
 * judgement call: it is usually right, and reporting nothing at all would be
 * worse. But the result is downgraded to `assumed` so findings derived from it
 * are visibly less trustworthy than ones from a real manifest.
 */
export function catalogShapes(extra: Record<string, NodeShape> = {}): ShapeResolver {
  return ({ pluginName, version }) => {
    const exact = `${pluginName}@${version}`;
    if (extra[exact]) return extra[exact];
    if (extra[pluginName]) return extra[pluginName];

    const entry = getPluginByRef(exact);
    if (entry) {
      return {
        outputs: entry.outputs.length,
        error: entry.error,
        terminal: entry.terminal,
        flowEnding: entry.flowEnding,
        confidence: entry.error && entry.errorConfidence === 'assumed' ? 'assumed' : 'catalog',
      };
    }

    const newest = latestVersion(pluginName);
    if (!newest) return undefined;

    const fallback = getPluginByRef(`${pluginName}@${newest}`)!;
    return {
      outputs: fallback.outputs.length,
      error: fallback.error,
      terminal: fallback.terminal,
      flowEnding: fallback.flowEnding,
      confidence: 'assumed',
      note: `${pluginName}@${version} is not catalogued; using ${newest}, whose shape may differ`,
    };
  };
}
