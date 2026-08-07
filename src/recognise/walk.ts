/**
 * Shared traversal helpers for the matchers.
 *
 * All the matchers need the same few things - what a node points at on a given
 * handle, what points at it, and a way to claim nodes so two matchers do not
 * both take credit for the same one.
 */

import { decodeInputs } from '../graph/inputs.ts';
import type { FlowJson, FlowNode } from '../types/flow.ts';

export class Walk {
  readonly nodes: readonly FlowNode[];
  readonly byId: ReadonlyMap<string, FlowNode>;

  #out = new Map<string, Array<{ handle: string; target: string }>>();
  #in = new Map<string, Array<{ handle: string; source: string }>>();
  #claimed = new Set<string>();

  constructor(flow: FlowJson) {
    this.nodes = flow.flowPlugins ?? [];
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));

    for (const edge of flow.flowEdges ?? []) {
      const handle = String(edge.sourceHandle);
      this.#out.set(edge.source, [
        ...(this.#out.get(edge.source) ?? []),
        { handle, target: edge.target },
      ]);
      this.#in.set(edge.target, [
        ...(this.#in.get(edge.target) ?? []),
        { handle, source: edge.source },
      ]);
    }
  }

  /** Nodes of a given plugin, newest-claimed excluded. */
  find(pluginName: string): FlowNode[] {
    return this.nodes.filter((n) => n.pluginName === pluginName && !this.#claimed.has(n.id));
  }

  first(pluginName: string): FlowNode | undefined {
    return this.find(pluginName)[0];
  }

  /** What a node points at on one handle. */
  targets(id: string, handle?: number | 'err1'): FlowNode[] {
    return (this.#out.get(id) ?? [])
      .filter((e) => handle === undefined || e.handle === String(handle))
      .map((e) => this.byId.get(e.target))
      .filter((n): n is FlowNode => n !== undefined);
  }

  target(id: string, handle: number | 'err1'): FlowNode | undefined {
    return this.targets(id, handle)[0];
  }

  sources(id: string): FlowNode[] {
    return (this.#in.get(id) ?? [])
      .map((e) => this.byId.get(e.source))
      .filter((n): n is FlowNode => n !== undefined);
  }

  /** Handles a node actually wires, so a matcher can tell a gate's branches apart. */
  handles(id: string): string[] {
    return (this.#out.get(id) ?? []).map((e) => e.handle);
  }

  inputs(node: FlowNode): Record<string, string | number | boolean> {
    return decodeInputs(`${node.pluginName}@${node.version}`, node.inputsDB);
  }

  /** Raw strings, for inputs the catalog cannot type (wrapper passthroughs). */
  raw(node: FlowNode): Record<string, string> {
    return node.inputsDB ?? {};
  }

  claim(...nodes: Array<FlowNode | undefined>): void {
    for (const node of nodes) if (node) this.#claimed.add(node.id);
  }

  isClaimed(node: FlowNode): boolean {
    return this.#claimed.has(node.id);
  }

  unclaimed(): FlowNode[] {
    return this.nodes.filter((n) => !this.#claimed.has(n.id));
  }

  /** Follow `err1 -> resetFlowError -> X` and return X, a very common idiom. */
  throughReset(node: FlowNode, handle: number | 'err1' = 'err1'): FlowNode | undefined {
    const next = this.target(node.id, handle);
    if (next?.pluginName === 'resetFlowError') return this.target(next.id, 1);
    return next;
  }
}
