import type { LintRule } from './types.ts';

/**
 * Tdarr enters a flow at the node nothing points to. Two of them means half the
 * flow silently never runs; none means the graph is a cycle and nothing does.
 */
export const entryNode: LintRule = {
  id: 'entry-node',
  describe: 'a flow has exactly one node with no incoming edge',
  check(context) {
    const entries = context.entries();
    if (entries.length === 1) return [];

    return [{
      rule: 'entry-node',
      severity: 'error',
      message: `expected exactly 1 entry node, found ${entries.length}`
        + (entries.length ? `: ${entries.map((n) => n.name).join(', ')}` : ''),
    }];
  },
};
