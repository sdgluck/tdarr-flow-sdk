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
