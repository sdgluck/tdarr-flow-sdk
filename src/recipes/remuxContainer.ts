import * as plugins from '../catalog/factories.generated.ts';
import { Junction } from '../graph/builder.ts';
import type { Cursor, Exit } from '../graph/builder.ts';
import { ffmpegCommand } from '../graph/ffmpegCommand.ts';
import type { ContainerStep } from '../types/spec.ts';
import { recipe, withCustomArguments } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * Get the file into the target container, and repair it on the way.
 *
 * The shape here is "try, and if that fails try harder": a normal remux copies
 * streams across, and when that fails - which it does on files with damaged
 * indexes - a forced rebuild re-encodes the container from scratch. The failure
 * of the *fallback* is not fatal either; the error is reset and the flow
 * continues with whatever it has, because a container that could not be fixed is
 * still a file worth transcoding.
 *
 * `healStatistics` exists because remuxing invalidates Matroska's duration and
 * bitrate tags, which leaves players showing nonsense. `mkvpropedit` rewrites
 * them, but fails outright on anything that is not Matroska - hence the
 * extension gate in front of it rather than an unconditional call.
 */
export function remuxContainer(step: ContainerStep): Recipe {
  return recipe('remuxContainer', step, (entry) => {
    if (step.mode === 'leave') return entry;

    if (step.method.kind === 'ffmpeg') {
      const { forceConform, customArguments } = step.method;
      const block = ffmpegCommand().container(
        { container: step.target, forceConform },
        { name: `Force ${step.target.toUpperCase()} Container` },
      );
      withCustomArguments(block, customArguments);
      return entry.then(block);
    }

    const builder = entry.builder;
    const exits: Exit[] = [];
    const method = step.method;

    /** `Is MKV? -> mkvpropedit`, with the gate's other branch skipping straight out. */
    const heal = (from: Cursor, onPropEditFailure?: (cursor: Cursor) => void): void => {
      if (!step.healStatistics || step.target !== 'mkv') {
        exits.push({ id: from.id, handle: from.handle });
        return;
      }
      const gate = from.then(
        plugins.checkFileExtension({ extensions: step.target }, { name: 'Is MKV?' }),
      );
      const propEdit = gate.on(1, plugins.runMkvPropEdit());
      onPropEditFailure?.(propEdit.at('err1'));

      exits.push({ id: propEdit.id, handle: 1 });
      exits.push({ id: gate.id, handle: 2 });
    };

    const attempt = (pluginSourceId: string, name: string, inputs?: Record<string, string>) =>
      entry.builder.add(
        plugins.runClassicTranscodePlugin({ pluginSourceId, ...inputs }, { name }),
      );

    const primary = entry.then(
      plugins.runClassicTranscodePlugin(
        { pluginSourceId: method.pluginSourceId, ...method.inputs },
        { name: 'Remux & Heal Container' },
      ),
    );

    if (!method.fallbackPluginSourceId) {
      // Nothing more aggressive to try, so a failure is reset and the original
      // file carries on to the next stage.
      const reset = primary.onError(plugins.resetFlowError({}, { offSpine: true }));
      exits.push({ id: reset.id, handle: 1 });
      // Handle 1 remuxed, handle 2 decided it was already conformant.
      heal(primary.at(1));
      exits.push({ id: primary.id, handle: 2 });
      return new Junction(builder, exits);
    }

    const forced = attempt(method.fallbackPluginSourceId, 'Force Remux', method.fallbackInputs);
    const toForced = builder.add(plugins.resetFlowError({}, { offSpine: true }));
    builder.connect(toForced.id, 1, forced.id);

    // Both the remux itself failing and the statistics repair failing mean the
    // container is worse than it looked, so both escalate to the forced rebuild.
    primary.at('err1').join(toForced);
    heal(primary.at(1), (failure) => failure.join(toForced));
    exits.push({ id: primary.id, handle: 2 });

    const forcedFailure = builder.add(plugins.resetFlowError({}, { offSpine: true }));
    forced.at('err1').join(forcedFailure);
    exits.push({ id: forcedFailure.id, handle: 1 });

    // After a forced rebuild the statistics are suspect whichever way the plugin
    // reported, so both handles go through the repair rather than only handle 1.
    // One junction, so they share a single gate instead of building two.
    heal(
      new Junction(builder, [
        { id: forced.id, handle: 1 },
        { id: forced.id, handle: 2 },
      ]),
      (failure) => failure.join(forcedFailure),
    );

    return new Junction(builder, exits);
  });
}
