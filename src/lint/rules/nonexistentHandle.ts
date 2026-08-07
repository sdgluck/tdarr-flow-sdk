import { ERROR_HANDLE } from '../context.ts';
import type { LintFinding, LintRule } from './types.ts';

/**
 * The rule that motivates the whole catalog being version-keyed.
 *
 * An edge on a handle the plugin does not have looks exactly like a working one
 * in the editor - same line, same arrow - but no file can ever take it. And
 * whether a handle exists depends on the plugin *version*:
 * `compareFileSizeRatio` gained a third output at 2.0.0, so the same edge is
 * correct against one version and dead against the other.
 */
export const nonexistentHandle: LintRule = {
  id: 'nonexistent-handle',
  describe: 'every edge leaves by a handle its source plugin actually has',
  check(context) {
    const findings: LintFinding[] = [];

    for (const node of context.nodes) {
      const shape = context.shapeOf(node);
      if (!shape) continue;

      const assumed = shape.confidence === 'assumed' || shape.confidence === 'unknown';
      const used = context.usedHandles(node.id);

      for (const handle of used) {
        if (handle === ERROR_HANDLE) {
          if (!shape.error) {
            findings.push({
              rule: 'nonexistent-handle',
              severity: 'error',
              nodeId: node.id,
              nodeName: node.name,
              assumed,
              message: `${node.name} has an error edge, but ${node.pluginName}@${node.version} `
                + 'exposes no err1 handle',
            });
          }
          continue;
        }

        const index = Number(handle);
        if (!Number.isInteger(index) || index < 1 || index > shape.outputs) {
          findings.push({
            rule: 'nonexistent-handle',
            severity: 'error',
            nodeId: node.id,
            nodeName: node.name,
            assumed,
            message: `${node.name} has an edge on handle ${handle}, but `
              + `${node.pluginName}@${node.version} has ${shape.outputs} output(s). That edge can `
              + 'never be taken'
              + (assumed ? ' (shape is ASSUMED - confirm before acting)' : '') + '.',
          });
        }
      }
    }

    return findings;
  },
};
