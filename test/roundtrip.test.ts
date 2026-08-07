import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSpec, importFlow, isomorphic, newSpec, stripSpec } from '../src/index.ts';
import type { FlowJson } from '../src/types/flow.ts';
import { pipelineSpec } from './pipelineSpec.ts';

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcode-pipeline.json'),
    'utf8',
  ),
) as FlowJson;

describe('embedded round-trip', () => {
  it('recovers a spec exactly from a flow we generated', () => {
    const flow = compileSpec(pipelineSpec, { embed: true });
    const result = importFlow(flow);

    expect(result.source).toBe('embedded');
    expect(result.spec).toEqual(pipelineSpec);
    expect(result.unrecognised).toEqual([]);
  });

  it('keeps the description readable around the marker', () => {
    const spec = { ...pipelineSpec, meta: { ...pipelineSpec.meta, description: 'Notes here.' } };
    const flow = compileSpec(spec, { embed: true });

    expect(flow.description).toMatch(/^Notes here\./);
    expect(stripSpec(flow.description)).toBe('Notes here.');
    expect(importFlow(flow).spec?.meta.description).toBe('Notes here.');
  });

  it('falls back to structure when the flow was edited after export', () => {
    // The marker still decodes, but no longer describes the flow it is attached
    // to. Trusting it would silently discard the user's edit.
    const flow = compileSpec(pipelineSpec, { embed: true });
    flow.flowPlugins = flow.flowPlugins.filter((n) => n.pluginName !== 'runHealthCheck');
    flow.flowEdges = flow.flowEdges.slice(0, -1);

    const result = importFlow(flow);
    expect(result.source).toBe('recognised');
    expect(result.embeddedMismatch).toMatch(/edited since/);
  });

  it('is off by default, since it depends on Tdarr preserving descriptions', () => {
    expect(compileSpec(pipelineSpec).description).toBeUndefined();
  });
});

describe('structural recognition of a hand-built flow', () => {
  const result = importFlow(fixture);

  it('recognises every stage', () => {
    expect(result.source).toBe('recognised');
    expect(result.recognised.map((m) => m.recipe)).toEqual([
      'sourceFile',
      'remuxContainer',
      'transcodeVideo',
      'cleanTracks',
      'normalizeAudio',
      'finalise',
    ]);
  });

  it('reads back the parameters that matter', () => {
    const spec = result.spec!;
    expect(spec.source.requireMedium).toBe('video');

    expect(spec.container.method).toEqual({
      kind: 'classic',
      pluginSourceId: 'Local:Tdarr_Plugin_bsh1_RemuxMKV',
      fallbackPluginSourceId: 'Local:Tdarr_Plugin_bsh1_ForceRemuxMKV',
    });
    expect(spec.container.healStatistics).toBe(true);

    expect(spec.video.targetCodec).toBe('hevc');
    expect(spec.video.sizeGuard).toEqual({
      enabled: true,
      greaterThan: 0,
      lessThan: 100,
      onFail: 'keepOriginal',
    });

    expect(spec.tracks.implementation).toEqual({
      kind: 'classic',
      pluginSourceId: 'Local:Tdarr_Plugin_bsh1_CleanTracks',
      inputs: { tag_language: 'eng', remove_commentary: 'true', remove_sdh: 'false' },
    });

    expect(spec.audio.encoder).toBe('eac3');
    expect(spec.audio.stereoMate).toBe(true);
    expect(spec.audio.surround).toMatchObject({ channels: 6, bitrate: '384k', matchChannels: [4, 5, 6, 7, 8] });
    expect(spec.audio.stereo).toMatchObject({ channels: 2, bitrate: '192k', matchChannels: [2, 3] });
    expect(spec.audio.mono).toMatchObject({ channels: 1, bitrate: '96k' });
    expect(spec.audio.normalise?.pluginName).toBe('normaliseAudioTracks');

    expect(spec.output.restampStatistics).toBe(true);
    expect(spec.output.destination).toEqual({ kind: 'replaceOriginal' });
  });

  it('finds the hardware encoder chain', () => {
    const encoder = result.spec!.video.encoder;
    if (encoder.kind !== 'classic') throw new Error('expected classic encoders');

    expect(encoder.branches.map((b) => b.equals)).toEqual(['Nvidia', 'Intel']);
    expect(encoder.fallbackPluginSourceId).toBe('Community:Tdarr_Plugin_MC93_Migz1FFMPEG_CPU');
    expect(encoder.errorFallsBackToCpu).toBe(true);
  });

  it('accounts for every node', () => {
    // Anything a matcher did not claim is preserved rather than dropped - that
    // is what makes a shallow matcher safe to ship.
    const claimed = new Set(result.recognised.flatMap((m) => m.nodeIds));
    const preserved = new Set(result.spec!.extras.map((e) => e.id));
    const entry = fixture.flowPlugins.find((n) => n.pluginName === 'inputFile')!.id;

    for (const node of fixture.flowPlugins) {
      const accounted = claimed.has(node.id) || preserved.has(node.id) || node.id === entry;
      expect(accounted, `${node.name} (${node.pluginName}) is unaccounted for`).toBe(true);
    }
  });

  it('preserves positions only for nodes that keep their identity', () => {
    // Recognised stages are regenerated from the spec with fresh ids, so their
    // old coordinates have nothing to attach to. Frozen extras keep theirs.
    const preserve = result.spec!.policy.layout?.preserve ?? {};
    expect(Object.keys(preserve).sort()).toEqual(result.unrecognised.map((n) => n.id).sort());

    for (const node of result.unrecognised) {
      expect(preserve[node.id]).toEqual(node.position);
    }
  });
});

describe('import failure modes', () => {
  it('explains what a Tdarr flow looks like', () => {
    expect(() => importFlow({ nope: true })).toThrow(/expected an object with flowPlugins/);
    expect(() => importFlow('{"a":1}')).toThrow(/not a Tdarr flow/);
  });

  it('accepts a JSON string as well as an object', () => {
    expect(importFlow(JSON.stringify(fixture)).source).toBe('recognised');
  });

  it('reports no spec when nothing anchors', () => {
    const bare = compileSpec(newSpec('Bare'));
    // A flow that is only an entry node and a commit has nothing to recognise
    // beyond the destination itself.
    const result = importFlow({ ...bare, flowPlugins: bare.flowPlugins.slice(0, 1), flowEdges: [] });
    expect(result.source).toBe('none');
    expect(result.spec).toBeNull();
  });

  it('surfaces lint findings for the imported flow', () => {
    expect(importFlow(fixture).lint.length).toBeGreaterThan(0);
  });
});

describe('recompiling an import', () => {
  it('reproduces a generated flow', () => {
    const flow = compileSpec(pipelineSpec, { embed: true });
    const spec = importFlow(flow).spec!;
    expect(isomorphic(compileSpec(spec, { embed: true }), flow)).toBe(true);
  });
});
