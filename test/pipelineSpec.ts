/**
 * A `FlowSpec` describing the real pipeline in
 * `test/fixtures/transcode-pipeline.json`, which was built by hand in Tdarr's
 * editor over time.
 *
 * This is the golden test's input, and the whole point of the exercise: if the
 * spec model cannot express a flow somebody actually built and runs, it is the
 * wrong model, and no amount of wizard polish would fix that.
 */

import { SPEC_VERSION } from '../src/types/spec.ts';
import type { FlowSpec } from '../src/types/spec.ts';

/** Tdarr expands this to the name of the node that picked the job up. */
const NODE_NAME = '{{{args.configVars.config.nodeName}}}';

export const pipelineSpec: FlowSpec = {
  specVersion: SPEC_VERSION,
  meta: { name: 'Transcode Pipeline', priority: 0, flowId: 'a_CeSjPzb' },

  source: {
    requireMedium: 'video',
    extensions: { mode: 'any', list: [] },
    minSizeMb: 0,
  },

  container: {
    mode: 'remux',
    target: 'mkv',
    method: {
      kind: 'classic',
      pluginSourceId: 'Local:Tdarr_Plugin_bsh1_RemuxMKV',
      fallbackPluginSourceId: 'Local:Tdarr_Plugin_bsh1_ForceRemuxMKV',
    },
    healStatistics: true,
  },

  video: {
    mode: 'transcode',
    targetCodec: 'hevc',
    skipIfAlreadyTarget: true,
    encoder: {
      kind: 'classic',
      branches: [
        {
          label: 'Nvidia',
          flowVariable: NODE_NAME,
          equals: 'Nvidia',
          pluginSourceId: 'Community:Tdarr_Plugin_MC93_Migz1FFMPEG',
        },
        {
          label: 'QuickSync',
          flowVariable: NODE_NAME,
          equals: 'Intel',
          pluginSourceId: 'Local:Tdarr_Plugin_bsh1_Boosh_FFMPEG_QSV_HEVC',
        },
      ],
      fallbackPluginSourceId: 'Community:Tdarr_Plugin_MC93_Migz1FFMPEG_CPU',
      errorFallsBackToCpu: true,
    },
    sizeGuard: { enabled: true, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
    onEncodeFailure: 'keepOriginal',
  },

  tracks: {
    mode: 'clean',
    implementation: {
      kind: 'classic',
      pluginSourceId: 'Local:Tdarr_Plugin_bsh1_CleanTracks',
      inputs: { tag_language: 'eng', remove_commentary: 'true', remove_sdh: 'false' },
    },
  },

  audio: {
    mode: 'ensure',
    encoder: 'eac3',
    language: 'eng',
    // No `samplerate`: the reference leaves that field at its default and
    // disabled, which is what omitting it here produces.
    surround: { channels: 6, bitrate: '384k', matchChannels: [4, 5, 6, 7, 8] },
    stereo: { channels: 2, bitrate: '192k', matchChannels: [2, 3] },
    mono: { channels: 1, bitrate: '96k' },
    stereoMate: true,
    normalise: {
      pluginName: 'normaliseAudioTracks',
      version: '1.0.0',
      outputs: 1,
      inputs: { targetCodec: 'eac3', surroundMinChannels: '4' },
    },
    reorder: { processOrder: 'streamTypes', streamTypes: 'video,audio,subtitle' },
  },

  output: {
    restampStatistics: true,
    destination: { kind: 'replaceOriginal' },
    notifications: [],
  },

  policy: { errorHandling: 'reset-and-continue' },
  extras: [],
};
