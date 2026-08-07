import { ERROR_HANDLE } from '../context.ts';
import type { LintFinding, LintRule } from './types.ts';

/**
 * A node that can fail with nothing wired to its error handle: the failure takes
 * down the whole job rather than being handled.
 *
 * Which plugins can fail is hand-curated (see catalog/overrides.ts), and for
 * about a dozen of them it is an educated guess. Those findings carry
 * `assumed: true` so a reader can weigh them accordingly - and so the wizard
 * never silently auto-wires an error path on the strength of a guess.
 */
export const missingErrorEdge: LintRule = {
  id: 'missing-error-edge',
  describe: 'a node that can fail has its error handle wired',
  check(context) {
    const findings: LintFinding[] = [];

    for (const node of context.nodes) {
      const shape = context.shapeOf(node);
      if (!shape?.error) continue;
      if (context.usedHandles(node.id).includes(ERROR_HANDLE)) continue;

      findings.push({
        rule: 'missing-error-edge',
        severity: 'warning',
        nodeId: node.id,
        nodeName: node.name,
        assumed: shape.confidence === 'assumed',
        message: `${node.name} can fail but has no error edge, so a failure fails the whole job`,
      });
    }

    return findings;
  },
};
