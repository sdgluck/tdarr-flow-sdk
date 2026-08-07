import { describe, expect, it } from 'vitest';
import { assertNoLintErrors, catalogShapes, formatFindings, lint } from '../src/index.ts';
import { edge, makeFlow, node } from './fixtures.ts';

/** Rule ids only - keeps assertions about *what* was found readable. */
const rules = (flow: Parameters<typeof lint>[0], ignore?: string[]) =>
  lint(flow, ignore ? { ignore } : {}).map((f) => f.rule);

describe('lint', () => {
  it('accepts a well-formed flow', () => {
    const flow = makeFlow(
      [
        node('a', 'inputFile'),
        node('b', 'checkVideoCodec', { codec: 'hevc' }),
        node('c', 'replaceOriginalFile'),
        node('d', 'failFlow'),
      ],
      [edge('a', 1, 'b'), edge('b', 1, 'c'), edge('b', 2, 'd')],
    );
    expect(rules(flow)).toEqual([]);
  });

  it('flags a flow with no single entry', () => {
    const twoEntries = makeFlow(
      [node('a', 'inputFile'), node('b', 'inputFile'), node('c', 'replaceOriginalFile')],
      [edge('a', 1, 'c'), edge('b', 1, 'c')],
    );
    expect(rules(twoEntries)).toContain('entry-node');
  });

  it('flags an edge pointing at a node that is not there', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'replaceOriginalFile')],
      [edge('a', 1, 'b'), edge('a', 1, 'ghost')],
    );
    expect(rules(flow)).toContain('dangling-edge');
  });

  it('flags a node nothing can reach', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'replaceOriginalFile'), node('c', 'failFlow')],
      [edge('a', 1, 'b')],
    );
    // `c` has no incoming edge, so it also reads as a second entry.
    expect(rules(flow)).toContain('entry-node');

    const withEntry = makeFlow(
      [node('a', 'inputFile'), node('b', 'replaceOriginalFile'), node('c', 'failFlow')],
      [edge('a', 1, 'b'), edge('c', 1, 'b')],
    );
    expect(rules(withEntry)).toContain('entry-node');
  });

  it('flags an edge on a handle the plugin does not have', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'checkVideoCodec'), node('c', 'replaceOriginalFile')],
      [edge('a', 1, 'b'), edge('b', 1, 'c'), edge('b', 2, 'c'), edge('b', 5, 'c')],
    );
    const finding = lint(flow).find((f) => f.rule === 'nonexistent-handle')!;
    expect(finding.severity).toBe('error');
    expect(finding.message).toMatch(/handle 5.*has 2 output/s);
  });

  it('checks handles against the node\'s own version', () => {
    // The reference pipeline wires handle 3 of compareFileSizeRatio@2.0.0. A
    // catalog keyed by name alone would have to be wrong about one of these.
    const build = (version: string) =>
      makeFlow(
        [
          node('a', 'inputFile'),
          node('b', 'compareFileSizeRatio', {}, { version }),
          node('c', 'setOriginalFile'),
        ],
        [edge('a', 1, 'b'), edge('b', 1, 'c'), edge('b', 2, 'c'), edge('b', 3, 'c')],
      );

    expect(rules(build('2.0.0'))).not.toContain('nonexistent-handle');
    expect(rules(build('1.0.0'))).toContain('nonexistent-handle');
  });

  it('flags an error edge on a node that cannot fail', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'checkVideoCodec'), node('c', 'resetFlowError')],
      [edge('a', 1, 'b'), edge('b', 'err1', 'c')],
    );
    expect(lint(flow).find((f) => f.rule === 'nonexistent-handle')!.message)
      .toMatch(/exposes no err1 handle/);
  });

  it('warns about an output that leads nowhere', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'checkVideoCodec'), node('c', 'replaceOriginalFile')],
      [edge('a', 1, 'b'), edge('b', 1, 'c')],
    );
    const finding = lint(flow).find((f) => f.rule === 'unwired-handle')!;
    expect(finding.severity).toBe('warning');
    expect(finding.message).toMatch(/handle 2 has no outgoing edge/);
  });

  it('does not expect outputs from a terminal node', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'failFlow')],
      [edge('a', 1, 'b')],
    );
    expect(rules(flow)).not.toContain('unwired-handle');
  });

  it('warns when a node that can fail has no error edge', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'runMkvPropEdit'), node('c', 'replaceOriginalFile')],
      [edge('a', 1, 'b'), edge('b', 1, 'c')],
    );
    expect(rules(flow)).toContain('missing-error-edge');
  });

  it('marks findings that rest on an assumed shape', () => {
    // moveToDirectory's error handle is a curated guess, not something observed.
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'moveToDirectory', {}, { version: '2.0.0' })],
      [edge('a', 1, 'b')],
    );
    expect(lint(flow).find((f) => f.rule === 'missing-error-edge')!.assumed).toBe(true);

    const observed = makeFlow(
      [node('a', 'inputFile'), node('b', 'runMkvPropEdit'), node('c', 'replaceOriginalFile')],
      [edge('a', 1, 'b'), edge('b', 1, 'c')],
    );
    expect(lint(observed).find((f) => f.rule === 'missing-error-edge')!.assumed).toBe(false);
  });

  it('warns about a plugin used at two versions', () => {
    const flow = makeFlow(
      [
        node('a', 'inputFile'),
        node('b', 'compareFileSizeRatio', {}, { version: '1.0.0' }),
        node('c', 'compareFileSizeRatio', {}, { version: '2.0.0' }),
      ],
      [edge('a', 1, 'b'), edge('b', 1, 'c')],
    );
    expect(rules(flow)).toContain('mixed-plugin-versions');
  });

  it('warns about nodes stacked on the same coordinates', () => {
    const flow = makeFlow(
      [
        node('a', 'inputFile', {}, { position: { x: 0, y: 0 } }),
        node('b', 'replaceOriginalFile', {}, { position: { x: 0, y: 0 } }),
      ],
      [edge('a', 1, 'b')],
    );
    expect(rules(flow)).toContain('overlapping-nodes');
  });

  it('warns about a plugin it has no shape for', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'normaliseAudioTracks', {}, { sourceRepo: 'Local' })],
      [edge('a', 1, 'b')],
    );
    expect(rules(flow)).toContain('uncatalogued-plugin');
  });

  it('takes a declared shape for a Local plugin', () => {
    const flow = makeFlow(
      [
        node('a', 'inputFile'),
        node('b', 'normaliseAudioTracks', {}, { sourceRepo: 'Local' }),
        node('c', 'replaceOriginalFile'),
      ],
      [edge('a', 1, 'b'), edge('b', 1, 'c')],
    );
    const shapes = catalogShapes({
      'normaliseAudioTracks@1.0.0': {
        outputs: 1,
        error: false,
        terminal: false,
        confidence: 'declared',
      },
    });
    expect(lint(flow, { shapes }).map((f) => f.rule)).toEqual([]);
  });
});

describe('ignore scoping', () => {
  const flow = makeFlow(
    [node('a', 'inputFile'), node('b', 'runMkvPropEdit'), node('c', 'replaceOriginalFile')],
    [edge('a', 1, 'b'), edge('b', 1, 'c')],
  );

  it('silences a rule everywhere', () => {
    expect(rules(flow, ['missing-error-edge'])).not.toContain('missing-error-edge');
  });

  it('silences a rule on one node only', () => {
    expect(rules(flow, ['missing-error-edge:b'])).not.toContain('missing-error-edge');
    expect(rules(flow, ['missing-error-edge:other'])).toContain('missing-error-edge');
  });
});

describe('reporting', () => {
  const broken = makeFlow(
    [node('a', 'inputFile'), node('b', 'checkVideoCodec'), node('c', 'replaceOriginalFile')],
    [edge('a', 1, 'b'), edge('b', 1, 'c'), edge('b', 9, 'c')],
  );

  it('can drop warnings', () => {
    expect(lint(broken, { includeWarnings: false }).every((f) => f.severity === 'error')).toBe(true);
  });

  it('throws with the findings when asserting', () => {
    expect(() => assertNoLintErrors(broken)).toThrow(/nonexistent-handle/);
    expect(formatFindings([])).toBe('no findings');
  });
});
