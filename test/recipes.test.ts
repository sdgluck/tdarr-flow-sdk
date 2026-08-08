/**
 * Each recipe on its own. The golden test proves they compose into a real
 * pipeline; these pin down what each one does in isolation, and in particular
 * that turning a step off produces no nodes rather than inert ones.
 */

import { describe, expect, it } from 'vitest';
import {
  cleanTracks,
  compileFlow,
  compileSpec,
  flow,
  lint,
  newSpec,
  normalizeAudio,
  plugins,
  remuxContainer,
  sourceFile,
  transcodeVideo,
} from '../src/index.ts';
import type { FlowSpec, Segment } from '../src/index.ts';
import { pipelineSpec } from './pipelineSpec.ts';

const build = (segment: Segment) =>
  flow('recipe').start(plugins.inputFile()).then(segment).build();

const pluginNames = (segment: Segment) =>
  build(segment).flowPlugins.map((n) => n.pluginName).slice(1);

describe('recipes that are switched off', () => {
  it('add nothing at all', () => {
    expect(pluginNames(remuxContainer({ ...pipelineSpec.container, mode: 'leave' }))).toEqual([]);
    expect(pluginNames(transcodeVideo({ ...pipelineSpec.video, mode: 'leave' }))).toEqual([]);
    expect(pluginNames(cleanTracks({ ...pipelineSpec.tracks, mode: 'leave' }))).toEqual([]);
    expect(pluginNames(normalizeAudio({ ...pipelineSpec.audio, mode: 'leave' }))).toEqual([]);
  });
});

describe('sourceFile', () => {
  it('omits a gate rather than adding one that always passes', () => {
    expect(pluginNames(sourceFile({
      requireMedium: 'any',
      extensions: { mode: 'any', list: [] },
      minSizeMb: 0,
    }))).toEqual([]);
  });

  it('chains the gates it is asked for', () => {
    expect(pluginNames(sourceFile({
      requireMedium: 'video',
      extensions: { mode: 'include', list: ['mkv', 'mp4'] },
      minSizeMb: 50,
    }))).toEqual(['checkFileMedium', 'checkFileExtension', 'checkFileSize']);
  });
});

describe('remuxContainer', () => {
  it('escalates to the forced rebuild on failure', () => {
    const json = build(remuxContainer(pipelineSpec.container));
    const forced = json.flowPlugins.find((n) => n.name === 'Force Remux')!;
    const primary = json.flowPlugins.find((n) => n.name === 'Remux & Heal Container')!;

    const errorEdge = json.flowEdges.find((e) =>
      e.source === primary.id && e.sourceHandle === 'err1'
    )!;
    const reset = json.flowPlugins.find((n) => n.id === errorEdge.target)!;
    expect(reset.pluginName).toBe('resetFlowError');
    expect(json.flowEdges.some((e) => e.source === reset.id && e.target === forced.id)).toBe(true);
  });

  it('gates the statistics repair on the file being Matroska', () => {
    // mkvpropedit fails outright on anything else, so an unconditional call
    // would turn a successful remux into a flow error.
    const json = build(remuxContainer(pipelineSpec.container));
    for (const propEdit of json.flowPlugins.filter((n) => n.pluginName === 'runMkvPropEdit')) {
      const incoming = json.flowEdges.filter((e) => e.target === propEdit.id);
      const sources = incoming.map((e) => json.flowPlugins.find((n) => n.id === e.source)!);
      expect(sources.every((n) => n.pluginName === 'checkFileExtension')).toBe(true);
    }
  });

  it('skips the whole fallback when none is configured', () => {
    const names = pluginNames(remuxContainer({
      ...pipelineSpec.container,
      method: { kind: 'classic', pluginSourceId: 'Local:X' },
    }));
    expect(names.filter((n) => n === 'runClassicTranscodePlugin')).toHaveLength(1);
  });
});

describe('transcodeVideo', () => {
  const json = build(transcodeVideo(pipelineSpec.video));

  it('routes each hardware branch to its own encoder', () => {
    expect(json.flowPlugins.filter((n) => n.pluginName === 'checkFlowVariable')).toHaveLength(2);
    expect(json.flowPlugins.filter((n) => n.name?.startsWith('Transcode HEVC'))).toHaveLength(3);
  });

  it('falls back to the CPU encoder when hardware fails', () => {
    const cpu = json.flowPlugins.find((n) => n.name === 'Transcode HEVC (CPU)')!;
    const errorEdges = json.flowEdges.filter((e) => e.sourceHandle === 'err1' && e.target === cpu.id);
    expect(errorEdges).toHaveLength(2);
  });

  it('restores the original when the size guard rejects the result', () => {
    const compare = json.flowPlugins.find((n) => n.pluginName === 'compareFileSizeRatio')!;
    expect(compare.version).toBe('2.0.0');
    const outOfRange = json.flowEdges.find((e) =>
      e.source === compare.id && e.sourceHandle === '3'
    )!;
    expect(json.flowPlugins.find((n) => n.id === outOfRange.target)!.pluginName)
      .toBe('setOriginalFile');
  });

  it('can fail the flow instead of keeping the original', () => {
    const names = pluginNames(transcodeVideo({
      ...pipelineSpec.video,
      onEncodeFailure: 'failFlow',
    }));
    expect(names).toContain('failFlow');
  });
});

describe('normalizeAudio', () => {
  const json = build(normalizeAudio(pipelineSpec.audio, pipelineSpec.container));
  const byId = new Map(json.flowPlugins.map((n) => [n.id, n]));

  it('builds one ffmpeg command block, not one per branch', () => {
    expect(json.flowPlugins.filter((n) => n.pluginName === 'ffmpegCommandStart')).toHaveLength(1);
    expect(json.flowPlugins.filter((n) => n.pluginName === 'ffmpegCommandExecute')).toHaveLength(1);
  });

  it('checks surround before stereo', () => {
    // A file with both a 5.1 and a stereo track is a surround file; asking the
    // other way round would mislabel it.
    const gates = json.flowPlugins.filter((n) => n.pluginName === 'checkStreamProperty');
    expect(gates.map((n) => n.name)).toEqual(['Surround Present?', 'Stereo Present?']);
  });

  it('gives a surround track a stereo mate', () => {
    const surround = json.flowPlugins.find((n) => n.name?.includes('Surround'))!;
    const next = json.flowEdges.find((e) => e.source === surround.id)!;
    expect(byId.get(next.target)!.name).toContain('Stereo');
  });

  it('converges every branch even without a local normaliser', () => {
    // Without one there is no natural meeting point, and returning a single
    // branch would leave the others dangling: a mono file would reach its
    // encoder and stop, never reaching Execute, and the flow would report
    // success having done nothing.
    const { normalise: _normalise, ...withoutNormaliser } = pipelineSpec.audio;
    const json = build(normalizeAudio(withoutNormaliser, pipelineSpec.container));

    const execute = json.flowPlugins.find((n) => n.pluginName === 'ffmpegCommandExecute')!;
    const reorder = json.flowPlugins.find((n) => n.pluginName === 'ffmpegCommandRorderStreams')!;

    for (const ensure of json.flowPlugins.filter((n) =>
      n.pluginName === 'ffmpegCommandEnsureAudioStream'
    )) {
      const onward = json.flowEdges.filter((e) => e.source === ensure.id);
      expect(onward.length, `${ensure.name} goes nowhere`).toBeGreaterThan(0);
    }

    // And everything still funnels into the one Execute.
    expect(json.flowEdges.filter((e) => e.target === reorder.id).length).toBeGreaterThan(1);
    expect(json.flowEdges.filter((e) => e.target === execute.id)).toHaveLength(1);
  });

  it('sends every audio path through the local normaliser', () => {
    const norm = json.flowPlugins.find((n) => n.pluginName === 'normaliseAudioTracks')!;
    expect(norm.sourceRepo).toBe('Local');
    expect(json.flowEdges.filter((e) => e.target === norm.id)).toHaveLength(2);
  });
});

describe('compileFlow stages', () => {
  const { flow, stages } = compileFlow(pipelineSpec);

  it('attributes every node to a stage', () => {
    const untagged = flow.flowPlugins.filter((n) => !stages[n.id]).map((n) => n.name);
    expect(untagged).toEqual([]);
  });

  it('puts each node under the step that decided it', () => {
    const named = (stage: string) =>
      flow.flowPlugins.filter((n) => stages[n.id] === stage).map((n) => n.pluginName);

    expect(named('source')).toEqual(['inputFile', 'checkFileMedium']);
    expect(named('container')).toContain('runMkvPropEdit');
    expect(named('video')).toContain('compareFileSizeRatio');
    expect(named('audio')).toContain('ffmpegCommandEnsureAudioStream');
    expect(named('output')).toContain('replaceOriginalFile');
  });

  it('groups advanced nodes separately from the stage they sit between', () => {
    const spec = newSpec('Extras');
    spec.extras = [{
      id: 'extra0001',
      pluginName: 'runHealthCheck',
      version: '1.0.0',
      sourceRepo: 'Community',
      inputs: {},
      anchor: 'afterSource',
    }];
    expect(compileFlow(spec).stages['extra0001']).toBe('advanced');
  });

  it('does not change the flow it compiles', () => {
    expect(flow).toEqual(compileSpec(pipelineSpec));
  });
});

describe('compileSpec', () => {
  it('produces a lint-clean flow from an all-defaults spec', () => {
    const spec = newSpec('Empty');
    const json = compileSpec(spec);
    expect(lint(json).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('rejects a spec from a version it does not understand', () => {
    const future = { ...newSpec(), specVersion: 99 } as unknown as FlowSpec;
    expect(() => compileSpec(future)).toThrow(/unsupported spec version/);
  });

  it('splices extras at their anchor', () => {
    const spec = newSpec('Extras');
    spec.extras = [{
      id: 'extra0001',
      pluginName: 'runHealthCheck',
      version: '1.0.0',
      sourceRepo: 'Community',
      inputs: {},
      anchor: 'afterSource',
    }];
    const names = compileSpec(spec).flowPlugins.map((n) => n.pluginName);
    expect(names).toContain('runHealthCheck');
    expect(names.indexOf('runHealthCheck')).toBeLessThan(names.indexOf('replaceOriginalFile'));
  });
});
