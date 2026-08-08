import * as plugins from '../catalog/factories.generated.ts';
import { Junction } from '../graph/builder.ts';
import type { Cursor, Exit } from '../graph/builder.ts';
import { ffmpegCommand } from '../graph/ffmpegCommand.ts';
import type { VideoStep } from '../types/spec.ts';
import { recipe, withCustomArguments } from './types.ts';
import type { Recipe } from './types.ts';

const CODEC_TITLE: Record<VideoStep['targetCodec'], string> = {
  hevc: 'HEVC',
  h264: 'H264',
  av1: 'AV1',
};

/**
 * The video encode, with hardware selection and two independent safety nets.
 *
 * The hardware branches exist because a Tdarr library is worked by whichever
 * node picks up the job, and they do not all have the same encoder. So the flow
 * asks which machine it is running on and routes accordingly, with a CPU encoder
 * as the answer when nothing matches.
 *
 * Net one is `errorFallsBackToCpu`: a hardware encoder that fails hands the file
 * to the CPU encoder rather than failing the job. Hardware encoding fails for
 * ordinary reasons - a driver that will not initialise, an unsupported pixel
 * format - and none of them mean the file cannot be encoded at all.
 *
 * Net two is the size guard. A transcode that produced a *larger* file spent an
 * hour to make things worse; one that produced an implausibly small file
 * probably dropped something. Either way the original is the better artefact,
 * which is what `setOriginalFile` restores.
 */
export function transcodeVideo(step: VideoStep): Recipe {
  return recipe('transcodeVideo', step, (entry) => {
    if (step.mode === 'leave') return entry;

    const builder = entry.builder;
    const exits: Exit[] = [];
    const title = CODEC_TITLE[step.targetCodec];

    let cursor: Cursor = entry;
    if (step.skipIfAlreadyTarget) {
      const gate = entry.then(
        plugins.checkVideoCodec({ codec: step.targetCodec }, { name: `Is ${title}?` }),
      );
      // Handle 1: already the target codec, so skip the whole stage.
      exits.push({ id: gate.id, handle: 1 });
      cursor = gate.at(2);
    }

    if (step.encoder.kind === 'ffmpeg') {
      const encoder = step.encoder;
      const block = ffmpegCommand().videoEncoder({
        outputCodec: step.targetCodec,
        // `cpu` is the absence of hardware encoding, not a hardware type.
        hardwareEncoding: encoder.hardware !== 'cpu',
        ...(encoder.hardware !== 'cpu' ? { hardwareType: encoder.hardware } : {}),
        ...(encoder.preset ? { ffmpegPresetEnabled: true, ffmpegPreset: encoder.preset } : {}),
        ...(encoder.quality !== undefined
          ? { ffmpegQualityEnabled: true, ffmpegQuality: encoder.quality }
          : {}),
      });
      if (encoder.tenBit) block.tenBit();
      if (encoder.hdrToSdr) block.hdrToSdr();
      if (encoder.cropBlackBars) block.cropBlackBars();
      withCustomArguments(block, encoder.customArguments);

      const done = cursor.then(block);
      return finish(done, exits);
    }

    // --- classic encoders, selected by flow variable -------------------------

    const encoder = step.encoder;
    const fallback = builder.add(
      plugins.runClassicTranscodePlugin(
        { pluginSourceId: encoder.fallbackPluginSourceId, ...encoder.fallbackInputs },
        { name: `Transcode ${title} (CPU)` },
      ),
    );

    const encoders: Cursor[] = [];
    let selector: Cursor = cursor;

    encoder.branches.forEach((branch, index) => {
      const test = selector.then(
        plugins.checkFlowVariable(
          { variable: branch.flowVariable, value: branch.equals },
          { name: `${branch.label}?` },
        ),
      );
      const hardware = test.on(1, plugins.runClassicTranscodePlugin(
        { pluginSourceId: branch.pluginSourceId, ...branch.inputs },
        { name: `Transcode ${title} (${branch.label})` },
      ));
      encoders.push(hardware);

      const isLast = index === encoder.branches.length - 1;
      if (isLast) test.at(2).join(fallback);
      else selector = test.at(2);
    });

    if (!encoder.branches.length) selector.join(fallback);

    for (const hardware of encoders) {
      if (encoder.errorFallsBackToCpu) hardware.at('err1').join(fallback);
    }

    // Every encoder reports handle 1 (transcoded) or 2 (declined); both are a
    // legitimate way to arrive at the size check.
    const attempted = new Junction(builder, [...encoders, fallback].flatMap((c) => [
      { id: c.id, handle: 1 as const },
      { id: c.id, handle: 2 as const },
    ]));

    return finish(attempted, exits, fallback);

    function finish(from: Cursor, collected: Exit[], failing?: Cursor): Cursor {
      const keepOriginal = () =>
        builder.add(plugins.setOriginalFile({}, { name: 'Set Original File' }));

      let restore: Cursor | undefined;

      if (step.sizeGuard.enabled) {
        const compare = from.then(plugins.compareFileSizeRatio({
          greaterThan: step.sizeGuard.greaterThan,
          lessThan: step.sizeGuard.lessThan,
        }));
        // 1 and 2 are "within range"; 3 is "outside it".
        collected.push({ id: compare.id, handle: 1 });
        collected.push({ id: compare.id, handle: 2 });

        if (step.sizeGuard.onFail === 'keepOriginal') {
          restore = keepOriginal();
          compare.at(3).join(restore);
        } else {
          collected.push({ id: compare.id, handle: 3 });
        }
      } else {
        collected.push({ id: from.id, handle: from.handle });
      }

      if (failing) {
        if (step.onEncodeFailure === 'failFlow') {
          failing.at('err1').then(plugins.failFlow({}, { offSpine: true }));
        } else {
          restore ??= keepOriginal();
          const reset = failing.onError(plugins.resetFlowError({}, { offSpine: true }));
          reset.join(restore);
        }
      }

      if (restore) collected.push({ id: restore.id, handle: 1 });
      return new Junction(builder, collected);
    }
  });
}
