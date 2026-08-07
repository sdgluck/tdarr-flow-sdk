/**
 * What handles a node actually has, and whether a given one is legal.
 *
 * Handle validation happens twice: the generated `HandlesFor<R>` types catch it
 * at compile time for hand-written flows, and this catches it at run time for
 * everything the wizard produces, where the handle is a number that came out of
 * a form and TypeScript never saw it.
 */

import { getPluginByRef } from '../catalog/index.ts';
import { FlowBuildError } from './errors.ts';

/** `"1"`, `"2"`, ... or `"err1"`. Serialised into `FlowEdge.sourceHandle`. */
export type Handle = number | 'err1';

export interface Shape {
  /** Count of numbered outputs; handles are 1..outputs. */
  outputs: number;
  error: boolean;
  terminal: boolean;
  /**
   * `catalog` - read from a generated manifest.
   * `declared` - the caller stated it via localNode().
   * `assumed`  - a hand-curated guess (see catalog/overrides.ts).
   * `unknown`  - no information at all.
   */
  confidence: 'catalog' | 'declared' | 'assumed' | 'unknown';
  note?: string;
}

export function shapeOfRef(ref: string): Shape | undefined {
  const entry = getPluginByRef(ref);
  if (!entry) return undefined;
  return {
    outputs: entry.outputs.length,
    error: entry.error,
    terminal: entry.terminal,
    confidence: entry.error && entry.errorConfidence === 'assumed' ? 'assumed' : 'catalog',
  };
}

export function serializeHandle(handle: Handle): string {
  return handle === 'err1' ? 'err1' : String(handle);
}

export function assertHandle(
  ref: string,
  shape: Shape,
  handle: Handle,
  context: { nodeId: string; name: string },
): void {
  const where = `${ref} ("${context.name}")`;

  if (handle === 'err1') {
    if (!shape.error) {
      throw new FlowBuildError(
        `${where} has no error handle, so nothing can be wired to err1. If it really can fail, `
          + 'add it to ERROR_CAPABLE in src/catalog/overrides.ts with a note on why.',
        context.nodeId,
      );
    }
    return;
  }

  if (!Number.isInteger(handle) || handle < 1) {
    throw new FlowBuildError(
      `${where}: handle ${handle} is not a valid output. Handles are numbered from 1.`,
      context.nodeId,
    );
  }

  if (shape.outputs === 0) {
    throw new FlowBuildError(
      `${where} is terminal - it has no outputs, so the flow ends there. `
        + `Handle ${handle} cannot be wired.`,
      context.nodeId,
    );
  }

  if (handle > shape.outputs) {
    const legal = Array.from({ length: shape.outputs }, (_, i) => i + 1).join(', ');
    throw new FlowBuildError(
      `${where} has ${shape.outputs} output${shape.outputs === 1 ? '' : 's'}; handle ${handle} `
        + `is not one of ${legal}.`,
      context.nodeId,
    );
  }
}
