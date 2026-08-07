import type { LintRule } from './types.ts';

/**
 * A node whose shape nothing could resolve, so every handle check above skipped
 * it. Normal for Local flow plugins - the fix is to declare the shape via
 * `localNode()` or the resolver's `extra` map, not to silence the rule.
 */
export const uncataloguedPlugin: LintRule = {
  id: 'uncatalogued-plugin',
  describe: 'every node\'s handles can be checked against a known shape',
  check(context) {
    return context.nodes.filter((node) => !context.shapeOf(node)).map((node) => ({
      rule: 'uncatalogued-plugin',
      severity: 'warning' as const,
      nodeId: node.id,
      nodeName: node.name,
      message: `${node.pluginName}@${node.version} is not in the catalog, so its handles cannot `
        + 'be checked. Declare its shape with localNode() or catalogShapes({ ... }).',
    }));
  },
};
