/**
 * Structural checks that apply to any Tdarr flow.
 *
 * These catch the class of bug that is invisible in the editor: an edge wired to
 * a handle the plugin does not have looks identical to one that works, and a
 * node nothing can reach looks exactly like a node that runs.
 *
 * Browser-safe, so the web app lints on every keystroke against the same rules
 * the command-line harness uses.
 */

import type { FlowJson } from '../types/flow.ts';
import { buildContext } from './context.ts';
import { formatFindings } from './format.ts';
import { danglingEdge } from './rules/danglingEdge.ts';
import { entryNode } from './rules/entryNode.ts';
import { missingErrorEdge } from './rules/missingErrorEdge.ts';
import { mixedPluginVersions } from './rules/mixedPluginVersions.ts';
import { nonexistentHandle } from './rules/nonexistentHandle.ts';
import { overlappingNodes } from './rules/overlappingNodes.ts';
import { uncataloguedPlugin } from './rules/uncataloguedPlugin.ts';
import { unreachableNode } from './rules/unreachableNode.ts';
import { unwiredHandle } from './rules/unwiredHandle.ts';
import type { LintFinding, LintRule, LintSeverity } from './rules/types.ts';
import { catalogShapes } from './shapes.ts';
import type { NodeShape, ShapeResolver } from './shapes.ts';

export const rules: readonly LintRule[] = [
  entryNode,
  danglingEdge,
  unreachableNode,
  nonexistentHandle,
  unwiredHandle,
  missingErrorEdge,
  mixedPluginVersions,
  overlappingNodes,
  uncataloguedPlugin,
];

export interface LintOptions {
  /** Defaults to the generated catalog. */
  shapes?: ShapeResolver;
  /**
   * Rules to skip, optionally scoped to a node: `"missing-error-edge"` silences
   * the rule everywhere, `"missing-error-edge:audProped"` only on that node.
   * Prefer the scoped form and leave a comment - a blanket disable hides the
   * next instance too.
   */
  ignore?: string[];
  /** Report warnings as well as errors. Defaults to true. */
  includeWarnings?: boolean;
}

export function lint(flow: FlowJson, options: LintOptions = {}): LintFinding[] {
  const { shapes = catalogShapes(), ignore = [], includeWarnings = true } = options;
  const context = buildContext(flow, shapes);

  const silenced = (rule: string, nodeId?: string) =>
    ignore.includes(rule) || (nodeId !== undefined && ignore.includes(`${rule}:${nodeId}`));

  return rules
    .flatMap((rule) => rule.check(context))
    .filter((finding) =>
      !silenced(finding.rule, finding.nodeId)
      && (includeWarnings || finding.severity === 'error')
    );
}

/** Convenience for tests and CI: throws with every error-severity finding. */
export function assertNoLintErrors(flow: FlowJson, options: LintOptions = {}): void {
  const errors = lint(flow, options).filter((f) => f.severity === 'error');
  if (errors.length) throw new Error(`flow lint failed:\n${formatFindings(errors)}`);
}

export { applyFixes, findingKey, fixesFor, isAccepted, partitionFindings } from './fix.ts';
export type { FixContext, FixKind, FixOutcome, SpecFix } from './fix.ts';

export { buildContext, formatFindings, catalogShapes };
export type { LintContext } from './context.ts';
export type { LintFinding, LintRule, LintSeverity, NodeShape, ShapeResolver };
