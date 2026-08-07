/**
 * The `inputsDB` serialization contract.
 *
 * Tdarr stores every node input as a string and coerces on read, in
 * `vendor/methods/loadDefaultValues.js`. That function is short and its exact
 * behaviour is load-bearing here, so the rules it implies are spelled out:
 *
 *   - strings are `.trim()`ed before anything else, so trailing whitespace is
 *     never meaningful;
 *   - `undefined` **and `''`** both fall back to the plugin's `defaultValue`.
 *     An empty string is therefore not a way to say "empty" - it silently means
 *     "give me the default". We reject it rather than let a caller believe they
 *     cleared a field;
 *   - `type: 'boolean'` is `value === 'true'`, so anything else - including
 *     `'True'` and `'1'` - is false;
 *   - `type: 'number'` is `Number(value)` with `NaN` collapsing to `0`, which
 *     turns a typo into a plausible-looking zero. We reject non-finite numbers
 *     for the same reason.
 *
 * Values equal to the plugin default are still written out. Tdarr's own editor
 * does that (the reference pipeline stores `enableSamplerate: "false"` even
 * though false is the default), and matching it keeps diffs against an exported
 * flow readable.
 */

import { getPluginByRef } from '../catalog/index.ts';
import type { InputsFor, PluginRef } from '../catalog/inputs.generated.ts';
import { FlowBuildError } from './errors.ts';

export type InputValue = string | number | boolean;

function encodeValue(ref: string, name: string, value: InputValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new FlowBuildError(
        `${ref}: input "${name}" is ${value}. Tdarr reads numbers with Number() and turns NaN `
          + 'into 0, so this would silently become zero rather than fail.',
      );
    }
    return String(value);
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    throw new FlowBuildError(
      `${ref}: input "${name}" is empty. Tdarr treats '' the same as a missing key and `
        + 'substitutes the plugin default, so this cannot mean "no value". Omit the input to '
        + 'accept the default, or give it a real one.',
    );
  }
  return trimmed;
}

/**
 * Typed inputs to the `Record<string, string>` Tdarr stores. Unknown keys throw:
 * a misspelled input name is otherwise completely silent, since the plugin just
 * reads its default and carries on.
 */
export function encodeInputs<R extends PluginRef>(
  ref: R,
  inputs: InputsFor<R> | undefined,
): Record<string, string>;
export function encodeInputs(
  ref: string,
  inputs: Record<string, InputValue> | undefined,
): Record<string, string>;
export function encodeInputs(
  ref: string,
  inputs: Record<string, InputValue> | undefined,
): Record<string, string> {
  if (!inputs) return {};

  const entry = getPluginByRef(ref);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined) continue;

    if (entry && !entry.inputs.some((i) => i.name === name)) {
      const legal = entry.inputs.map((i) => i.name);
      throw new FlowBuildError(
        `${ref} has no input "${name}". `
          + (legal.length ? `It accepts: ${legal.join(', ')}.` : 'It accepts no inputs.'),
      );
    }
    out[name] = encodeValue(ref, name, value);
  }

  return out;
}

/**
 * The inverse, applying the same coercion Tdarr would. Used when importing an
 * existing flow, where every value arrives as a string and the catalog is the
 * only thing that knows what it was meant to be.
 */
export function decodeInputs<R extends PluginRef>(
  ref: R,
  db: Record<string, string> | undefined,
): InputsFor<R>;
export function decodeInputs(
  ref: string,
  db: Record<string, string> | undefined,
): Record<string, InputValue>;
export function decodeInputs(
  ref: string,
  db: Record<string, string> | undefined,
): Record<string, InputValue> {
  const entry = getPluginByRef(ref);
  const out: Record<string, InputValue> = {};
  if (!db) return out;

  for (const [name, raw] of Object.entries(db)) {
    const definition = entry?.inputs.find((i) => i.name === name);
    const value = typeof raw === 'string' ? raw.trim() : raw;

    // Matches loadDefaultValues: '' is indistinguishable from absent.
    if (value === '' || value === undefined) continue;

    if (definition?.type === 'boolean') out[name] = value === 'true';
    else if (definition?.type === 'number') {
      const n = Number(value);
      out[name] = Number.isNaN(n) ? 0 : n;
    } else out[name] = value;
  }

  return out;
}
