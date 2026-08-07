import { describe, expect, it } from 'vitest';
import { ffmpegCommand, flow, localNode, plugins } from '../src/index.ts';

const simple = () =>
  flow('Simple')
    .start(plugins.inputFile())
    .then(plugins.checkVideoCodec({ codec: 'hevc' }))
    .on(2, plugins.runClassicTranscodePlugin({ pluginSourceId: 'Community:Tdarr_Plugin_X' }))
    .onError(plugins.resetFlowError())
    .then(plugins.replaceOriginalFile());

describe('flow builder', () => {
  it('produces the flow JSON Tdarr stores', () => {
    const json = simple().build();
    expect(json.name).toBe('Simple');
    expect(json.flowPlugins).toHaveLength(5);
    expect(json.flowEdges.map((e) => e.sourceHandle)).toEqual(['1', '2', 'err1', '1']);
    expect(json.flowEdges.every((e) => e.targetHandle === null)).toBe(true);
  });

  it('is deterministic, so recompiling a spec produces no diff', () => {
    expect(simple().build()).toEqual(simple().build());
  });

  it('omits inputsDB when a node has no configuration, as Tdarr does', () => {
    const json = simple().build();
    const inputFile = json.flowPlugins.find((n) => n.pluginName === 'inputFile')!;
    const check = json.flowPlugins.find((n) => n.pluginName === 'checkVideoCodec')!;
    expect(inputFile.inputsDB).toBeUndefined();
    expect(check.inputsDB).toEqual({ codec: 'hevc' });
  });

  it('names nodes from the catalog title unless told otherwise', () => {
    const json = flow('n')
      .start(plugins.inputFile())
      .then(plugins.checkVideoCodec({}, { name: 'Is HEVC?' }))
      .build();
    expect(json.flowPlugins.map((n) => n.name)).toEqual(['Input File', 'Is HEVC?']);
  });

  it('gives every node and edge a unique id', () => {
    const json = flow('dupes')
      .start(plugins.inputFile())
      .then(plugins.runMkvPropEdit())
      .then(plugins.runMkvPropEdit())
      .then(plugins.runMkvPropEdit())
      .build();
    expect(new Set(json.flowPlugins.map((n) => n.id)).size).toBe(4);
    expect(new Set(json.flowEdges.map((e) => e.id)).size).toBe(3);
  });

  it('honours caller-supplied ids and rejects a collision', () => {
    const json = flow('fixed')
      .start(plugins.inputFile({}, { id: 'entry01' }))
      .then(plugins.failFlow({}, { id: 'dead0001' }))
      .build();
    expect(json.flowPlugins.map((n) => n.id)).toEqual(['entry01', 'dead0001']);

    expect(() =>
      flow('clash')
        .start(plugins.inputFile({}, { id: 'x' }))
        .then(plugins.runMkvPropEdit({}, { id: 'x' }))
    ).toThrow(/duplicate node id: x/);
  });
});

describe('handle validation', () => {
  it('rejects a handle the plugin does not have', () => {
    expect(() =>
      flow('bad').start(plugins.inputFile()).then(plugins.checkVideoCodec())
        .at(3).then(plugins.failFlow())
    ).toThrow(/has 2 outputs; handle 3 is not one of 1, 2/);
  });

  it('is version-aware', () => {
    // Handle 3 exists at 2.0.0 and not at 1.0.0. A name-keyed catalog would
    // accept both or reject both; either way one real flow gets it wrong.
    const wire = (version: '1.0.0' | '2.0.0') => () =>
      flow('v').start(plugins.inputFile())
        .then(
          version === '2.0.0'
            ? plugins.compareFileSizeRatio()
            : plugins.compareFileSizeRatioV1(),
        )
        .at(3).then(plugins.setOriginalFile());

    expect(wire('2.0.0')).not.toThrow();
    expect(wire('1.0.0')).toThrow(/has 2 outputs; handle 3/);
  });

  it('rejects err1 on a node that cannot fail', () => {
    expect(() => flow('e').start(plugins.inputFile()).onError(plugins.resetFlowError()))
      .toThrow(/has no error handle/);
  });

  it('rejects wiring out of a terminal node', () => {
    expect(() => flow('t').start(plugins.inputFile()).then(plugins.failFlow()).then(plugins.resetFlowError()))
      .toThrow(/is terminal/);
  });

  it('trusts a shape the caller declares for an uncatalogued plugin', () => {
    const json = flow('local')
      .start(plugins.inputFile())
      .then(localNode({ pluginName: 'normaliseAudioTracks', outputs: 1, inputs: { targetCodec: 'eac3' } }))
      .then(plugins.replaceOriginalFile())
      .build();
    const local = json.flowPlugins.find((n) => n.pluginName === 'normaliseAudioTracks')!;
    expect(local.sourceRepo).toBe('Local');
    expect(local.inputsDB).toEqual({ targetCodec: 'eac3' });
  });
});

describe('composition', () => {
  it('converges branches on an existing node', () => {
    const builder = flow('converge');
    const end = builder.add(plugins.replaceOriginalFile());
    builder.start(plugins.inputFile())
      .then(plugins.checkVideoCodec())
      .fork({ 1: end, 2: end });

    const json = builder.build();
    expect(json.flowPlugins).toHaveLength(3);
    expect(json.flowEdges.filter((e) => e.target === end.id)).toHaveLength(2);
  });

  it('does not duplicate an identical edge', () => {
    const builder = flow('dupe');
    const end = builder.add(plugins.replaceOriginalFile());
    const check = builder.start(plugins.inputFile()).then(plugins.checkVideoCodec());
    check.on(1, end);
    check.on(1, end);
    expect(builder.build().flowEdges.filter((e) => e.source === check.id)).toHaveLength(1);
  });

  it('lets a conditional segment decline to add anything', () => {
    // The branch stays wired to handle 2 even though the segment was a no-op:
    // this is why the cursor carries its outgoing handle.
    const noop = { kind: 'segment' as const, apply: (c: never) => c };
    const json = flow('skip')
      .start(plugins.inputFile())
      .then(plugins.checkVideoCodec())
      .on(2, noop)
      .then(plugins.replaceOriginalFile())
      .build();

    expect(json.flowPlugins).toHaveLength(3);
    expect(json.flowEdges.at(-1)!.sourceHandle).toBe('2');
  });

  it('builds an ffmpeg block with exactly one Execute', () => {
    const json = flow('ffmpeg')
      .start(plugins.inputFile())
      .then(
        ffmpegCommand()
          .container({ container: 'mkv' })
          .videoEncoder({ outputCodec: 'hevc' })
          .ensureAudio({ audioEncoder: 'eac3', channels: 6 })
          .removeDataStreams(),
      )
      .then(plugins.replaceOriginalFile())
      .build();

    const names = json.flowPlugins.map((n) => n.pluginName);
    expect(names.filter((n) => n === 'ffmpegCommandExecute')).toHaveLength(1);
    expect(names.indexOf('ffmpegCommandStart')).toBeLessThan(names.indexOf('ffmpegCommandExecute'));
  });

  it('rejects a second entry node', () => {
    const builder = flow('two');
    builder.start(plugins.inputFile());
    expect(() => builder.start(plugins.inputFile())).toThrow(/already starts at/);
  });

  it('rejects nodes with no entry at all', () => {
    const builder = flow('orphan');
    builder.add(plugins.replaceOriginalFile());
    expect(() => builder.build()).toThrow(/has nodes but no entry/);
  });
});
