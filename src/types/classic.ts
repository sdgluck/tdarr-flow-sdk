/**
 * Classic (pre-flow) plugins.
 *
 * Flows still run these, through `runClassicTranscodePlugin`, and a flow
 * references one by a `pluginSourceId` like
 * `Community:Tdarr_Plugin_MC93_Migz1FFMPEG` - a string nobody can be expected
 * to produce from memory. Cataloguing them turns that field from recall into
 * recognition.
 *
 * Their `details()` is a different shape from the flow plugins': capitalised
 * keys, an explicit `id`, and `Stage`/`Type`/`Operation` instead of tags alone.
 */

import type { InputUI } from './plugin.ts';

export interface ClassicPluginInput {
  name: string;
  /** Derived from `name`: classic plugins declare no human label. */
  label: string;
  type: 'string' | 'boolean' | 'number';
  /** Always a string, as with flow plugins - Tdarr stores every input as one. */
  defaultValue: string;
  ui: InputUI;
  tooltip?: string;
}

export interface ClassicPluginEntry {
  /** e.g. `Tdarr_Plugin_MC93_Migz1FFMPEG`. */
  id: string;
  /** What a flow node actually stores, e.g. `Community:Tdarr_Plugin_...`. */
  sourceId: string;
  name: string;
  description: string;
  /** `Pre-processing` or `Post-processing`. */
  stage: string;
  /** `Video`, `Audio`, `Subtitle`, `Any`. */
  type: string;
  /** `Transcode` or `Filter`. */
  operation: string;
  version: string;
  tags: string[];
  inputs: ClassicPluginInput[];
}
