/**
 * The generated plugin catalog: everything the SDK and the web app know about
 * the community flow plugins, extracted from the vendored `details()` manifests
 * by `scripts/generate-catalog.ts`.
 *
 * The catalog is keyed by `name@version`, never by name alone. Seven plugins
 * ship two versions and the version changes their shape - `compareFileSizeRatio`
 * has two outputs at 1.0.0 and three at 2.0.0, and real flows wire handle 3.
 * Collapsing to the newest version silently mis-lints those flows.
 */

import type { DisplayConditions, InputUI } from './plugin.ts';

/** `${pluginName}@${version}`, e.g. `checkVideoCodec@1.0.0`. */
export type PluginRefString = string;

export interface CatalogInput {
  name: string;
  label: string;
  type: 'string' | 'boolean' | 'number';
  /** Always a string: this is the literal `inputsDB` value Tdarr would store. */
  defaultValue: string;
  ui: InputUI;
  tooltip?: string;
  displayConditions?: DisplayConditions;
}

export interface CatalogOutput {
  /** 1-based. Serialised as `sourceHandle: "1"`. */
  number: number;
  tooltip?: string;
}

export interface CatalogEntry {
  /** `${name}@${version}`. The catalog's primary key. */
  ref: PluginRefString;
  /** Directory name - this is what `FlowNode.pluginName` holds. */
  name: string;
  version: string;
  /** Human title from `details().name` - what `FlowNode.name` defaults to. */
  title: string;
  description: string;
  /** Directory under CommunityFlowPlugins, e.g. `video`, `ffmpegCommand`. */
  category: string;
  tags: string[];
  isStartPlugin: boolean;
  requiresVersion?: string;
  icon?: string;
  borderColor?: string;
  inputs: CatalogInput[];
  outputs: CatalogOutput[];
  /**
   * Whether the node exposes an `err1` handle. NOT reported by `details()` - it
   * is a property of the flow engine - so this is hand-curated in
   * `catalog/overrides.ts` and carries a confidence level.
   */
  error: boolean;
  errorConfidence: 'observed' | 'assumed';
  /** No outputs: the flow ends here (e.g. `failFlow`). */
  terminal: boolean;
}

export interface CatalogProvenance {
  repo: string;
  sha: string;
  committedAt: string;
}

export interface Catalog {
  generatedFrom: CatalogProvenance;
  entries: readonly CatalogEntry[];
}
