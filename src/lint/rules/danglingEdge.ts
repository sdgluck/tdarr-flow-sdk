import type { LintFinding, LintRule } from './types.ts';

/**
 * An edge referencing a node that is not in the document. Deleting a node in the
 * editor can leave these behind, and they are invisible on the canvas because
 * there is nothing to draw them between.
 */
export const danglingEdge: LintRule = {
  id: 'dangling-edge',
  describe: 'every edge connects two nodes that exist',
  check(context) {
    const findings: LintFinding[] = [];

    for (const edge of context.edges) {
      if (!context.byId.has(edge.source)) {
        findings.push({
          rule: 'dangling-edge',
          severity: 'error',
          message: `edge ${edge.id} starts at unknown node ${edge.source}`,
        });
      }
      if (!context.byId.has(edge.target)) {
        findings.push({
          rule: 'dangling-edge',
          severity: 'error',
          message: `edge ${edge.id} points at unknown node ${edge.target}`,
        });
      }
    }

    return findings;
  },
};
