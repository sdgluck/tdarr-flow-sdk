import { describe, expect, it } from 'vitest';
import {
  defaultInputs,
  evaluateDisplayConditions,
  findPlugin,
  getPlugin,
  latestVersion,
  listPlugins,
  pluginsByCategory,
  searchPlugins,
  visibleInputs,
} from '../src/index.ts';
import { ERROR_CAPABLE, TERMINAL_OVERRIDE } from '../src/catalog/overrides.ts';

describe('catalog', () => {
  it('has entries and records where they came from', () => {
    expect(listPlugins().length).toBeGreaterThan(90);
    expect(getPlugin('inputFile').ref).toBe('inputFile@1.0.0');
  });

  it('stores every default as a string', () => {
    // The whole encode/decode contract in graph/inputs.ts rests on this: Tdarr
    // reads inputsDB values as strings and coerces per the declared type.
    const wrong = listPlugins().flatMap((entry) =>
      entry.inputs.filter((i) => typeof i.defaultValue !== 'string')
        .map((i) => `${entry.ref}.${i.name}`)
    );
    expect(wrong).toEqual([]);
  });

  it('keys by name@version, because version changes shape', () => {
    // compareFileSizeRatio grew a third output at 2.0.0, and the reference
    // pipeline wires handle 3. Collapsing to the newest version would make the
    // linter reject a flow that works.
    expect(getPlugin('compareFileSizeRatio', '1.0.0').outputs).toHaveLength(2);
    expect(getPlugin('compareFileSizeRatio', '2.0.0').outputs).toHaveLength(3);
    expect(latestVersion('compareFileSizeRatio')).toBe('2.0.0');
    expect(findPlugin('compareFileSizeRatio')!.version).toBe('2.0.0');
  });

  it('resolves every hand-curated override', () => {
    const unresolved = [...Object.keys(ERROR_CAPABLE), ...Object.keys(TERMINAL_OVERRIDE)]
      .filter((ref) => !listPlugins().some((e) => e.ref === ref));
    expect(unresolved).toEqual([]);
  });

  it('marks curated error handles, with their confidence', () => {
    expect(getPlugin('runClassicTranscodePlugin', '2.0.0').error).toBe(true);
    expect(getPlugin('runClassicTranscodePlugin', '2.0.0').errorConfidence).toBe('observed');
    expect(getPlugin('moveToDirectory', '2.0.0').errorConfidence).toBe('assumed');
    expect(getPlugin('checkVideoCodec').error).toBe(false);
  });

  it('derives terminal from having no outputs', () => {
    expect(getPlugin('failFlow').terminal).toBe(true);
    expect(getPlugin('checkVideoCodec').terminal).toBe(false);
  });

  it('explains an unknown plugin instead of returning undefined', () => {
    expect(() => getPlugin('normaliseAudioTracks')).toThrow(/Local flow plugin/);
    // Newest first, so the version a caller most likely wanted is listed first.
    expect(() => getPlugin('compareFileSizeRatio', '9.0.0'))
      .toThrow(/Catalogued versions: 2\.0\.0, 1\.0\.0/);
  });

  it('groups and searches', () => {
    expect(pluginsByCategory().get('ffmpegCommand')!.length).toBeGreaterThan(10);
    expect(searchPlugins('mkvpropedit').map((e) => e.name)).toContain('runMkvPropEdit');
    expect(searchPlugins('')).toHaveLength(listPlugins().length);
  });
});

describe('displayConditions', () => {
  const entry = getPlugin('ffmpegCommandEnsureAudioStream');

  it('hides an input whose condition is unmet', () => {
    const names = (current: Record<string, string>) =>
      visibleInputs(entry, current).map((i) => i.name);

    expect(names({ enableBitrate: 'false' })).not.toContain('bitrate');
    expect(names({ enableBitrate: 'true' })).toContain('bitrate');
  });

  it('defaults decide visibility when the user has set nothing', () => {
    const defaults = defaultInputs(entry);
    expect(defaults['enableBitrate']).toBe('false');
    expect(visibleInputs(entry, {}).map((i) => i.name)).not.toContain('bitrate');
  });

  it('compares string forms, as Tdarr\'s own UI does', () => {
    const conditions = {
      logic: 'AND' as const,
      sets: [{ logic: 'AND' as const, inputs: [{ name: 'x', value: 'true', condition: '===' as const }] }],
    };
    expect(evaluateDisplayConditions(conditions, { x: 'true' })).toBe(true);
    // Not truthiness: only the literal string 'true' passes.
    expect(evaluateDisplayConditions(conditions, { x: '1' })).toBe(false);
    expect(evaluateDisplayConditions(conditions, {})).toBe(false);
  });

  it('treats a missing condition as always visible', () => {
    expect(evaluateDisplayConditions(undefined, {})).toBe(true);
  });

  it('supports OR, which the shape allows even though nothing uses it yet', () => {
    const conditions = {
      logic: 'OR' as const,
      sets: [
        { logic: 'AND' as const, inputs: [{ name: 'a', value: '1', condition: '===' as const }] },
        { logic: 'AND' as const, inputs: [{ name: 'b', value: '2', condition: '===' as const }] },
      ],
    };
    expect(evaluateDisplayConditions(conditions, { a: '1', b: 'x' })).toBe(true);
    expect(evaluateDisplayConditions(conditions, { a: 'x', b: 'x' })).toBe(false);
  });
});
