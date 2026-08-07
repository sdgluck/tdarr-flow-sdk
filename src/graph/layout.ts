/**
 * Deterministic layered layout.
 *
 * Tdarr flows read top to bottom, so the job is to assign each node a rank (its
 * row) and an order within that rank (its column), then multiply out to pixels.
 *
 * Deliberately not doing: crossing minimisation, node-size-aware packing, or
 * anything iterative. A 40-node flow does not need it, and every iterative
 * heuristic makes the output harder to predict - which matters more here than
 * prettiness, because the golden test and the app's diff view both depend on the
 * same spec producing the same coordinates every time. When the automatic result
 * is not good enough the answer is `preserve`, not a cleverer algorithm.
 */

export interface LayoutNode {
  id: string;
  /** Nudged off the main spine, so error handlers do not sit in the flow's path. */
  offSpine?: boolean;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  /** Column pitch. Default matches the reference pipeline's spacing. */
  xGap?: number;
  /** Row pitch. */
  yGap?: number;
  origin?: { x: number; y: number };
  /** All coordinates snap to this, as Tdarr's own editor does. */
  grid?: number;
  /** Nodes whose position is kept verbatim - imported, hand-arranged flows. */
  preserve?: Record<string, { x: number; y: number }>;
}

export interface Position {
  x: number;
  y: number;
}

const DEFAULTS = {
  xGap: 240,
  yGap: 120,
  origin: { x: 600, y: 0 },
  grid: 12,
} as const;

const snap = (value: number, grid: number) => Math.round(value / grid) * grid;

/**
 * Edges that point back into a node already on the DFS stack. Excluded from
 * ranking only - they still get drawn. Retry loops (encode fails -> reset error
 * -> re-enter) create these, and without removing them the longest-path rank
 * below would not terminate.
 */
function findBackEdges(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Set<number> {
  const out = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const list = out.get(edge.source) ?? [];
    list.push(index);
    out.set(edge.source, list);
  });

  const back = new Set<number>();
  const state = new Map<string, 'open' | 'done'>();

  const visit = (id: string) => {
    state.set(id, 'open');
    for (const index of out.get(id) ?? []) {
      const target = edges[index]!.target;
      const seen = state.get(target);
      if (seen === 'open') back.add(index);
      else if (seen === undefined) visit(target);
    }
    state.set(id, 'done');
  };

  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  return back;
}

export function layout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): Map<string, Position> {
  const xGap = options.xGap ?? DEFAULTS.xGap;
  const yGap = options.yGap ?? DEFAULTS.yGap;
  const grid = options.grid ?? DEFAULTS.grid;
  const origin = options.origin ?? DEFAULTS.origin;
  const preserve = options.preserve ?? {};

  const known = new Set(nodes.map((n) => n.id));
  const backEdges = findBackEdges(nodes, edges);
  const forward = edges.filter((_, i) =>
    !backEdges.has(i) && known.has(edges[i]!.source) && known.has(edges[i]!.target)
  );

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const { source, target } of forward) {
    incoming.set(target, [...(incoming.get(target) ?? []), source]);
    outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
  }

  // Rank by longest path from a root, so a node always sits below every one of
  // its predecessors. (BFS distance would not: a node reachable in one hop and
  // in four would land next to its earliest parent and above its latest.)
  const rank = new Map<string, number>();
  const resolve = (id: string, stack: Set<string>): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (stack.has(id)) return 0;

    stack.add(id);
    const parents = incoming.get(id) ?? [];
    const depth = parents.length ? Math.max(...parents.map((p) => resolve(p, stack) + 1)) : 0;
    stack.delete(id);

    rank.set(id, depth);
    return depth;
  };
  for (const node of nodes) resolve(node.id, new Set());

  // Order within a rank: one downward sweep, each node pulled towards the mean
  // column of its predecessors, ties broken by insertion order.
  const order = new Map<string, number>();
  const ranks = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const depth = rank.get(node.id) ?? 0;
    ranks.set(depth, [...(ranks.get(depth) ?? []), node]);
  }

  const positions = new Map<string, Position>();
  const insertion = new Map(nodes.map((n, i) => [n.id, i]));

  for (const depth of [...ranks.keys()].sort((a, b) => a - b)) {
    const row = ranks.get(depth)!;
    const pull = (node: LayoutNode) => {
      const parents = (incoming.get(node.id) ?? [])
        .map((p) => order.get(p))
        .filter((v): v is number => v !== undefined);
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : Infinity;
    };

    row.sort((a, b) => {
      const byPull = pull(a) - pull(b);
      if (byPull !== 0 && Number.isFinite(byPull)) return byPull;
      return insertion.get(a.id)! - insertion.get(b.id)!;
    });

    row.forEach((node, index) => {
      order.set(node.id, index);
      const offset = index - (row.length - 1) / 2;
      positions.set(node.id, {
        x: snap(origin.x + offset * xGap + (node.offSpine ? xGap / 2 : 0), grid),
        y: snap(origin.y + depth * yGap, grid),
      });
    });
  }

  for (const [id, position] of Object.entries(preserve)) {
    if (known.has(id)) positions.set(id, position);
  }

  return positions;
}
