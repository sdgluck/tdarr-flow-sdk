/**
 * `FlowSpec` -> `FlowJson`.
 *
 * Deliberately a straight line. Every branch, convergence and error path lives
 * inside a recipe; this file only says what order the stages come in. If
 * something here starts needing a conditional, it belongs in a recipe instead -
 * that separation is what lets each recipe be snapshot-tested on its own.
 */

import { flow } from '../graph/builder.ts';
import { embedSpec } from '../graph/serialize.ts';
import type { FlowJson } from '../types/flow.ts';
import { SPEC_VERSION, SpecVersionError } from '../types/spec.ts';
import type { FlowSpec } from '../types/spec.ts';
import { cleanTracks } from './cleanTracks.ts';
import { extrasSegment } from './extras.ts';
import { finalise } from './finalise.ts';
import { normalizeAudio } from './normalizeAudio.ts';
import { remuxContainer } from './remuxContainer.ts';
import { sourceFile } from './sourceFile.ts';
import { transcodeVideo } from './transcodeVideo.ts';
import * as plugins from '../catalog/factories.generated.ts';

export interface CompileOptions {
  /**
   * Embed the spec in the flow's description, so re-importing recovers it
   * exactly instead of guessing structurally. Off by default: it is only useful
   * if Tdarr preserves `description` through import/export, which is a property
   * of the server, not of this library.
   */
  embed?: boolean;
}

export function compileSpec(spec: FlowSpec, options: CompileOptions = {}): FlowJson {
  if (spec.specVersion !== SPEC_VERSION) throw new SpecVersionError(spec.specVersion);

  const description = options.embed
    ? embedSpec(spec.meta.description, spec, SPEC_VERSION)
    : spec.meta.description;

  const builder = flow(spec.meta.name, {
    ...(spec.meta.flowId ? { id: spec.meta.flowId } : {}),
    ...(spec.meta.priority !== undefined ? { priority: spec.meta.priority } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(spec.meta.tags !== undefined ? { tags: spec.meta.tags } : {}),
    ...(spec.policy.layout ? { layout: spec.policy.layout } : {}),
  });

  builder
    .start(plugins.inputFile())
    .then(sourceFile(spec.source))
    .then(extrasSegment(spec.extras, 'afterSource'))
    .then(remuxContainer(spec.container))
    .then(extrasSegment(spec.extras, 'afterContainer'))
    .then(transcodeVideo(spec.video))
    .then(extrasSegment(spec.extras, 'afterVideo'))
    .then(cleanTracks(spec.tracks))
    .then(extrasSegment(spec.extras, 'afterTracks'))
    .then(normalizeAudio(spec.audio, spec.container))
    .then(extrasSegment(spec.extras, 'afterAudio'))
    .then(extrasSegment(spec.extras, 'beforeOutput'))
    .then(finalise(spec.output, spec.container));

  return builder.build();
}

/** A spec with every step off - the starting point the wizard fills in. */
export function newSpec(name = 'New Flow'): FlowSpec {
  return {
    specVersion: SPEC_VERSION,
    meta: { name },
    source: { requireMedium: 'video', extensions: { mode: 'any', list: [] }, minSizeMb: 0 },
    container: { mode: 'leave', target: 'mkv', method: { kind: 'ffmpeg', forceConform: false }, healStatistics: false },
    video: {
      mode: 'leave',
      targetCodec: 'hevc',
      skipIfAlreadyTarget: true,
      encoder: { kind: 'ffmpeg', hardware: 'auto' },
      sizeGuard: { enabled: false, greaterThan: 0, lessThan: 100, onFail: 'keepOriginal' },
      onEncodeFailure: 'keepOriginal',
    },
    tracks: { mode: 'leave', implementation: { kind: 'ffmpeg' } },
    audio: { mode: 'leave', encoder: 'eac3', language: 'eng', stereoMate: false },
    output: { restampStatistics: false, destination: { kind: 'replaceOriginal' }, notifications: [] },
    policy: { errorHandling: 'reset-and-continue' },
    extras: [],
  };
}

/**
 * Validates a spec that came from storage or an embedded marker. Throws rather
 * than coercing: a spec from a future version may look close enough to compile
 * while meaning something different, and silently building the wrong flow is
 * worse than refusing.
 */
export function migrateSpec(value: unknown): FlowSpec {
  if (!value || typeof value !== 'object') throw new SpecVersionError(undefined);
  const spec = value as Partial<FlowSpec>;
  if (spec.specVersion !== SPEC_VERSION) throw new SpecVersionError(spec.specVersion);
  return spec as FlowSpec;
}
