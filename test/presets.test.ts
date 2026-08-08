/**
 * Every preset has to compile to a sound flow, because the whole point of
 * offering them is that someone can pick one without knowing what a Tdarr flow
 * contains. A preset that produces a broken graph is worse than an empty
 * wizard.
 */

import { describe, expect, it } from 'vitest';
import { catalogShapes, compileSpec, findPreset, isPristine, lint, newSpec, PRESETS } from '../src/index.ts';

describe('presets', () => {
  it('offers a reasonable number of distinct starting points', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(PRESETS.map((p) => p.name)).size).toBe(PRESETS.length);
  });

  it('describes each one in the UI\'s own terms', () => {
    for (const preset of PRESETS) {
      expect(preset.summary.length, preset.id).toBeGreaterThan(20);
      expect(preset.detail.length, preset.id).toBeGreaterThan(80);
      expect(preset.tags.length, preset.id).toBeGreaterThan(0);
    }
  });

  for (const preset of PRESETS) {
    describe(preset.name, () => {
      it('compiles to a flow with no lint errors', () => {
        const spec = preset.spec();
        const flow = compileSpec(spec);
        const errors = lint(flow, { shapes: catalogShapes() }).filter((f) => f.severity === 'error');

        expect(errors, `${preset.id}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
        expect(flow.flowPlugins.length).toBeGreaterThan(1);
      });

      it('actually does something', () => {
        // A preset that compiles to the same graph as an empty spec is not a
        // starting point, it is a blank page with a name on it.
        const preset_ = compileSpec(preset.spec());
        const empty = compileSpec(newSpec());
        expect(preset_.flowPlugins.length).toBeGreaterThan(empty.flowPlugins.length);
      });

      it('is not mistaken for an untouched wizard', () => {
        expect(isPristine(preset.spec())).toBe(false);
      });

      it('returns a fresh spec each time, so editing one cannot affect another', () => {
        const first = preset.spec();
        first.meta.name = 'edited';
        first.source.minSizeMb = 12345;
        expect(preset.spec().meta.name).not.toBe('edited');
        expect(preset.spec().source.minSizeMb).not.toBe(12345);
      });
    });
  }

  it('can be looked up by id', () => {
    expect(findPreset('hevc-simple')?.name).toBe('HEVC, everything');
    expect(findPreset('nope')).toBeUndefined();
  });
});

describe('isPristine', () => {
  it('is true for a fresh spec, named or not', () => {
    expect(isPristine(newSpec())).toBe(true);
    expect(isPristine(newSpec('Just a name'))).toBe(true);
  });

  it('is false once any step is switched on', () => {
    const spec = newSpec();
    spec.video.mode = 'transcode';
    expect(isPristine(spec)).toBe(false);
  });
});
