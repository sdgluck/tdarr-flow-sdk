import * as plugins from '../catalog/factories.generated.ts';
import { Junction } from '../graph/builder.ts';
import type { Exit } from '../graph/builder.ts';
import { ffmpegCommand } from '../graph/ffmpegCommand.ts';
import type { TracksStep } from '../types/spec.ts';
import { recipe } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * Drop tracks nobody wants - foreign-language audio, commentary, forced-only
 * subtitles.
 *
 * A failure here is reset rather than fatal. Track pruning is a nicety; losing
 * it is not a reason to throw away a transcode that already happened.
 */
export function cleanTracks(step: TracksStep): Recipe {
  return recipe('cleanTracks', step, (entry) => {
    if (step.mode === 'leave') return entry;

    if (step.implementation.kind === 'ffmpeg') {
      const config = step.implementation;
      const block = ffmpegCommand();
      if (config.removeSubtitles) block.removeSubtitles();
      if (config.removeDataStreams) block.removeDataStreams();
      for (const rule of config.removeByProperty ?? []) {
        block.removeStreamByProperty({
          codecType: rule.codecType,
          propertyToCheck: rule.propertyToCheck,
          valuesToRemove: rule.valuesToRemove,
          condition: rule.condition,
        });
      }
      return entry.then(block);
    }

    const builder = entry.builder;
    const config = step.implementation;
    const clean = entry.then(plugins.runClassicTranscodePlugin(
      { pluginSourceId: config.pluginSourceId, ...config.inputs },
      { name: 'Remove Non English Tracks' },
    ));

    const reset = clean.onError(plugins.resetFlowError({}, { offSpine: true }));

    const exits: Exit[] = [
      { id: clean.id, handle: 1 },
      { id: clean.id, handle: 2 },
      { id: reset.id, handle: 1 },
    ];
    return new Junction(builder, exits);
  });
}
