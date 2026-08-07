/**
 * The `details()` manifest a Tdarr flow plugin exports.
 *
 * This is the *authoring* half of the plugin contract only - the SDK never runs
 * a plugin, it just needs to know what inputs it accepts and how many outputs it
 * exposes. The runtime half (`plugin(args)`, ffmpeg command mutation) lives in
 * the tdarr-flow-test harness, not here.
 *
 * These interfaces describe the shapes actually observed across all 98 vendored
 * community plugins, not the upstream TypeScript definitions - upstream ships
 * only compiled JS, so this is reverse-engineered and verified by
 * `scripts/generate-catalog.ts`, which hard-errors on anything unexpected.
 */

/** A single `name === value` test against the string form of a sibling input. */
export interface DisplayCondition {
  name: string;
  value: string;
  condition: '===' | '!==';
}

export interface DisplayConditionSet {
  logic: 'AND' | 'OR';
  inputs: DisplayCondition[];
}

/**
 * Controls whether an input is shown. Every occurrence in the vendored catalog
 * uses `logic: 'AND'` at both levels, but `OR` is supported because Tdarr's own
 * UI evaluates it.
 */
export interface DisplayConditions {
  logic: 'AND' | 'OR';
  sets: DisplayConditionSet[];
}

/**
 * Widget hint. Observed across the catalog: `text` (96), `dropdown` (62),
 * `switch` (29), `textarea` (9), `directory` (5). No other value occurs, so an
 * unknown one means upstream added a widget and the app should fall back to a
 * plain text field rather than render nothing.
 */
export type InputUIType = 'text' | 'dropdown' | 'switch' | 'textarea' | 'directory';

export interface InputUI {
  type: InputUIType | (string & {});
  options?: string[];
  displayConditions?: DisplayConditions;
}

export interface FlowPluginInputDef {
  label: string;
  name: string;
  type: 'string' | 'boolean' | 'number';
  /**
   * Always a string in the vendored catalog - Tdarr stores every input value as
   * a string in `inputsDB` and coerces on read. The generator asserts this.
   */
  defaultValue: string;
  inputUI: InputUI;
  tooltip?: string;
}

export interface FlowPluginOutputDef {
  number: number;
  tooltip?: string;
}

export interface FlowPluginDetails {
  /** Human title, e.g. "Check Video Codec". Not the same as `pluginName`. */
  name: string;
  description: string;
  style?: { borderColor?: string; [key: string]: unknown };
  /** Comma-separated, e.g. "video,configure". */
  tags?: string;
  isStartPlugin: boolean;
  pType: string;
  requiresVersion?: string;
  sidebarPosition?: number;
  icon?: string;
  inputs: FlowPluginInputDef[];
  outputs: FlowPluginOutputDef[];
}
