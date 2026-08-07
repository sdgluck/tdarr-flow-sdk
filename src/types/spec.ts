/**
 * `FlowSpec` - what a flow is *for*, rather than how it is wired.
 *
 * This is a first-class SDK type rather than something the web app owns,
 * because it is the same artefact in four places: the wizard's state, the
 * localStorage format, the payload embedded in a generated flow's description,
 * and the thing `compileSpec` turns into a graph. Any of those owning its own
 * copy would mean four definitions drifting apart.
 *
 * The shape is reverse-engineered from a real pipeline
 * (`test/fixtures/transcode-pipeline.json`, 35 nodes) rather than invented, and
 * the golden test asserts it can still reproduce it. Every field below earns its
 * place by being something that flow actually varies.
 */

import type { LayoutOptions } from '../graph/layout.ts';
import type { FlowEdge } from './flow.ts';

export const SPEC_VERSION = 1;

// --- source -----------------------------------------------------------------

export interface SourceStep {
  /**
   * `checkFileMedium` gate - the reference pipeline's "Readable Video?". `any`
   * omits the gate entirely rather than adding a node that always passes.
   */
  requireMedium: 'any' | 'video' | 'audio';
  /** `checkFileExtension` gate. `mode: 'any'` omits it. */
  extensions: { mode: 'any' | 'include' | 'exclude'; list: string[] };
  /** `checkFileSize` floor in MB; 0 omits the gate. */
  minSizeMb: number;
}

// --- container --------------------------------------------------------------

export type ContainerMethod =
  | {
    kind: 'classic';
    /** e.g. `Local:Tdarr_Plugin_bsh1_RemuxMKV`. */
    pluginSourceId: string;
    /**
     * Tried when the primary remux fails - a more aggressive rebuild. Its own
     * failure is reset and the flow continues with the original file.
     */
    fallbackPluginSourceId?: string;
  }
  | { kind: 'ffmpeg'; forceConform: boolean };

export interface ContainerStep {
  mode: 'leave' | 'remux';
  /** Extension without a dot. `ffmpegCommandSetContainer` offers only these two. */
  target: 'mkv' | 'mp4';
  method: ContainerMethod;
  /**
   * Run `mkvpropedit` after a successful remux to rebuild the statistics tags
   * a remux invalidates. Gated on the file actually being Matroska, since
   * mkvpropedit fails outright on anything else.
   */
  healStatistics: boolean;
}

// --- video ------------------------------------------------------------------

/**
 * One hardware encoder, selected by matching a flow variable. The reference
 * pipeline branches on the node's own name (`Nvidia`, `Intel`), which is how
 * Tdarr flows route work to whichever machine picked the job up.
 */
export interface HardwareBranch {
  label: string;
  /** e.g. `{{{args.configVars.config.nodeName}}}`. */
  flowVariable: string;
  equals: string;
  pluginSourceId: string;
}

export type VideoEncoder =
  | {
    kind: 'classic';
    /** Tried in order; the first matching branch wins. */
    branches: HardwareBranch[];
    /** Used when no branch matches, and as the landing spot for a branch failure. */
    fallbackPluginSourceId: string;
    /** Wire each hardware encoder's err1 to the fallback encoder. */
    errorFallsBackToCpu: boolean;
  }
  | {
    kind: 'ffmpeg';
    hardware: 'auto' | 'nvenc' | 'rkmpp' | 'qsv' | 'vaapi' | 'videotoolbox' | 'cpu';
    preset?:
      | 'veryslow'
      | 'slower'
      | 'slow'
      | 'medium'
      | 'fast'
      | 'faster'
      | 'veryfast'
      | 'superfast'
      | 'ultrafast';
    quality?: number;
    tenBit?: boolean;
    hdrToSdr?: boolean;
    cropBlackBars?: boolean;
  };

/**
 * `compareFileSizeRatio` guard. A transcode that produces a *larger* file has
 * cost time and gained nothing, and one that produces an implausibly small file
 * has probably lost something - both are reasons to keep the original.
 */
export interface SizeGuard {
  enabled: boolean;
  /** Percentage of the original. */
  greaterThan: number;
  lessThan: number;
  onFail: 'keepOriginal' | 'continue';
}

export interface VideoStep {
  mode: 'leave' | 'transcode';
  targetCodec: 'hevc' | 'h264' | 'av1';
  /** `checkVideoCodec` gate, so an already-converted file skips the encode. */
  skipIfAlreadyTarget: boolean;
  encoder: VideoEncoder;
  sizeGuard: SizeGuard;
  onEncodeFailure: 'keepOriginal' | 'failFlow';
}

// --- tracks -----------------------------------------------------------------

export type TracksImplementation =
  | { kind: 'classic'; pluginSourceId: string; inputs: Record<string, string> }
  | {
    kind: 'ffmpeg';
    removeSubtitles?: boolean;
    removeDataStreams?: boolean;
    removeByProperty?: Array<{
      codecType: 'video' | 'audio' | 'subtitle' | 'any';
      propertyToCheck: string;
      valuesToRemove: string;
      condition: 'equals' | 'not_equals';
    }>;
  };

export interface TracksStep {
  mode: 'leave' | 'clean';
  implementation: TracksImplementation;
}

// --- audio ------------------------------------------------------------------

export interface AudioTarget {
  channels: number;
  /** Omit to let the encoder choose. */
  bitrate?: string;
  /** Omit to leave the source rate alone, which is almost always right. */
  samplerate?: string;
  /**
   * Source channel counts that select this target. The reference pipeline reads
   * 4-8 as surround and 2-3 as stereo, checked in order with mono as the
   * fallthrough.
   */
  matchChannels?: number[];
}

export interface AudioStep {
  mode: 'leave' | 'ensure';
  /** e.g. `eac3`. */
  encoder: string;
  language: string;
  surround?: AudioTarget;
  stereo?: AudioTarget;
  mono?: AudioTarget;
  /**
   * Always add a stereo track alongside a surround one, so a device that cannot
   * downmix still has something to play.
   */
  stereoMate: boolean;
  /** A Local flow plugin run after the ensure steps, e.g. to prune duplicates. */
  normalise?: {
    pluginName: string;
    version: string;
    inputs: Record<string, string>;
    outputs: number;
  };
  reorder?: { processOrder: 'streamTypes'; streamTypes: string };
}

// --- output -----------------------------------------------------------------

export type Destination =
  | { kind: 'replaceOriginal' }
  | { kind: 'moveToDirectory'; directory: string; keepRelative: boolean }
  | { kind: 'copyToDirectory'; directory: string; keepRelative: boolean };

export type Notification =
  | { kind: 'apprise'; command: string; apprisePath?: string }
  | {
    kind: 'webRequest';
    url: string;
    method: 'get' | 'post' | 'put' | 'delete';
    headers?: string;
    body?: string;
  }
  | { kind: 'radarrSonarr'; arr: 'radarr' | 'sonarr'; url: string; apiKey: string };

export interface OutputStep {
  /**
   * Rebuild Matroska statistics after the file changed. Gated on the output
   * actually being Matroska and on the file having changed at all.
   */
  restampStatistics: boolean;
  destination: Destination;
  notifications: Notification[];
  requeue?:
    | { kind: 'tags'; customQueueTags: string }
    | { kind: 'goToFlow'; flowId: string };
}

// --- policy -----------------------------------------------------------------

export interface PolicyStep {
  /**
   * What happens after a node that can fail actually does.
   * `reset-and-continue` clears the failure and carries on with the file as it
   * stands - the reference pipeline's approach, and the only one that does not
   * throw away work already done.
   */
  errorHandling: 'reset-and-continue' | 'keep-original' | 'fail-flow' | 'none';
  layout?: LayoutOptions;
}

// --- advanced escape hatch --------------------------------------------------

export type ExtraAnchor =
  | 'afterSource'
  | 'afterContainer'
  | 'afterVideo'
  | 'afterTracks'
  | 'afterAudio'
  | 'beforeOutput';

/**
 * A node the wizard has no opinion about - either added deliberately from the
 * plugin picker, or recovered from an imported flow no matcher understood.
 *
 * `frozen` is what makes a failed import non-destructive: the node's original
 * position and edges are carried verbatim, so recompiling reproduces them rather
 * than quietly dropping the part of the flow we could not interpret.
 */
export interface ExtraNode {
  id: string;
  pluginName: string;
  version: string;
  sourceRepo: 'Community' | 'Local';
  name?: string;
  inputs: Record<string, string>;
  anchor: ExtraAnchor;
  /** Declared shape, for anything not in the catalog. */
  shape?: { outputs: number; error?: boolean; terminal?: boolean };
  frozen?: { position: { x: number; y: number }; edges: FlowEdge[] };
}

// --- the spec ---------------------------------------------------------------

export interface FlowSpec {
  specVersion: number;
  meta: {
    name: string;
    description?: string;
    tags?: string;
    priority?: number;
    flowId?: string;
  };
  source: SourceStep;
  container: ContainerStep;
  video: VideoStep;
  tracks: TracksStep;
  audio: AudioStep;
  output: OutputStep;
  policy: PolicyStep;
  extras: ExtraNode[];
}

export class SpecVersionError extends Error {
  readonly found: unknown;

  constructor(found: unknown) {
    super(
      `unsupported spec version ${JSON.stringify(found)}; this build understands `
        + `version ${SPEC_VERSION}`,
    );
    this.name = 'SpecVersionError';
    this.found = found;
  }
}
