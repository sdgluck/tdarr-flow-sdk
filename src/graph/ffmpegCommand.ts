/**
 * The ffmpeg-command block, as a single composable segment.
 *
 * Tdarr's ffmpeg plugins do not each run ffmpeg. Nodes between
 * `ffmpegCommandStart` and `ffmpegCommandExecute` only mark up a pending
 * command - set the container, mark a stream removed, add an encoder - and
 * Execute turns the accumulated markup into one invocation. Getting that wrong
 * (an Execute per operation) means transcoding the file several times over, so
 * the block is modelled as one thing you configure rather than a set of nodes
 * you happen to chain.
 *
 * `.branch()` exists because the interesting flows put decisions *inside* the
 * block: the reference pipeline checks the source's channel layout between
 * setting the container and adding audio streams, and all of that still has to
 * resolve to a single Execute.
 */

import * as plugins from '../catalog/factories.generated.ts';
import type { InputsFor } from '../catalog/inputs.generated.ts';
import type { Attachable, Cursor, NodeOptions, Segment } from './builder.ts';

export interface FfmpegCommandOptions {
  /** Append `ffmpegCommandExecute`. Off only when a caller wires it themselves. */
  execute?: boolean;
  name?: string;
}

type Step = (cursor: Cursor) => Cursor;

export class FfmpegCommandBuilder implements Segment {
  readonly kind = 'segment' as const;

  #steps: Step[] = [];
  #options: FfmpegCommandOptions;

  constructor(options: FfmpegCommandOptions = {}) {
    this.#options = options;
  }

  #add(attachable: Attachable): this {
    this.#steps.push((cursor) => cursor.then(attachable));
    return this;
  }

  // --- container and video --------------------------------------------------

  container(
    inputs: InputsFor<'ffmpegCommandSetContainer@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandSetContainer(inputs, options));
  }

  videoEncoder(
    inputs: InputsFor<'ffmpegCommandSetVideoEncoder@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandSetVideoEncoder(inputs, options));
  }

  videoBitrate(
    inputs: InputsFor<'ffmpegCommandSetVideoBitrate@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandSetVideoBitrate(inputs, options));
  }

  resolution(
    inputs: InputsFor<'ffmpegCommandSetVdeoResolution@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandSetVdeoResolution(inputs, options));
  }

  framerate(
    inputs: InputsFor<'ffmpegCommandSetVdeoFramerate@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandSetVdeoFramerate(inputs, options));
  }

  tenBit(inputs?: InputsFor<'ffmpegCommand10BitVideo@1.0.0'>, options?: NodeOptions): this {
    return this.#add(plugins.ffmpegCommand10BitVideo(inputs, options));
  }

  hdrToSdr(inputs?: InputsFor<'ffmpegCommandHdrToSdr@1.0.0'>, options?: NodeOptions): this {
    return this.#add(plugins.ffmpegCommandHdrToSdr(inputs, options));
  }

  cropBlackBars(
    inputs?: InputsFor<'ffmpegCommandCropBlackBars@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandCropBlackBars(inputs, options));
  }

  // --- audio ----------------------------------------------------------------

  ensureAudio(
    inputs: InputsFor<'ffmpegCommandEnsureAudioStream@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandEnsureAudioStream(inputs, options));
  }

  normalizeAudio(
    inputs?: InputsFor<'ffmpegCommandNormalizeAudio@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandNormalizeAudio(inputs, options));
  }

  // --- stream pruning -------------------------------------------------------

  removeSubtitles(
    inputs?: InputsFor<'ffmpegCommandRemoveSubtitles@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandRemoveSubtitles(inputs, options));
  }

  removeDataStreams(options?: NodeOptions): this {
    return this.#add(plugins.ffmpegCommandRemoveDataStreams(undefined, options));
  }

  removeStreamByProperty(
    inputs: InputsFor<'ffmpegCommandRemoveStreamByProperty@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandRemoveStreamByProperty(inputs, options));
  }

  reorderStreams(
    inputs: InputsFor<'ffmpegCommandRorderStreams@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandRorderStreams(inputs, options));
  }

  custom(
    inputs: InputsFor<'ffmpegCommandCustomArguments@1.0.0'>,
    options?: NodeOptions,
  ): this {
    return this.#add(plugins.ffmpegCommandCustomArguments(inputs, options));
  }

  // --- escape hatches -------------------------------------------------------

  /** Any node at all, for ffmpeg plugins without a named method here. */
  node(attachable: Attachable): this {
    return this.#add(attachable);
  }

  /**
   * Arbitrary graph inside the block. The callback is handed the cursor at the
   * current end of the chain and must return where the chain continues - so all
   * paths through the branch have to converge before Execute.
   */
  branch(fn: Step): this {
    this.#steps.push(fn);
    return this;
  }

  apply(cursor: Cursor): Cursor {
    let current: Cursor = cursor.then(
      plugins.ffmpegCommandStart(undefined, this.#options.name ? { name: this.#options.name } : {}),
    );
    for (const step of this.#steps) current = step(current);
    return this.#options.execute === false ? current : current.then(plugins.ffmpegCommandExecute());
  }
}

export function ffmpegCommand(options?: FfmpegCommandOptions): FfmpegCommandBuilder {
  return new FfmpegCommandBuilder(options);
}
