/**
 * The internal graph model to and from the JSON Tdarr stores.
 *
 * Also owns the embedded-spec marker. A flow the wizard generated can carry its
 * own `FlowSpec` in `description`, which turns re-import from a fuzzy structural
 * guess into an exact recovery. It is a comment so Tdarr renders the description
 * normally, and it is the last thing in the string so a user editing the text
 * above it does not disturb it.
 */

import type { FlowEdge, FlowJson, FlowNode } from '../types/flow.ts';
import type { FlowOptions, GraphModel, PlacedNode } from './builder.ts';
import { serializeHandle } from './handles.ts';
import { edgeId, hashId } from './ids.ts';
import { layout } from './layout.ts';

export const SPEC_MARKER = 'tdarr-flow-creator';
const MARKER_PATTERN = new RegExp(`\\n?<!--${SPEC_MARKER}:v(\\d+):([A-Za-z0-9_-]+)-->`);

export function toFlowJson(model: GraphModel, options: FlowOptions = {}): FlowJson {
  const positions = layout(
    model.nodes.map((n) => ({ id: n.id, offSpine: n.offSpine })),
    model.edges,
    options.layout,
  );

  const flowPlugins: FlowNode[] = model.nodes.map((n) => {
    const node: FlowNode = {
      name: n.name,
      sourceRepo: n.sourceRepo,
      pluginName: n.pluginName,
      version: n.version,
      fpEnabled: n.fpEnabled,
      id: n.id,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
    };
    // Tdarr omits the key entirely when a node has no configuration; matching
    // that keeps diffs against an exported flow clean.
    if (Object.keys(n.inputsDB).length) node.inputsDB = n.inputsDB;
    return node;
  });

  const flowEdges: FlowEdge[] = model.edges.map((e, index) => ({
    id: edgeId(index),
    source: e.source,
    sourceHandle: serializeHandle(e.sourceHandle),
    target: e.target,
    targetHandle: null,
  }));

  const flow: FlowJson = {
    _id: options.id ?? hashId(model.name),
    name: model.name,
    flowPlugins,
    flowEdges,
  };
  if (options.priority !== undefined) flow.priority = options.priority;
  if (options.description !== undefined) flow.description = options.description;
  if (options.tags !== undefined) flow.tags = options.tags;
  if (options.isUiLocked !== undefined) flow.isUiLocked = options.isUiLocked;
  return flow;
}

/**
 * Reads a flow back into the internal model. Shapes are not resolved here - the
 * caller supplies a resolver, because an imported flow may reference Local
 * plugins the catalog knows nothing about.
 */
export function fromFlowJson(
  json: FlowJson,
  resolveShape: (node: FlowNode) => PlacedNode['shape'],
): GraphModel {
  const nodes: PlacedNode[] = (json.flowPlugins ?? []).map((n) => ({
    id: n.id,
    ref: `${n.pluginName}@${n.version}`,
    pluginName: n.pluginName,
    version: n.version,
    sourceRepo: (n.sourceRepo === 'Local' ? 'Local' : 'Community'),
    name: n.name,
    fpEnabled: n.fpEnabled,
    inputsDB: n.inputsDB ?? {},
    shape: resolveShape(n),
    offSpine: false,
  }));

  const edges = (json.flowEdges ?? []).map((e) => ({
    source: e.source,
    sourceHandle: (e.sourceHandle === 'err1' ? 'err1' : Number(e.sourceHandle)) as
      | number
      | 'err1',
    target: e.target,
  }));

  return { name: json.name, nodes, edges };
}

// --- embedded spec marker ---------------------------------------------------

/** base64url over UTF-8, without depending on Buffer (this runs in browsers). */
function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (encoded.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function embedSpec(
  description: string | undefined,
  spec: unknown,
  version: number,
): string {
  const base = stripSpec(description ?? '');
  const marker = `<!--${SPEC_MARKER}:v${version}:${encodeBase64Url(JSON.stringify(spec))}-->`;
  return base ? `${base}\n${marker}` : marker;
}

export function stripSpec(description: string | undefined): string {
  return (description ?? '').replace(MARKER_PATTERN, '').trimEnd();
}

export interface ExtractedSpec {
  version: number;
  spec: unknown;
}

export function extractSpec(description: string | undefined): ExtractedSpec | null {
  const match = MARKER_PATTERN.exec(description ?? '');
  if (!match) return null;
  try {
    return { version: Number(match[1]), spec: JSON.parse(decodeBase64Url(match[2]!)) };
  } catch {
    // A corrupted marker is not fatal: recognition falls back to the structural
    // path, which is exactly what happens for a flow that never had one.
    return null;
  }
}
