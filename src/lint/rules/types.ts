import type { LintContext } from '../context.ts';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  nodeId?: string;
  nodeName?: string;
  message: string;
  /** The finding rests on an assumed shape rather than a catalogued one. */
  assumed?: boolean;
}

export interface LintRule {
  id: string;
  /** One line, shown by tooling that lists the rules. */
  describe: string;
  check(context: LintContext): LintFinding[];
}
