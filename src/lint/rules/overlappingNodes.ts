import type { LintFinding, LintRule } from './types.ts';

/**
 * Two nodes at identical coordinates. Purely cosmetic in effect, but it hides a
 * node completely in the editor, which makes the flow impossible to review.
 *
 * Generated flows satisfy this by construction - the layout assigns each rank's
 * nodes distinct columns - so a finding here means a hand-edited or imported
 * flow.
 */
export const overlappingNodes: LintRule = {
  id: 'overlapping-nodes',
  describe: 'no two nodes sit at exactly the same position',
  check(context) {
    const findings: LintFinding[] = [];
    const seen = new Map<string, string>();

    for (const node of context.nodes) {
      const key = `${node.position?.x ?? 0},${node.position?.y ?? 0}`;
      const other = seen.get(key);
      if (other) {
        findings.push({
          rule: 'overlapping-nodes',
          severity: 'warning',
          nodeId: node.id,
          nodeName: node.name,
          pluginName: node.pluginName,
          message: `${node.name} sits exactly on top of ${other} at (${key})`,
        });
      } else {
        seen.set(key, node.name);
      }
    }

    return findings;
  },
};
