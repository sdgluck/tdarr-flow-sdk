/**
 * Starting points.
 *
 * An empty wizard is a bad first screen: every control is off, nothing explains
 * which combinations are sensible, and the person most likely to be looking at
 * it is the one who least knows what a Tdarr flow usually contains. These are
 * the shapes people actually build, as complete specs to be edited rather than
 * templates to be filled in.
 *
 * They live in the SDK rather than the app because they are flow knowledge, and
 * because a test can then assert every one of them compiles to a lint-clean
 * flow - which is the only thing that makes them safe to offer.
 */

import { newSpec } from '../recipes/compileSpec.ts';
import type { FlowSpec } from '../types/spec.ts';

export interface FlowPreset {
  id: string;
  name: string;
  /** One line, shown on the card. */
  summary: string;
  /** What it does and when you would want it. */
  detail: string;
  tags: string[];
  spec(): FlowSpec;
}

/** The node-name variable Tdarr expands to whichever worker picked up the job. */
const NODE_NAME = '{{{args.configVars.config.nodeName}}}';

const base = (name: string, mutate: (spec: FlowSpec) => void): FlowSpec => {
  const spec = newSpec(name);
  spec.source.requireMedium = 'video';
  mutate(spec);
  return spec;
};

/** Surround + a stereo mate, the layout most libraries want. */
const eac3Audio = (spec: FlowSpec) => {
  spec.audio = {
    mode: 'ensure',
    encoder: 'eac3',
    language: 'eng',
    surround: { channels: 6, bitrate: '384k', matchChannels: [4, 5, 6, 7, 8] },
    stereo: { channels: 2, bitrate: '192k', matchChannels: [2, 3] },
    mono: { channels: 1, bitrate: '96k' },
    stereoMate: true,
    reorder: { processOrder: 'streamTypes', streamTypes: 'video,audio,subtitle' },
  };
};

export const PRESETS: readonly FlowPreset[] = [
  {
    id: 'hevc-simple',
    name: 'HEVC, everything',
    summary: 'Re-encode all video to HEVC, keeping the container as it is.',
    detail:
      'The smallest useful flow. Files already in HEVC are skipped, so a library converges over '
      + 'repeated scans instead of being re-encoded every time. Hardware is left on auto, which is '
      + 'right until you have a reason to pin it.',
    tags: ['video', 'starter'],
    spec: () =>
      base('HEVC', (spec) => {
        spec.video = {
          mode: 'transcode',
          targetCodec: 'hevc',
          skipIfAlreadyTarget: true,
          encoder: { kind: 'ffmpeg', hardware: 'auto' },
          sizeGuard: { enabled: true, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
          onEncodeFailure: 'keepOriginal',
        };
      }),
  },

  {
    id: 'hevc-hardware-routing',
    name: 'HEVC, routed by worker',
    summary: 'Each machine encodes with its own hardware, falling back to CPU.',
    detail:
      'For a Tdarr cluster where the workers are not identical. The flow asks which node picked '
      + 'the job up and routes to the matching encoder, with a CPU encoder both as the default and '
      + 'as the landing spot when hardware fails - which it does for ordinary reasons that do not '
      + 'mean the file cannot be encoded.',
    tags: ['video', 'cluster', 'hardware'],
    spec: () =>
      base('HEVC by worker', (spec) => {
        // Remuxed through the ffmpeg block rather than a classic plugin: a
        // preset must compile the moment it is chosen, and a classic remux
        // would need a plugin id nobody has picked yet.
        spec.container = {
          mode: 'remux',
          target: 'mkv',
          healStatistics: true,
          method: { kind: 'ffmpeg', forceConform: false },
        };
        spec.video = {
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
                pluginSourceId: 'Community:Tdarr_Plugin_bsh1_Boosh_FFMPEG_QSV_HEVC',
              },
            ],
            fallbackPluginSourceId: 'Community:Tdarr_Plugin_MC93_Migz1FFMPEG_CPU',
            errorFallsBackToCpu: true,
          },
          sizeGuard: { enabled: true, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
          onEncodeFailure: 'keepOriginal',
        };
        eac3Audio(spec);
        spec.output.restampStatistics = true;
      }),
  },

  {
    id: 'av1-archive',
    name: 'AV1 for archiving',
    summary: 'Smallest files, slowest encode, 10-bit.',
    detail:
      'For material you are keeping rather than watching tonight. AV1 gets meaningfully smaller '
      + 'files than HEVC and takes considerably longer to produce them, and playback support is '
      + 'still patchier - check your players before committing a library to it.',
    tags: ['video', 'archive'],
    spec: () =>
      base('AV1 archive', (spec) => {
        spec.video = {
          mode: 'transcode',
          targetCodec: 'av1',
          skipIfAlreadyTarget: true,
          encoder: { kind: 'ffmpeg', hardware: 'auto', tenBit: true, preset: 'slow' },
          sizeGuard: { enabled: true, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
          onEncodeFailure: 'keepOriginal',
        };
      }),
  },

  {
    id: 'remux-mkv',
    name: 'Remux to MKV',
    summary: 'One container everywhere. No re-encoding at all.',
    detail:
      'Copies the streams into MKV without touching them, then rebuilds the Matroska statistics '
      + 'tags a remux invalidates - which is what leaves players showing a nonsense duration. Fast, '
      + 'lossless, and a good first pass before deciding what else a library needs.',
    tags: ['container', 'lossless'],
    spec: () =>
      base('Remux to MKV', (spec) => {
        spec.container = {
          mode: 'remux',
          target: 'mkv',
          healStatistics: true,
          method: { kind: 'ffmpeg', forceConform: false },
        };
        spec.output.restampStatistics = true;
      }),
  },

  {
    id: 'mp4-compatibility',
    name: 'MP4 for maximum compatibility',
    summary: 'H.264 video and AAC stereo in MP4 — plays on anything.',
    detail:
      'The lowest common denominator, on purpose. Choose it for devices that will not direct-play '
      + 'anything modern: older TVs, casting to hardware you do not control, or a share that has to '
      + 'work first time. Files will be larger than the HEVC equivalent.',
    tags: ['video', 'audio', 'compatibility'],
    spec: () =>
      base('MP4 compatibility', (spec) => {
        spec.container = {
          mode: 'remux',
          target: 'mp4',
          healStatistics: false,
          method: { kind: 'ffmpeg', forceConform: true },
        };
        spec.video = {
          mode: 'transcode',
          targetCodec: 'h264',
          skipIfAlreadyTarget: true,
          encoder: { kind: 'ffmpeg', hardware: 'auto' },
          sizeGuard: { enabled: false, greaterThan: 0, lessThan: 100, onFail: 'continue' },
          onEncodeFailure: 'keepOriginal',
        };
        spec.audio = {
          mode: 'ensure',
          encoder: 'aac',
          language: 'eng',
          stereo: { channels: 2, bitrate: '192k' },
          stereoMate: false,
        };
      }),
  },

  {
    id: 'audio-eac3',
    name: 'Normalise audio to E-AC3',
    summary: 'Surround where the source has it, stereo where it does not.',
    detail:
      'Leaves video alone entirely. Picks a target layout from what the source actually has - '
      + 'encoding stereo up to 5.1 invents channels, and encoding 5.1 down throws them away - and '
      + 'adds a stereo track alongside surround, because a phone speaker cannot downmix E-AC3 and '
      + 'gets silence without one.',
    tags: ['audio'],
    spec: () => base('E-AC3 audio', (spec) => eac3Audio(spec)),
  },

  {
    id: 'audio-stereo-mate',
    name: 'Add a stereo compatibility track',
    summary: 'Keep the surround track, add a stereo one beside it.',
    detail:
      'The narrowest fix for the most common complaint: surround plays as silence on a phone, a '
      + 'laptop, or a TV speaker. Adds a stereo track and changes nothing else, so the original '
      + 'audio is still there for anything that can play it.',
    tags: ['audio', 'compatibility'],
    spec: () =>
      base('Stereo mate', (spec) => {
        spec.audio = {
          mode: 'ensure',
          encoder: 'aac',
          language: 'eng',
          stereo: { channels: 2, bitrate: '192k' },
          stereoMate: false,
        };
      }),
  },

  {
    id: 'clean-tracks',
    name: 'Strip unwanted tracks',
    summary: 'Drop foreign-language audio, commentary and subtitles.',
    detail:
      'Removes streams rather than re-encoding anything, so it is quick and lossless. Worth running '
      + 'before a transcode: there is no point spending an hour encoding audio tracks you were '
      + 'going to delete.',
    tags: ['tracks', 'lossless'],
    spec: () =>
      base('Clean tracks', (spec) => {
        spec.tracks = {
          mode: 'clean',
          implementation: { kind: 'ffmpeg', removeSubtitles: true, removeDataStreams: true },
        };
      }),
  },

  {
    id: 'shrink-large-files',
    name: 'Shrink only the big files',
    summary: 'Transcode files over a size threshold, leave the rest alone.',
    detail:
      'Targets the handful of files costing most of the disk rather than the whole library. The '
      + 'size gate keeps small files out entirely, and the size guard keeps the original whenever '
      + 'the result is not actually smaller - together they mean a scan can only help.',
    tags: ['video', 'storage'],
    spec: () =>
      base('Shrink large files', (spec) => {
        spec.source.minSizeMb = 4000;
        spec.video = {
          mode: 'transcode',
          targetCodec: 'hevc',
          skipIfAlreadyTarget: true,
          encoder: { kind: 'ffmpeg', hardware: 'auto' },
          sizeGuard: { enabled: true, greaterThan: 0, lessThan: 80, onFail: 'keepOriginal' },
          onEncodeFailure: 'keepOriginal',
        };
      }),
  },

  {
    id: 'transcode-and-deliver',
    name: 'Transcode and deliver elsewhere',
    summary: 'Encode to HEVC, then move the result to another directory.',
    detail:
      'For a workflow where processed files leave the ingest folder - a separate library, a share, '
      + 'or somewhere your media server watches. Set the destination in the Output step; the '
      + 'relative path is preserved so the folder structure survives the move.',
    tags: ['video', 'delivery'],
    spec: () =>
      base('Transcode and deliver', (spec) => {
        spec.video = {
          mode: 'transcode',
          targetCodec: 'hevc',
          skipIfAlreadyTarget: true,
          encoder: { kind: 'ffmpeg', hardware: 'auto' },
          sizeGuard: { enabled: true, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
          onEncodeFailure: 'keepOriginal',
        };
        eac3Audio(spec);
        spec.output.restampStatistics = true;
        // A plausible path rather than a blank: the preset has to produce a
        // working flow immediately, and this is the first thing anyone will
        // change anyway.
        spec.output.destination = {
          kind: 'moveToDirectory',
          directory: '/mnt/media/processed',
          keepRelative: true,
        };
      }),
  },
];

export function findPreset(id: string): FlowPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * Whether a spec still holds nothing but defaults.
 *
 * The name is excluded deliberately: a flow that has only been named has
 * nothing worth protecting, and treating it as work would mean prompting
 * before every replacement - which teaches people to click through the prompt
 * that does matter.
 */
export function isPristine(spec: FlowSpec): boolean {
  const bare = (value: FlowSpec) => JSON.stringify({ ...value, meta: {} });
  return bare(spec) === bare(newSpec());
}
