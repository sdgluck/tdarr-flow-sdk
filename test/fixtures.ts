/**
 * Builder-style fixtures. Constructing flow JSON by hand rather than through the
 * SDK's own builder is deliberate for lint tests: the builder rejects most of
 * what the linter is supposed to catch, so a test that went through it could
 * only ever assert the clean case.
 */

import type { FlowEdge, FlowJson, FlowNode } from '../src/types/flow.ts';

let sequence = 0;

export function node(
  id: string,
  pluginName: string,
  inputsDB: Record<string, string> = {},
  overrides: Partial<FlowNode> = {},
): FlowNode {
  const node: FlowNode = {
    id,
    name: overrides.name ?? id,
    sourceRepo: 'Community',
    pluginName,
    version: '1.0.0',
    fpEnabled: true,
    position: { x: 0, y: (sequence++) * 120 },
    ...overrides,
  };
  if (Object.keys(inputsDB).length) node.inputsDB = inputsDB;
  return node;
}

export function edge(source: string, sourceHandle: string | number, target: string): FlowEdge {
  return {
    id: `${source}-${sourceHandle}-${target}`,
    source,
    sourceHandle: String(sourceHandle),
    target,
    targetHandle: null,
  };
}

export function makeFlow(nodes: FlowNode[], edges: FlowEdge[], name = 'Test Flow'): FlowJson {
  return { _id: 'test00000', name, flowPlugins: nodes, flowEdges: edges };
}
