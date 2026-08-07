/**
 * Reading an existing flow back into something the wizard can edit.
 *
 * Two paths. If the flow carries an embedded spec - because this SDK generated
 * it with `compileSpec(spec, { embed: true })` - recovery is exact: the spec is
 * decoded, recompiled, and checked against the flow it came from. Otherwise the
 * matchers guess structurally, which is genuinely a guess.
 *
 * Whichever path runs, nothing is discarded. Nodes no matcher claimed become
 * frozen `ExtraNode`s carrying their original position and edges, so recompiling
 * an imported flow reproduces the parts we did not understand rather than
 * silently deleting them. That property is what makes shallow matchers an
 * acceptable design instead of a liability.
 */

import { lint } from '../lint/index.ts';
import type { LintFinding, LintOptions } from '../lint/index.ts';
import { compileSpec, migrateSpec } from '../recipes/compileSpec.ts';
import { extractSpec } from '../graph/serialize.ts';
import type { FlowJson, FlowNode } from '../types/flow.ts';
import type { ExtraNode, FlowSpec } from '../types/spec.ts';
import { isomorphic } from './isomorphic.ts';
import { runMatchers } from './matchers.ts';
import type { Match } from './matchers.ts';
import { Walk } from './walk.ts';

export interface ImportResult {
  /** The flow exactly as given, never a rewritten version of it. */
  flow: FlowJson;
  /** Null when nothing anchored, which means raw editing only. */
  spec: FlowSpec | null;
  source: 'embedded' | 'recognised' | 'none';
  recognised: Match[];
  /** Nodes no matcher claimed. Also present in `spec.extras`, frozen. */
  unrecognised: FlowNode[];
  lint: LintFinding[];
  /**
   * Set when an embedded spec was found but did not recompile to the flow it
   * was attached to - meaning someone edited the flow in Tdarr afterwards. The
   * structural path is used instead, and this explains why.
   */
  embeddedMismatch?: string;
}

export interface ImportOptions {
  lint?: LintOptions;
}

function isFlowJson(value: unknown): value is FlowJson {
  return Boolean(value)
    && typeof value === 'object'
    && Array.isArray((value as FlowJson).flowPlugins)
    && Array.isArray((value as FlowJson).flowEdges);
}

/** Preserve an unclaimed node verbatim, with everything wired to or from it. */
function freeze(node: FlowNode, flow: FlowJson): ExtraNode {
  return {
    id: node.id,
    pluginName: node.pluginName,
    version: node.version,
    sourceRepo: node.sourceRepo === 'Local' ? 'Local' : 'Community',
    ...(node.name ? { name: node.name } : {}),
    inputs: node.inputsDB ?? {},
    anchor: 'beforeOutput',
    frozen: {
      position: node.position,
      edges: (flow.flowEdges ?? []).filter((e) => e.source === node.id || e.target === node.id),
    },
  };
}

export function importFlow(input: unknown, options: ImportOptions = {}): ImportResult {
  const flow = typeof input === 'string' ? JSON.parse(input) : input;

  if (!isFlowJson(flow)) {
    throw new Error(
      'not a Tdarr flow: expected an object with flowPlugins[] and flowEdges[]. Export a flow '
        + 'from Tdarr\'s flow editor, or paste the contents of a flow JSON file.',
    );
  }

  const findings = lint(flow, options.lint);

  const embedded = extractSpec(flow.description);
  if (embedded) {
    try {
      const spec = migrateSpec(embedded.spec);
      if (isomorphic(compileSpec(spec, { embed: true }), flow)) {
        return {
          flow,
          spec,
          source: 'embedded',
          recognised: [],
          unrecognised: [],
          lint: findings,
        };
      }
      return {
        ...structural(flow, options),
        lint: findings,
        embeddedMismatch: 'the flow carries an embedded spec, but has been edited since - '
          + 'falling back to structural recognition',
      };
    } catch (error) {
      return {
        ...structural(flow, options),
        lint: findings,
        embeddedMismatch: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ...structural(flow, options), lint: findings };
}

function structural(flow: FlowJson, _options: ImportOptions): Omit<ImportResult, 'lint'> {
  const walk = new Walk(flow);
  const { spec, matches } = runMatchers(walk, flow.name || 'Imported Flow');

  spec.meta = {
    name: flow.name || 'Imported Flow',
    ...(flow.description ? { description: flow.description } : {}),
    ...(flow.tags ? { tags: flow.tags } : {}),
    ...(flow.priority !== undefined ? { priority: flow.priority } : {}),
    ...(flow._id ? { flowId: flow._id } : {}),
  };

  const unrecognised = walk.unclaimed();
  spec.extras = unrecognised.map((node) => freeze(node, flow));

  // Hand-arranged flows are arranged for a reason; recompiling should not
  // flatten them.
  spec.policy = {
    ...spec.policy,
    layout: {
      preserve: Object.fromEntries(flow.flowPlugins.map((n) => [n.id, n.position])),
    },
  };

  return {
    flow,
    spec: matches.length ? spec : null,
    source: matches.length ? 'recognised' : 'none',
    recognised: matches,
    unrecognised,
  };
}

export { isomorphic, difference } from './isomorphic.ts';
export { Walk } from './walk.ts';
export type { Match, MatchResult } from './matchers.ts';
