import type { LintFinding, LintRule } from './types.ts';

/**
 * An output with nothing attached. The flow simply stops there - the file is
 * left as-is and the job reports success, which is the failure mode hardest to
 * notice after the fact.
 *
 * A warning, not an error: deliberately ending a branch is legitimate, and on a
 * terminal node having nowhere to go is the entire point.
 */
export const unwiredHandle: LintRule = {
  id: 'unwired-handle',
  describe: 'every numbered output leads somewhere',
  check(context) {
    const findings: LintFinding[] = [];

    for (const node of context.nodes) {
      const shape = context.shapeOf(node);
      // `flowEnding` nodes declare an output but ending there is the normal
      // case, so an unwired handle is not a dead end.
      if (!shape || shape.terminal || shape.flowEnding) continue;

      const used = context.usedHandles(node.id);
      for (let index = 1; index <= shape.outputs; index++) {
        if (used.includes(String(index))) continue;
        findings.push({
          rule: 'unwired-handle',
          severity: 'warning',
          nodeId: node.id,
          nodeName: node.name,
          pluginName: node.pluginName,
          handle: String(index),
          assumed: shape.confidence === 'assumed' || shape.confidence === 'unknown',
          message: `${node.name} handle ${index} has no outgoing edge; a file leaving by it `
            + 'dead-ends',
        });
      }
    }

    return findings;
  },
};
