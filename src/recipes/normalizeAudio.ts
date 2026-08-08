import * as plugins from '../catalog/factories.generated.ts';
import { localNode } from '../graph/builder.ts';
import type { Cursor } from '../graph/builder.ts';
import { ffmpegCommand } from '../graph/ffmpegCommand.ts';
import type { AudioStep, AudioTarget, ContainerStep } from '../types/spec.ts';
import { recipe, withCustomArguments } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * The audio stage: guarantee a track in the wanted codec, at a layout that
 * matches what the source actually has.
 *
 * The branching matters. Encoding a stereo source to 5.1 invents channels;
 * encoding a 5.1 source to stereo throws them away. So the flow asks what the
 * source *is* and picks a target to match, checking surround first because a
 * file with both should be treated as surround.
 *
 * `stereoMate` then adds a stereo track alongside a surround one - a phone or a
 * TV speaker cannot downmix E-AC3 5.1, and gets silence without it. That is why
 * the surround path falls through into the stereo node rather than skipping it.
 *
 * All of this happens inside one ffmpeg command block. Splitting it into
 * separate blocks would re-encode the file once per branch.
 */
export function normalizeAudio(step: AudioStep, container?: ContainerStep): Recipe {
  return recipe('normalizeAudio', step, (entry) => {
    if (step.mode === 'leave') return entry;

    const encoderInputs = (target: AudioTarget) => ({
      audioEncoder: step.encoder as 'eac3',
      language: step.language,
      channels: target.channels as 6,
      enableBitrate: Boolean(target.bitrate),
      ...(target.bitrate ? { bitrate: target.bitrate } : {}),
      enableSamplerate: Boolean(target.samplerate),
      ...(target.samplerate ? { samplerate: target.samplerate } : { samplerate: '48k' }),
    });

    const label = (target: AudioTarget, kind: string) =>
      `Ensure ${step.encoder.toUpperCase().replace('EAC3', 'E-AC3')} ${kind}`
      + (target.bitrate ? ` ${target.bitrate}` : '');

    const block = ffmpegCommand();

    // The container has to be set inside the block: an ffmpeg command that adds
    // an E-AC3 track to an MP4 produces a file nothing will play.
    if (container && container.mode !== 'leave') {
      block.container(
        { container: container.target, forceConform: false },
        { name: `Force ${container.target.toUpperCase()} Container` },
      );
    }

    block.branch((cursor) => {
      const builder = cursor.builder;

      const stereo = step.stereo
        ? builder.add(plugins.ffmpegCommandEnsureAudioStream(
          encoderInputs(step.stereo),
          { name: label(step.stereo, 'Stereo') },
        ))
        : undefined;
      const mono = step.mono
        ? builder.add(plugins.ffmpegCommandEnsureAudioStream(
          encoderInputs(step.mono),
          { name: label(step.mono, 'Mono') },
        ))
        : undefined;
      const surround = step.surround
        ? builder.add(plugins.ffmpegCommandEnsureAudioStream(
          encoderInputs(step.surround),
          { name: label(step.surround, 'Surround') },
        ))
        : undefined;

      /** Where every branch lands: the optional local normaliser, or nothing. */
      const converge = step.normalise
        ? builder.add(localNode({
          pluginName: step.normalise.pluginName,
          version: step.normalise.version,
          outputs: step.normalise.outputs,
          name: 'Normalise Audio Tracks',
          inputs: step.normalise.inputs,
        }))
        : undefined;

      const channelGate = (target: AudioTarget, name: string) =>
        plugins.checkStreamProperty({
          streamType: 'audio',
          propertyToCheck: 'channels',
          valuesToMatch: (target.matchChannels ?? []).join(','),
          condition: 'equals',
        }, { name });

      // Surround first: a file with a 5.1 track and a stereo track is a surround
      // file, and asking the other way round would mislabel it.
      let head: Cursor = cursor;
      let tail: Cursor | undefined;

      if (surround && step.surround?.matchChannels?.length) {
        const gate = head.then(channelGate(step.surround, 'Surround Present?'));
        gate.on(1, surround);
        head = gate.at(2);
        // The stereo mate: surround continues into the stereo node instead of
        // going straight to the join.
        if (stereo && step.stereoMate) surround.then(stereo);
        else tail = surround;
      }

      if (stereo && mono && step.stereo?.matchChannels?.length) {
        const gate = head.then(channelGate(step.stereo, 'Stereo Present?'));
        gate.on(1, stereo);
        gate.on(2, mono);
      } else if (stereo) {
        head.then(stereo);
      } else if (mono) {
        head.then(mono);
      }

      if (!converge) return tail ?? stereo ?? mono ?? surround ?? head;

      for (const source of [stereo, mono, tail]) source?.then(converge);
      return converge;
    });

    if (step.reorder) {
      block.reorderStreams(
        { processOrder: step.reorder.processOrder, streamTypes: step.reorder.streamTypes },
        { name: 'Reorder Streams' },
      );
    }

    withCustomArguments(block, step.customArguments);
    return entry.then(block);
  });
}
