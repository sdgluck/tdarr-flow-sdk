import type { LintContext } from '../context.ts';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  nodeId?: string;
  nodeName?: string;
  /**
   * The output this finding is about (`"1"`, `"err1"`), when it is about one.
   *
   * Node ids are hashed from the flow, so they change whenever anything upstream
   * does. A decision that has to outlive an edit - accepting a dead end as
   * deliberate, say - keys on the plugin and handle instead, and this is the
   * part of that key only the rule can supply.
   */
  handle?: string;
  /** The plugin that produced the node, so a fix can identify it stably. */
  pluginName?: string;
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
