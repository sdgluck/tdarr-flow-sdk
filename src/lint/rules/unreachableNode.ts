import type { LintRule } from './types.ts';

/**
 * A node no file can ever arrive at. Usually the remains of a rewired branch -
 * it still looks configured and correct on the canvas, which is exactly why it
 * is worth pointing at.
 */
export const unreachableNode: LintRule = {
  id: 'unreachable-node',
  describe: 'every node is walkable from the entry node',
  check(context) {
    // With no single entry the walk has no defined starting point, and
    // `entry-node` has already reported the real problem.
    if (context.entries().length !== 1) return [];

    const reached = context.reachable();
    return context.nodes.filter((node) => !reached.has(node.id)).map((node) => ({
      rule: 'unreachable-node',
      severity: 'error' as const,
      nodeId: node.id,
      nodeName: node.name,
      message: `${node.name} is not reachable from the entry node`,
    }));
  },
};
