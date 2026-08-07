import { describe, expect, it } from 'vitest';
import { flow, layout, plugins } from '../src/index.ts';

describe('layout', () => {
  it('places every node on its own coordinates', () => {
    // The `overlapping-nodes` lint rule should be vacuously satisfied for
    // anything the SDK generates - that is the point of laying out by rank.
    const json = flow('spread')
      .start(plugins.inputFile())
      .then(plugins.checkVideoCodec())
      .fork({
        1: plugins.runMkvPropEdit(),
        2: plugins.replaceOriginalFile(),
      })
      .build();

    const seen = json.flowPlugins.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('points every forward edge downward', () => {
    const json = flow('down')
      .start(plugins.inputFile())
      .then(plugins.checkVideoCodec())
      .on(2, plugins.runClassicTranscodePlugin({ pluginSourceId: 'Community:X' }))
      .then(plugins.compareFileSizeRatio({ greaterThan: 0, lessThan: 100 }))
      .then(plugins.replaceOriginalFile())
      .build();

    const at = new Map(json.flowPlugins.map((n) => [n.id, n.position]));
    for (const edge of json.flowEdges) {
      expect(at.get(edge.target)!.y).toBeGreaterThan(at.get(edge.source)!.y);
    }
  });

  it('snaps to the grid', () => {
    const json = flow('grid').start(plugins.inputFile()).then(plugins.checkVideoCodec()).build();
    for (const node of json.flowPlugins) {
      expect(node.position.x % 12).toBe(0);
      expect(node.position.y % 12).toBe(0);
    }
  });

  it('terminates on a cycle rather than recursing forever', () => {
    // Retry loops are real: encode fails -> reset error -> back to the encoder.
    const positions = layout(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'b' }],
    );
    expect(positions.size).toBe(3);
    expect(positions.get('c')!.y).toBeGreaterThan(positions.get('b')!.y);
  });

  it('ranks by longest path, not first arrival', () => {
    // `d` is one hop from `a` and two from `a -> b -> c`. It has to sit below
    // `c`, or the edge from `c` would point upward.
    const positions = layout(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'a', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    );
    expect(positions.get('d')!.y).toBeGreaterThan(positions.get('c')!.y);
  });

  it('keeps preserved positions verbatim', () => {
    // Imported flows were arranged by hand; flattening them on re-export would
    // be the rudest thing this library could do.
    const positions = layout(
      [{ id: 'a' }, { id: 'b' }],
      [{ source: 'a', target: 'b' }],
      { preserve: { b: { x: -1234, y: 5678 } } },
    );
    expect(positions.get('b')).toEqual({ x: -1234, y: 5678 });
  });

  it('nudges off-spine nodes aside', () => {
    const positions = layout([{ id: 'a' }, { id: 'b', offSpine: true }], []);
    expect(positions.get('b')!.x).toBeGreaterThan(positions.get('a')!.x);
  });

  it('is stable across runs', () => {
    const build = () => flow('stable').start(plugins.inputFile()).then(plugins.checkVideoCodec()).build();
    expect(build().flowPlugins.map((n) => n.position))
      .toEqual(build().flowPlugins.map((n) => n.position));
  });
});
