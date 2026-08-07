/**
 * Layer 1: the typed fluent builder.
 *
 * The model is deliberately small. A `NodeSpec` says "add this plugin"; a
 * `Cursor` is a position in the graph *plus the handle the next attachment will
 * leave by*; a `Segment` is a reusable piece of graph that takes a cursor and
 * returns one. Layer 2's recipes are all just `Segment`s, which is why there is
 * no separate composition mechanism for them.
 *
 * Carrying the outgoing handle on the cursor rather than the node is what makes
 * `.on(2, someSegment)` work when the segment turns out to add no nodes at all -
 * a conditional recipe can return the cursor it was handed and the branch stays
 * correctly wired to handle 2.
 */

import { getPluginByRef } from '../catalog/index.ts';
import type { HandlesFor, InputsFor, PluginRef } from '../catalog/inputs.generated.ts';
import type { FlowJson } from '../types/flow.ts';
import { FlowBuildError } from './errors.ts';
import type { Handle, Shape } from './handles.ts';
import { assertHandle, shapeOfRef } from './handles.ts';
import { encodeInputs } from './inputs.ts';
import type { InputValue } from './inputs.ts';
import { IdAllocator } from './ids.ts';
import type { LayoutOptions } from './layout.ts';
import { toFlowJson } from './serialize.ts';

/** A catalogued plugin ref, or any other string for Local / uncatalogued ones. */
export type AnyRef = PluginRef | (string & {});

/** Numbered handles a ref exposes; anything uncatalogued falls back to `number`. */
export type HandlesOf<R extends AnyRef> = R extends PluginRef ? HandlesFor<R> : number;

export type InputsOf<R extends AnyRef> = R extends PluginRef ? InputsFor<R>
  : Record<string, InputValue>;

export interface NodeOptions {
  /** Fixed id. Use when a flow must keep the ids an existing server copy has. */
  id?: string;
  /** Label shown in the editor. Defaults to the plugin's catalogued title. */
  name?: string;
  sourceRepo?: 'Community' | 'Local';
  fpEnabled?: boolean;
  /** Nudge off the main spine in the generated layout. */
  offSpine?: boolean;
}

export interface NodeSpec<R extends AnyRef = AnyRef> {
  readonly kind: 'node';
  readonly ref: R;
  readonly pluginName: string;
  readonly version: string;
  readonly sourceRepo: 'Community' | 'Local';
  /** Already encoded, so a bad input fails where the caller wrote it. */
  readonly inputsDB: Record<string, string>;
  readonly options: NodeOptions;
  readonly declaredShape?: Shape;
}

export interface Segment {
  readonly kind: 'segment';
  apply(cursor: Cursor): Cursor;
}

/**
 * Anything that can be wired onto a cursor. A `Cursor` is included so branches
 * can converge on a node that already exists - which real flows do constantly:
 * every encoder in the reference pipeline lands on the same size-ratio check.
 */
export type Attachable<R extends AnyRef = AnyRef> =
  | NodeSpec<R>
  | Segment
  | Cursor<R>
  | ((cursor: Cursor) => Cursor);

// --- node constructors ------------------------------------------------------

/**
 * A catalogued community plugin. Prefer the generated factories
 * (`checkVideoCodec({ codec: 'hevc' })`) - this is what they call.
 */
export function node<R extends PluginRef>(
  ref: R,
  inputs?: InputsFor<R>,
  options?: NodeOptions,
): NodeSpec<R> {
  const entry = getPluginByRef(ref);
  if (!entry) {
    throw new FlowBuildError(
      `no such plugin in the catalog: ${ref}. Use localNode() for a Local flow plugin, or run `
        + '`pnpm plugins:update && pnpm catalog:generate` if upstream has added it.',
    );
  }
  return {
    kind: 'node',
    ref,
    pluginName: entry.name,
    version: entry.version,
    sourceRepo: options?.sourceRepo ?? 'Community',
    inputsDB: encodeInputs(ref, inputs as Record<string, InputValue> | undefined),
    options: options ?? {},
  };
}

export interface LocalNodeOptions extends NodeOptions {
  pluginName: string;
  version?: string;
  /** Count of numbered outputs. Required: nothing else can know it. */
  outputs: number;
  error?: boolean;
  terminal?: boolean;
  inputs?: Record<string, InputValue>;
}

/**
 * A plugin the catalog does not know about - a Local flow plugin, or a community
 * one newer than the vendored snapshot. The caller declares the shape so the
 * linter can still reason about the node instead of shrugging at it.
 */
export function localNode(options: LocalNodeOptions): NodeSpec<string> {
  const { pluginName, version = '1.0.0', outputs, error, terminal, inputs, ...rest } = options;
  const ref = `${pluginName}@${version}`;
  return {
    kind: 'node',
    ref,
    pluginName,
    version,
    sourceRepo: rest.sourceRepo ?? 'Local',
    inputsDB: encodeInputs(ref, inputs),
    options: rest,
    declaredShape: {
      outputs,
      error: error ?? false,
      terminal: terminal ?? outputs === 0,
      confidence: 'declared',
    },
  };
}

export function segment(apply: (cursor: Cursor) => Cursor): Segment {
  return { kind: 'segment', apply };
}

// --- internal model ---------------------------------------------------------

export interface PlacedNode {
  id: string;
  ref: string;
  pluginName: string;
  version: string;
  sourceRepo: 'Community' | 'Local';
  name: string;
  fpEnabled: boolean;
  inputsDB: Record<string, string>;
  shape: Shape;
  offSpine: boolean;
}

export interface ModelEdge {
  source: string;
  sourceHandle: Handle;
  target: string;
}

export interface GraphModel {
  name: string;
  nodes: PlacedNode[];
  edges: ModelEdge[];
}

export interface FlowOptions {
  id?: string;
  priority?: number;
  description?: string;
  tags?: string;
  isUiLocked?: boolean;
  layout?: LayoutOptions;
}

const UNKNOWN_SHAPE: Shape = {
  outputs: 1,
  error: false,
  terminal: false,
  confidence: 'unknown',
};

// --- cursor -----------------------------------------------------------------

/**
 * A position in the graph. `handle` is the output the *next* attachment leaves
 * by; it is 1 unless `on()`/`onError()` moved it.
 */
export class Cursor<R extends AnyRef = AnyRef> {
  readonly builder: FlowBuilder;
  readonly id: string;
  readonly ref: R;
  readonly handle: Handle;

  constructor(builder: FlowBuilder, id: string, ref: R, handle: Handle = 1) {
    this.builder = builder;
    this.id = id;
    this.ref = ref;
    this.handle = handle;
  }

  /** Same node, different outgoing handle. Nothing is wired until something attaches. */
  at(handle: Handle): Cursor<R> {
    return new Cursor(this.builder, this.id, this.ref, handle);
  }

  /**
   * Attach via the cursor's current handle (1 unless moved).
   *
   * Naming this `then` makes `Cursor` thenable, which means `await cursor`
   * would hand our method the promise resolver and hang. Nothing here is async
   * and no reasonable caller awaits a graph cursor, and `.then()` is what makes
   * the chain read like the flow it describes - so the ergonomics win.
   */
  // oxlint-disable-next-line no-thenable
  then<N extends AnyRef>(next: Attachable<N>): Cursor<N> {
    return this.builder._attach(this, next) as Cursor<N>;
  }

  on<N extends AnyRef>(handle: HandlesOf<R>, next: Attachable<N>): Cursor<N> {
    return this.at(handle as Handle).then(next);
  }

  /** Wire the error handle. Rejected at build time if the node has none. */
  onError<N extends AnyRef>(next: Attachable<N>): Cursor<N> {
    return this.at('err1').then(next);
  }

  /**
   * Wire several handles from this node. Returns this cursor rather than any of
   * the branches, since there is no single "next" after a fan-out.
   */
  fork(branches: Partial<Record<number | 'err1', Attachable>>): Cursor<R> {
    for (const [key, target] of Object.entries(branches)) {
      if (!target) continue;
      this.at(key === 'err1' ? 'err1' : Number(key)).then(target);
    }
    return this;
  }

  /** Wire this cursor's output into an existing node without moving. */
  join(target: Cursor | string): Cursor<R> {
    this.builder.connect(this.id, this.handle, typeof target === 'string' ? target : target.id);
    return this;
  }

  /** Rename the node in place. */
  as(name: string): Cursor<R> {
    this.builder._node(this.id).name = name;
    return this;
  }

  tap(fn: (cursor: Cursor<R>) => void): Cursor<R> {
    fn(this);
    return this;
  }

  end(): FlowBuilder {
    return this.builder;
  }

  build(): FlowJson {
    return this.builder.build();
  }
}

// --- builder ----------------------------------------------------------------

export class FlowBuilder {
  readonly name: string;
  readonly options: FlowOptions;

  #nodes: PlacedNode[] = [];
  #edges: ModelEdge[] = [];
  #ids: IdAllocator;
  #entry: string | undefined;

  constructor(name: string, options: FlowOptions = {}) {
    this.name = name;
    this.options = options;
    this.#ids = new IdAllocator(options.id ?? name);
  }

  /** The flow's first node. Calling it twice is a mistake, not a fan-in. */
  start<R extends AnyRef>(spec: NodeSpec<R>): Cursor<R> {
    if (this.#entry) {
      throw new FlowBuildError(
        `flow "${this.name}" already starts at ${this.#entry}. A flow has exactly one entry; `
          + 'use add() for a second, detached node.',
      );
    }
    const cursor = this.add(spec);
    this.#entry = cursor.id;
    return cursor;
  }

  /** A node with nothing wired to it yet - for graphs a single chain cannot express. */
  add<R extends AnyRef>(spec: NodeSpec<R>): Cursor<R> {
    const id = spec.options.id ? this.#ids.claim(spec.options.id) : this.#ids.next(spec.ref);
    const entry = getPluginByRef(spec.ref);

    this.#nodes.push({
      id,
      ref: spec.ref,
      pluginName: spec.pluginName,
      version: spec.version,
      sourceRepo: spec.sourceRepo,
      name: spec.options.name ?? entry?.title ?? spec.pluginName,
      fpEnabled: spec.options.fpEnabled ?? true,
      inputsDB: spec.inputsDB,
      shape: spec.declaredShape ?? shapeOfRef(spec.ref) ?? UNKNOWN_SHAPE,
      offSpine: spec.options.offSpine ?? false,
    });

    return new Cursor(this, id, spec.ref);
  }

  connect(fromId: string, handle: Handle, toId: string): this {
    const from = this._node(fromId);
    this._node(toId);
    assertHandle(from.ref, from.shape, handle, { nodeId: fromId, name: from.name });

    const duplicate = this.#edges.some((e) =>
      e.source === fromId && e.sourceHandle === handle && e.target === toId
    );
    if (!duplicate) this.#edges.push({ source: fromId, sourceHandle: handle, target: toId });
    return this;
  }

  at(id: string): Cursor {
    return new Cursor(this, this._node(id).id, this._node(id).ref);
  }

  nodes(): readonly PlacedNode[] {
    return this.#nodes;
  }

  edges(): readonly ModelEdge[] {
    return this.#edges;
  }

  model(): GraphModel {
    return { name: this.name, nodes: this.#nodes, edges: this.#edges };
  }

  build(): FlowJson {
    if (!this.#entry && this.#nodes.length) {
      throw new FlowBuildError(
        `flow "${this.name}" has nodes but no entry. Begin with start() so Tdarr knows where `
          + 'to come in.',
      );
    }
    return toFlowJson(this.model(), this.options);
  }

  /** @internal */
  _node(id: string): PlacedNode {
    const found = this.#nodes.find((n) => n.id === id);
    if (!found) throw new FlowBuildError(`no such node: ${id}`, id);
    return found;
  }

  /** @internal Resolves any `Attachable` against a cursor's pending handle. */
  _attach(from: Cursor, next: Attachable): Cursor {
    if (typeof next === 'function') return next(from);

    // Converging on an existing node: wire into it and hand back a fresh cursor
    // there, so the caller's next `.then()` leaves by handle 1 rather than
    // whatever handle the target cursor happened to be pointing at.
    if (next instanceof Cursor) {
      this.connect(from.id, from.handle, next.id);
      return new Cursor(this, next.id, next.ref);
    }

    if (next.kind === 'segment') return next.apply(from);

    const cursor = this.add(next);
    this.connect(from.id, from.handle, cursor.id);
    return cursor;
  }
}

export function flow(name: string, options: FlowOptions = {}): FlowBuilder {
  return new FlowBuilder(name, options);
}
