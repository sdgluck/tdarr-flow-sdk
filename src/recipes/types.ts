import type { Cursor, Segment } from '../graph/builder.ts';

/**
 * A recipe is just a `Segment` that remembers what it is. The tag costs nothing
 * and gives the import matchers something to check their guesses against, and
 * the app something to label a region of the preview with.
 */
export interface RecipeMeta {
  recipe: string;
  params: unknown;
}

export interface Recipe extends Segment {
  readonly meta: RecipeMeta;
}

export function recipe(
  name: string,
  params: unknown,
  apply: (cursor: Cursor) => Cursor,
): Recipe {
  return { kind: 'segment', meta: { recipe: name, params }, apply };
}

/** A recipe that adds nothing - `mode: 'leave'` on any step. */
export function noop(name: string, params: unknown): Recipe {
  return recipe(name, params, (cursor) => cursor);
}

/**
 * Applies custom ffmpeg arguments to a command block, if there are any.
 *
 * Placed last in the block on purpose: ffmpeg takes the final occurrence of a
 * repeated option, so arguments a user wrote by hand override the ones the
 * wizard generated rather than being quietly discarded by them. That is the
 * behaviour someone reaching for a raw argument field is asking for.
 */
export function withCustomArguments(
  block: { custom(inputs: { inputArguments?: string; outputArguments?: string }): unknown },
  args: { input?: string; output?: string } | undefined,
): void {
  const input = args?.input?.trim();
  const output = args?.output?.trim();
  if (!input && !output) return;

  block.custom({
    ...(input ? { inputArguments: input } : {}),
    ...(output ? { outputArguments: output } : {}),
  });
}
