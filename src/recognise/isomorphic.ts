/**
 * Structural comparison of two flows, ignoring node ids and positions.
 *
 * This is what makes the golden test meaningful. The SDK lays flows out by rank
 * and derives ids from content, so a generated flow will never match a
 * hand-arranged one byte for byte - but it can match it *as a graph*, and that
 * is the property worth asserting.
 *
 * The naive approach - sort nodes by plugin and inputs, then compare edges by
 * index - falls apart on this exact problem: the reference pipeline has three
 * identical `resetFlowError` nodes and three identical `Is MKV?` gates, and
 * sorting cannot tell them apart even though they sit in completely different
 * places. So nodes are distinguished by their *neighbourhood* instead, via
 * Weisfeiler-Leman colour refinement: every node starts coloured by its plugin
 * and inputs, and is then repeatedly recoloured by the colours of what it
 * connects to, until the colouring stops changing.
 *
 * WL is not a complete isomorphism test - there are graph families it cannot
 * separate - but they are highly regular constructions, and a Tdarr flow, with
 * its labelled nodes and labelled directed edges, is about as far from one as a
 * graph gets. Treat a `true` as "isomorphic as far as any practical test can
 * tell", and note that it never returns a false *negative*: two flows it calls
 * different really are different.
 */

import type { FlowJson } from '../types/flow.ts';

interface Adjacency {
  ids: string[];
  /** `[fromIndex, handle, toIndex]`, with unknown endpoints dropped. */
  edges: Array<[number, string, number]>;
  initial: string[];
}

function canonicalInputs(inputsDB: Record<string, string> | undefined): string {
  const entries = Object.entries(inputsDB ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function adjacencyOf(flow: FlowJson): Adjacency {
  const nodes = flow.flowPlugins ?? [];
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  const edges: Array<[number, string, number]> = [];
  for (const edge of flow.flowEdges ?? []) {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from === undefined || to === undefined) continue;
    edges.push([from, String(edge.sourceHandle), to]);
  }

  return {
    ids: nodes.map((n) => n.id),
    edges,
    initial: nodes.map((n) =>
      // `name` is excluded on purpose: it is a label, and two flows that differ
      // only in what the user called a node are the same flow.
      `${n.pluginName}@${n.version}|${n.sourceRepo}|${canonicalInputs(n.inputsDB)}`
    ),
  };
}

/**
 * Weisfeiler-Leman refinement. Returns each node's final colour, plus the
 * mapping used, so callers can report *which* node has no counterpart rather
 * than just that the flows differ.
 */
function refine(graph: Adjacency): string[] {
  let colours = [...graph.initial];

  for (let round = 0; round < graph.ids.length; round++) {
    const out: string[][] = graph.ids.map(() => []);
    const incoming: string[][] = graph.ids.map(() => []);

    for (const [from, handle, to] of graph.edges) {
      out[from]!.push(`${handle}>${colours[to]}`);
      incoming[to]!.push(`${handle}<${colours[from]}`);
    }

    const next = colours.map((colour, i) =>
      `${colour}#{${out[i]!.slice().sort().join(',')}}{${incoming[i]!.slice().sort().join(',')}}`
    );

    // Compress to keep colour strings from growing exponentially across rounds.
    //
    // Numbered by sorted colour *content*, never by order of appearance: the
    // whole point is to compare two graphs, and a palette keyed on iteration
    // order assigns the same label to different colours in each of them. That
    // makes a flow compare unequal to a copy of itself with the node array
    // reversed - which is exactly what importing and re-exporting does.
    const palette = new Map([...new Set(next)].sort().map((colour, i) => [colour, `c${i}`]));
    const compressed = next.map((colour) => palette.get(colour)!);

    // Fixpoint: the partition stopped getting finer, so more rounds cannot help.
    if (new Set(compressed).size === new Set(colours).size) break;
    colours = compressed;
  }

  return colours;
}

const multiset = (values: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([v, n]) => `${v}x${n}`);
};

export interface Difference {
  kind: 'node-count' | 'edge-count' | 'nodes' | 'edges';
  message: string;
}

/** The reason two flows differ, or `null` when they match. */
export function difference(a: FlowJson, b: FlowJson): Difference | null {
  const left = adjacencyOf(a);
  const right = adjacencyOf(b);

  if (left.ids.length !== right.ids.length) {
    return {
      kind: 'node-count',
      message: `${left.ids.length} nodes vs ${right.ids.length}`,
    };
  }
  if (left.edges.length !== right.edges.length) {
    return {
      kind: 'edge-count',
      message: `${left.edges.length} edges vs ${right.edges.length}`,
    };
  }

  // Compare on the initial colouring first: when the flows really do differ,
  // "there is no `checkFileMedium` on the right" is a far more useful message
  // than a mismatch between two refined colour hashes.
  const leftInitial = multiset(left.initial);
  const rightInitial = multiset(right.initial);
  if (JSON.stringify(leftInitial) !== JSON.stringify(rightInitial)) {
    const onlyLeft = leftInitial.filter((v) => !rightInitial.includes(v));
    const onlyRight = rightInitial.filter((v) => !leftInitial.includes(v));
    return {
      kind: 'nodes',
      message: 'node sets differ\n'
        + onlyLeft.map((v) => `  only in first:  ${v}`).join('\n')
        + (onlyLeft.length && onlyRight.length ? '\n' : '')
        + onlyRight.map((v) => `  only in second: ${v}`).join('\n'),
    };
  }

  const leftColours = refine(left);
  const rightColours = refine(right);
  if (JSON.stringify(multiset(leftColours)) !== JSON.stringify(multiset(rightColours))) {
    return {
      kind: 'edges',
      message: 'same nodes, but wired differently',
    };
  }

  const edgeSet = (graph: Adjacency, colours: string[]) =>
    multiset(graph.edges.map(([from, handle, to]) => `${colours[from]}-[${handle}]->${colours[to]}`));

  if (JSON.stringify(edgeSet(left, leftColours)) !== JSON.stringify(edgeSet(right, rightColours))) {
    return { kind: 'edges', message: 'same nodes, but wired differently' };
  }

  return null;
}

/** True when the two flows are the same graph, ignoring ids, names and layout. */
export function isomorphic(a: FlowJson, b: FlowJson): boolean {
  return difference(a, b) === null;
}
