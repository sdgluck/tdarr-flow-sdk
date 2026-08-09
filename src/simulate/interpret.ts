/**
 * Walking one file through a compiled flow.
 *
 * The alternative was to re-read `FlowSpec` and hand-write the comparisons -
 * "if `spec.video.skipIfAlreadyTarget`, does the codec match" - and it was
 * rejected. That knowledge exists today only as literals inside `recipes/*.ts`,
 * so a second copy drifts the moment a recipe changes, and silently: both halves
 * still compile and the numbers just quietly stop describing the flow. It would
 * also be blind to `spec.extras` and to imported flows, which are exactly the
 * cases where a user most wants to know what they built.
 *
 * Interpreting the compiled graph has neither problem. Whatever the recipes emit
 * is what gets walked, and a plugin the user added by hand is just another node.
 *
 * # Verdicts
 *
 * Two rules do the real work, and both exist because the obvious reading is
 * wrong:
 *
 *  - **A revert undoes an action.** `execute -> compareFileSizeRatio(3) ->
 *    setOriginalFile -> replaceOriginalFile` commits the *original* file. The
 *    library is unchanged, so the verdict is `untouched`.
 *
 *  - **An unknowable node reached after an action still means `modifies`.** By
 *    then the file has already been picked up and encoded; the size guard
 *    decides whether the result is *kept*, not whether the work *happens*. It
 *    sets `retentionUncertain` instead, so the report can say "12,400 files, of
 *    which 9,200 depend on the encode result" rather than shrugging at all of
 *    them. Reached *before* any action, the same node genuinely does make the
 *    outcome unknown, and the verdict is `indeterminate`.
 */

import { Walk } from '../recognise/walk.ts';
import type { FlowJson, FlowNode } from '../types/flow.ts';
import { isAction, isRevert } from './actions.ts';
import { simulatorFor } from './plugins.ts';
import type { InputValue, Simulator } from './plugins.ts';
import type { MediaRecord } from './record.ts';

export type Verdict = 'modifies' | 'untouched' | 'rejected' | 'indeterminate';

export interface Branch {
  nodeId: string;
  ref: string;
  name: string;
  handle: number;
}

export type Stop =
  /** Ran out of graph: a flow-ending node, or one with nothing wired onward. */
  | { kind: 'terminal'; nodeId: string }
  /** A gate chose a handle with no edge on it - usually a deliberate dead end. */
  | { kind: 'unwired'; nodeId: string; handle: number }
  | { kind: 'unknowable'; nodeId: string; ref: string; reason: string }
  | { kind: 'unmodelled'; nodeId: string; ref: string }
  | { kind: 'threw'; nodeId: string; ref: string; reason: string }
  | { kind: 'cycle'; nodeId: string }
  | { kind: 'stepLimit' };

export interface Trace {
  verdict: Verdict;
  /** Every decision taken, in order. This is the "why" for a single file. */
  branches: Branch[];
  /** True when work happens but an unknowable guard decides whether it is kept. */
  retentionUncertain: boolean;
  stop: Stop;
}

export interface InterpretOptions {
  /** Extra or replacement simulators, keyed `name@version`. */
  simulators?: Readonly<Record<string, Simulator>>;
  /** Bound flow variables, so `checkFlowVariable` can resolve. */
  variables?: Readonly<Record<string, string>>;
  /** Runaway guard. A flow with a legitimate loop is not a thing Tdarr builds. */
  maxSteps?: number;
}

export interface PreparedNode {
  id: string;
  ref: string;
  name: string;
  inputs: Record<string, InputValue>;
  simulator: Simulator | undefined;
  action: boolean;
  revert: boolean;
  out: Map<number, string>;
}

export interface PreparedFlow {
  readonly entry: string | undefined;
  readonly nodes: ReadonlyMap<string, PreparedNode>;
  readonly maxSteps: number;
  readonly variables: Readonly<Record<string, string>>;
  /** Gate nodes in graph order, for the funnel's rows. */
  readonly gates: readonly PreparedNode[];
}

/**
 * Does the per-flow work once: decoding every `inputsDB`, resolving simulators,
 * flattening adjacency.
 *
 * Called once per scan rather than once per file. At 23,846 files, decoding
 * inputs inside the loop would be 23,846 redundant passes over the same 35
 * nodes.
 */
export function prepareFlow(flow: FlowJson, options: InterpretOptions = {}): PreparedFlow {
  const walk = new Walk(flow);
  const overrides = options.simulators ?? {};
  const nodes = new Map<string, PreparedNode>();

  const out = new Map<string, Map<number, string>>();
  for (const edge of flow.flowEdges ?? []) {
    // Error edges are not walked: this asks what happens to a file, and an err1
    // path is what happens when a step breaks, which is not a property of the
    // file. Counting them would mean claiming to predict failures.
    if (edge.sourceHandle === null || String(edge.sourceHandle) === 'err1') continue;
    const handle = Number(edge.sourceHandle);
    if (!Number.isFinite(handle)) continue;
    const byHandle = out.get(edge.source) ?? new Map<number, string>();
    // First edge wins. A handle wired to two nodes is a flow Tdarr would not
    // build; picking one keeps the walk total rather than inventing a fork.
    if (!byHandle.has(handle)) byHandle.set(handle, edge.target);
    out.set(edge.source, byHandle);
  }

  for (const node of walk.nodes) {
    const ref = `${node.pluginName}@${node.version}`;
    const inputs = safeInputs(walk, node);
    const simulator = overrides[ref] ?? simulatorFor(ref);

    nodes.set(node.id, {
      id: node.id,
      ref,
      name: nameOf(node, ref),
      inputs,
      simulator,
      action: isAction(ref),
      revert: isRevert(ref, inputs),
      out: out.get(node.id) ?? new Map(),
    });
  }

  const targeted = new Set((flow.flowEdges ?? []).map((edge) => edge.target));
  const entry = walk.nodes.find((node) => !targeted.has(node.id))?.id ?? walk.nodes[0]?.id;

  return {
    entry,
    nodes,
    maxSteps: options.maxSteps ?? 200,
    variables: options.variables ?? {},
    gates: [...nodes.values()].filter((node) => node.simulator !== undefined),
  };
}

function nameOf(node: FlowNode, ref: string): string {
  return node.name?.trim() ? node.name : ref.split('@')[0]!;
}

/**
 * `decodeInputs` throws on a plugin the catalog does not know, which an imported
 * flow routinely contains. The raw strings are still useful - every simulator
 * coerces what it reads - so fall back rather than failing the whole scan.
 */
function safeInputs(walk: Walk, node: FlowNode): Record<string, InputValue> {
  try {
    return walk.inputs(node) as Record<string, InputValue>;
  } catch {
    return { ...node.inputsDB };
  }
}

export function interpret(prepared: PreparedFlow, record: MediaRecord): Trace {
  const branches: Branch[] = [];
  const seen = new Set<string>();
  const env = { variables: prepared.variables };

  let acted = false;
  let retentionUncertain = false;
  let current = prepared.entry;
  let steps = 0;

  const settle = (stop: Stop): Trace => ({
    verdict: verdictFor(stop, acted),
    branches,
    retentionUncertain,
    stop,
  });

  while (current !== undefined) {
    if (steps++ >= prepared.maxSteps) return settle({ kind: 'stepLimit' });
    if (seen.has(current)) return settle({ kind: 'cycle', nodeId: current });
    seen.add(current);

    const node = prepared.nodes.get(current);
    if (!node) return settle({ kind: 'terminal', nodeId: current });

    // A revert wipes the slate: whatever was done is no longer what gets
    // committed, so the "we already know work happened" reasoning restarts.
    if (node.revert) {
      acted = false;
      retentionUncertain = false;
    }
    if (node.action) acted = true;

    let handle = 1;
    if (node.simulator) {
      const outcome = node.simulator.evaluate(record, node.inputs, env);

      if (outcome.kind === 'threw') {
        return settle({ kind: 'threw', nodeId: node.id, ref: node.ref, reason: outcome.reason });
      }
      if (outcome.kind === 'unknowable') {
        // See the header: after an action this is a retention question, not an
        // "is it processed" question, so the walk stops but the verdict holds.
        if (acted) {
          retentionUncertain = true;
          return settle({ kind: 'terminal', nodeId: node.id });
        }
        return settle({
          kind: 'unknowable',
          nodeId: node.id,
          ref: node.ref,
          reason: outcome.reason,
        });
      }
      handle = outcome.handle;
      branches.push({ nodeId: node.id, ref: node.ref, name: node.name, handle });
    } else if (node.out.size > 1) {
      // More than one way onward and nothing that knows how to choose. Guessing
      // handle 1 would quietly invent a path; say so instead.
      //
      // Past an action the same reasoning as above applies: the work has already
      // happened, and this only decides what becomes of it. `runClassicTranscode
      // Plugin@2.0.0` is exactly this - it acts, and then reports on handle 2
      // that the wrapped plugin declined - so the file counts as processed with
      // the outcome marked uncertain, rather than vanishing into "unknown".
      if (acted) {
        retentionUncertain = true;
        return settle({ kind: 'terminal', nodeId: node.id });
      }
      return settle({ kind: 'unmodelled', nodeId: node.id, ref: node.ref });
    }

    const next = node.out.get(handle);
    if (next === undefined) {
      return settle(
        node.out.size === 0
          ? { kind: 'terminal', nodeId: node.id }
          : { kind: 'unwired', nodeId: node.id, handle },
      );
    }
    current = next;
  }

  return settle({ kind: 'terminal', nodeId: prepared.entry ?? '' });
}

function verdictFor(stop: Stop, acted: boolean): Verdict {
  if (acted) return 'modifies';

  switch (stop.kind) {
    case 'unknowable':
    case 'unmodelled':
    case 'threw':
    case 'cycle':
    case 'stepLimit':
      return 'indeterminate';
    case 'unwired':
      // A gate sent the file down a path with nothing on it. That is how the
      // source recipe declines a file - the dangling handle is the rejection.
      return 'rejected';
    default:
      // Walked to the end of the graph without anything acting on the file.
      return 'untouched';
  }
}
