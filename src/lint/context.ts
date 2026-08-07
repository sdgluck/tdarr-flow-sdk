/**
 * The indexes every rule shares, built once per lint run.
 *
 * This is a browser-safe re-implementation of the adjacency work
 * tdarr-flow-test's `Flow` class does. It reads `FlowJson` straight off the wire
 * rather than requiring a constructed object, because the app lints a flow it
 * just compiled and a flow the user just pasted, and neither should need a
 * wrapper first.
 */

import type { FlowEdge, FlowJson, FlowNode } from '../types/flow.ts';
import type { NodeShape, ShapeResolver } from './shapes.ts';

export const ERROR_HANDLE = 'err1';

export interface LintContext {
  flow: FlowJson;
  nodes: readonly FlowNode[];
  edges: readonly FlowEdge[];
  byId: ReadonlyMap<string, FlowNode>;
  shapeOf(node: FlowNode): NodeShape | undefined;
  /** Outgoing handles actually wired on a node, as strings (`"1"`, `"err1"`). */
  usedHandles(nodeId: string): readonly string[];
  /** Nodes with no incoming edge - a well-formed flow has exactly one. */
  entries(): readonly FlowNode[];
  /** Everything walkable from the entry, error edges included. */
  reachable(): ReadonlySet<string>;
}

export function buildContext(flow: FlowJson, resolve: ShapeResolver): LintContext {
  const nodes = flow.flowPlugins ?? [];
  const edges = flow.flowEdges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const handlesBySource = new Map<string, string[]>();
  const targetsBySource = new Map<string, string[]>();
  const hasIncoming = new Set<string>();

  for (const edge of edges) {
    const handle = edge.sourceHandle === null ? '' : String(edge.sourceHandle);
    handlesBySource.set(edge.source, [...(handlesBySource.get(edge.source) ?? []), handle]);
    targetsBySource.set(edge.source, [...(targetsBySource.get(edge.source) ?? []), edge.target]);
    hasIncoming.add(edge.target);
  }

  const shapes = new Map<string, NodeShape | undefined>();

  let reached: Set<string> | undefined;

  return {
    flow,
    nodes,
    edges,
    byId,

    shapeOf(node) {
      const key = `${node.pluginName}@${node.version}`;
      if (!shapes.has(key)) shapes.set(key, resolve(node));
      return shapes.get(key);
    },

    usedHandles(nodeId) {
      return handlesBySource.get(nodeId) ?? [];
    },

    entries() {
      return nodes.filter((n) => !hasIncoming.has(n.id));
    },

    reachable() {
      if (reached) return reached;
      reached = new Set<string>();
      const roots = nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
      const queue = roots.length ? roots : nodes.slice(0, 1).map((n) => n.id);

      while (queue.length) {
        const id = queue.pop()!;
        if (reached.has(id) || !byId.has(id)) continue;
        reached.add(id);
        queue.push(...(targetsBySource.get(id) ?? []));
      }
      return reached;
    },
  };
}
