/**
 * The simulators and the interpreter.
 *
 * The assertions worth having are the ones that fail if someone reimplements a
 * check from its name instead of from the vendored body. Several of these look
 * pedantic and are the entire reason this approach was chosen over re-deriving
 * the predicates from `FlowSpec`.
 */

import { describe, expect, it } from 'vitest';
import { interpret, prepareFlow, project, PROJECTED_KEYS, SIMULATORS } from '../src/simulate/index.ts';
import type { MediaRecord } from '../src/simulate/index.ts';
import type { FlowJson } from '../src/types/flow.ts';

const record = (overrides: Partial<MediaRecord> = {}): MediaRecord => ({
  _id: '/mnt/media/film/Movie (2020)/Movie.mkv',
  DB: 'lib1',
  file_size: 4000,
  fileMedium: 'video',
  video_codec_name: 'hevc',
  audio_codec_name: 'eac3',
  container: 'mkv',
  video_resolution: '1080p',
  ffProbeData: {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'hevc' },
      { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6 },
    ],
  },
  ...overrides,
});

const evaluate = (
  ref: string,
  inputs: Record<string, string | number | boolean>,
  file: MediaRecord,
  variables: Record<string, string> = {},
) => SIMULATORS[ref]!.evaluate(file, inputs, { variables });

/** A linear flow of `[pluginName, version]` pairs, wired 1 -> 1 -> 1. */
function chain(...refs: string[]): FlowJson {
  return {
    _id: 'f1',
    name: 'test',
    flowPlugins: refs.map((ref, index) => {
      const [pluginName, version] = ref.split('@');
      return {
        id: `n${index}`,
        name: pluginName!,
        sourceRepo: 'Community',
        pluginName: pluginName!,
        version: version!,
        fpEnabled: true,
        position: { x: 0, y: index * 100 },
      };
    }),
    flowEdges: refs.slice(1).map((_, index) => ({
      id: `e${index}`,
      source: `n${index}`,
      sourceHandle: '1',
      target: `n${index + 1}`,
      targetHandle: null,
    })),
  } as FlowJson;
}

describe('simulators transcribe the vendored plugin, not the plugin name', () => {
  it('checkFileExtension reads the path, not the container field', () => {
    // The container field says mp4 and the path says mkv. Tdarr's own body calls
    // getContainer(inputFileObj._id), so mkv wins. An implementation that
    // reached for `container` - the obvious field - would return handle 2 here.
    const file = record({ _id: '/x/movie.mkv', container: 'mp4' });
    expect(evaluate('checkFileExtension@1.0.0', { extensions: 'mkv' }, file))
      .toEqual({ kind: 'handle', handle: 1 });
  });

  it('checkFileSize measures decimal MB from file_size, with inclusive bounds', () => {
    // 1000 MB is exactly 1 GB in decimal, and the vendored comparison is `>=`.
    const file = record({ file_size: 1000 });
    expect(evaluate('checkFileSize@1.0.0', { unit: 'GB', greaterThan: 1, lessThan: 10 }, file))
      .toEqual({ kind: 'handle', handle: 1 });
  });

  it('checkVideoCodec reads the streams, not the denormalised codec field', () => {
    const file = record({
      video_codec_name: 'hevc',
      ffProbeData: { streams: [{ codec_type: 'video', codec_name: 'h264' }] },
    });
    expect(evaluate('checkVideoCodec@1.0.0', { codec: 'hevc' }, file))
      .toEqual({ kind: 'handle', handle: 2 });
  });

  it('checkFileMedium throws when the file was never fully scanned', () => {
    const file = record();
    delete file.fileMedium;
    expect(evaluate('checkFileMedium@1.0.0', {}, file))
      .toEqual({ kind: 'threw', reason: 'File has no fileMedium!' });
  });

  it('checkStreamProperty negative conditions ask whether NO stream matches', () => {
    // Two audio streams, one of them eac3. `not_equals` folds with `every`, so
    // the presence of the eac3 stream makes the whole file fail to match.
    // Reading it as "some stream is not eac3" would return handle 1.
    const file = record({
      ffProbeData: {
        streams: [
          { codec_type: 'audio', codec_name: 'eac3' },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      },
    });
    const inputs = {
      streamType: 'audio',
      propertyToCheck: 'codec_name',
      valuesToMatch: 'eac3',
      condition: 'not_equals',
    };
    expect(evaluate('checkStreamProperty@1.0.0', inputs, file))
      .toEqual({ kind: 'handle', handle: 2 });
  });

  it('checkStreamProperty matches audio channels, which is what the audio recipe gates on', () => {
    const surround = record();
    const inputs = {
      streamType: 'audio',
      propertyToCheck: 'channels',
      valuesToMatch: '4,5,6,7,8',
      condition: 'equals',
    };
    expect(evaluate('checkStreamProperty@1.0.0', inputs, surround))
      .toEqual({ kind: 'handle', handle: 1 });

    const stereo = record({
      ffProbeData: { streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 2 }] },
    });
    expect(evaluate('checkStreamProperty@1.0.0', inputs, stereo))
      .toEqual({ kind: 'handle', handle: 2 });
  });

  it('checkFlowVariable resolves only when the worker is bound', () => {
    const inputs = { variable: '{{{args.configVars.config.nodeName}}}', value: 'Nvidia' };
    expect(evaluate('checkFlowVariable@1.0.0', inputs, record()).kind).toBe('unknowable');
    expect(evaluate('checkFlowVariable@1.0.0', inputs, record(), {
      '{{{args.configVars.config.nodeName}}}': 'Nvidia',
    })).toEqual({ kind: 'handle', handle: 1 });
  });
});

describe('the three registry states stay apart', () => {
  it('compareFileSizeRatio is registered, and never returns a handle', () => {
    // Registered-unknowable, not merely absent. The distinction is what lets the
    // report separate "no improvement is possible" from "nobody has done it yet".
    expect(SIMULATORS['compareFileSizeRatio@2.0.0']).toBeDefined();
    expect(evaluate('compareFileSizeRatio@2.0.0', { greaterThan: 40, lessThan: 110 }, record()).kind)
      .toBe('unknowable');
  });

  it('an unmodelled branching plugin stops the walk rather than guessing handle 1', () => {
    const flow = chain('checkVideoBitrate@1.0.0', 'replaceOriginalFile@1.0.0');
    flow.flowEdges.push({
      id: 'e9',
      source: 'n0',
      sourceHandle: '2',
      target: 'n1',
      targetHandle: null,
    });
    const trace = interpret(prepareFlow(flow), record());
    expect(trace.stop).toMatchObject({ kind: 'unmodelled', ref: 'checkVideoBitrate@1.0.0' });
    expect(trace.verdict).toBe('indeterminate');
  });
});

describe('verdicts', () => {
  it('counts an encode as a modification', () => {
    const flow = chain('ffmpegCommandExecute@1.0.0', 'replaceOriginalFile@1.0.0');
    expect(interpret(prepareFlow(flow), record()).verdict).toBe('modifies');
  });

  it('a revert after an encode leaves the library untouched', () => {
    // The size guard's whole purpose: encode, discover the result is implausible,
    // put the original back. Counting this as a modification would report the
    // guard as work done.
    const flow = chain(
      'ffmpegCommandExecute@1.0.0',
      'setOriginalFile@1.0.0',
      'replaceOriginalFile@1.0.0',
    );
    expect(interpret(prepareFlow(flow), record()).verdict).toBe('untouched');
  });

  it('setWorkingFile only reverts when its source is the original file', () => {
    const custom = chain('ffmpegCommandExecute@1.0.0', 'setWorkingFile@1.0.0');
    custom.flowPlugins[1]!.inputsDB = { source: 'customPath', customPath: '/tmp/other.mkv' };
    expect(interpret(prepareFlow(custom), record()).verdict).toBe('modifies');

    const original = chain('ffmpegCommandExecute@1.0.0', 'setWorkingFile@1.0.0');
    original.flowPlugins[1]!.inputsDB = { source: 'originalFile' };
    expect(interpret(prepareFlow(original), record()).verdict).toBe('untouched');
  });

  it('an unknowable guard after an encode is a retention question, not an unknown', () => {
    const flow = chain('ffmpegCommandExecute@1.0.0', 'compareFileSizeRatio@2.0.0');
    const trace = interpret(prepareFlow(flow), record());
    expect(trace.verdict).toBe('modifies');
    expect(trace.retentionUncertain).toBe(true);
  });

  it('an unknowable guard before any action really is unknown', () => {
    const flow = chain('checkFileChanged@1.0.0', 'ffmpegCommandExecute@1.0.0');
    const trace = interpret(prepareFlow(flow), record());
    expect(trace.verdict).toBe('indeterminate');
    expect(trace.retentionUncertain).toBe(false);
  });

  it('a gate sending the file down an unwired handle is a rejection', () => {
    const flow = chain('checkFileMedium@1.0.0', 'ffmpegCommandExecute@1.0.0');
    // Handle 1 is video; an audio file takes handle 2, which nothing is wired to.
    const trace = interpret(prepareFlow(flow), record({ fileMedium: 'audio' }));
    expect(trace.verdict).toBe('rejected');
    expect(trace.stop).toMatchObject({ kind: 'unwired', handle: 2 });
  });

  it('does not walk error edges - a scan predicts files, not failures', () => {
    const flow = chain('ffmpegCommandExecute@1.0.0');
    flow.flowPlugins.push({
      id: 'nerr',
      name: 'Fail Flow',
      sourceRepo: 'Community',
      pluginName: 'failFlow',
      version: '1.0.0',
      fpEnabled: true,
      position: { x: 200, y: 100 },
    });
    flow.flowEdges.push({
      id: 'eerr',
      source: 'n0',
      sourceHandle: 'err1',
      target: 'nerr',
      targetHandle: null,
    });
    expect(interpret(prepareFlow(flow), record()).verdict).toBe('modifies');
  });

  it('is pure - the same record twice gives the same trace, and is not mutated', () => {
    const flow = chain('checkFileMedium@1.0.0', 'ffmpegCommandExecute@1.0.0');
    const prepared = prepareFlow(flow);
    const file = record();
    const before = structuredClone(file);

    expect(interpret(prepared, file)).toEqual(interpret(prepared, file));
    expect(file).toEqual(before);
  });

  it('survives a cycle rather than hanging', () => {
    const flow = chain('ffmpegCommandExecute@1.0.0', 'runMkvPropEdit@1.0.0');
    flow.flowEdges.push({
      id: 'eloop',
      source: 'n1',
      sourceHandle: '1',
      target: 'n0',
      targetHandle: null,
    });
    expect(interpret(prepareFlow(flow), record()).stop.kind).toBe('cycle');
  });
});

describe('project', () => {
  it('never emits a key outside the projection, so raw records cannot leak', () => {
    // The guard that keeps a scan in flat memory: a 10.4 kB row must come out at
    // roughly 210 bytes, and it only does that if nothing unlisted rides along.
    const raw = {
      ...record(),
      bit_rate: 21_146_939,
      duration: 5000,
      mediaInfo: { track: [{ BitRate: '123' }] },
      statSync: { size: 1, mode: 33_190 },
      history: ['a'.repeat(1000)],
      HealthCheck: 'Success',
      TranscodeDecisionMaker: 'Transcode success',
    };
    const projected = project(raw)!;

    for (const key of Object.keys(projected)) {
      expect(PROJECTED_KEYS).toContain(key);
    }
    // With every optional field supplied, the projection is the full set.
    expect(Object.keys(projected).sort()).toEqual([...PROJECTED_KEYS].sort());
    expect(JSON.stringify(projected)).not.toContain('TranscodeDecisionMaker');
  });

  it('keeps an absent fileMedium absent rather than stringifying undefined', () => {
    // checkFileMedium distinguishes "no fileMedium" from any string value, so a
    // round-trip through the projection must not turn one into the other.
    const projected = project({ _id: '/x.mkv', DB: 'l', file_size: 1 })!;
    expect('fileMedium' in projected).toBe(false);
  });

  it('rejects a row that is not a file record', () => {
    expect(project(null)).toBeNull();
    expect(project({ noId: true })).toBeNull();
  });
});
