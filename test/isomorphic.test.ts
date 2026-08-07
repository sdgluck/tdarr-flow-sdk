import { describe, expect, it } from 'vitest';
import { difference, isomorphic } from '../src/index.ts';
import { edge, makeFlow, node } from './fixtures.ts';

const base = () =>
  makeFlow(
    [
      node('a', 'inputFile'),
      node('b', 'checkVideoCodec', { codec: 'hevc' }),
      node('c', 'resetFlowError'),
      node('d', 'resetFlowError'),
      node('e', 'replaceOriginalFile'),
    ],
    [edge('a', 1, 'b'), edge('b', 1, 'c'), edge('b', 2, 'd'), edge('c', 1, 'e'), edge('d', 1, 'e')],
  );

describe('isomorphic', () => {
  it('ignores ids, names, order and position', () => {
    const shuffled = structuredClone(base());
    const remap = Object.fromEntries(shuffled.flowPlugins.map((n, i) => [n.id, `zz${i}`]));
    shuffled.flowPlugins = shuffled.flowPlugins
      .map((n) => ({ ...n, id: remap[n.id]!, name: 'renamed', position: { x: 7, y: 7 } }))
      .reverse();
    shuffled.flowEdges = shuffled.flowEdges
      .map((e) => ({ ...e, id: 'x', source: remap[e.source]!, target: remap[e.target]! }))
      .reverse();

    expect(isomorphic(base(), shuffled)).toBe(true);
  });

  it('distinguishes identical nodes by where they sit', () => {
    // `c` and `d` are byte-identical resetFlowError nodes. Swapping which
    // handle reaches which is a real change, and a comparison that sorted
    // nodes by content alone would call these two flows the same.
    const rewired = base();
    rewired.flowEdges = [
      edge('a', 1, 'b'),
      edge('b', 1, 'c'),
      edge('b', 2, 'd'),
      edge('c', 1, 'e'),
      edge('d', 1, 'c'),
    ];
    expect(isomorphic(base(), rewired)).toBe(false);
  });

  it('notices a changed input', () => {
    const retuned = base();
    retuned.flowPlugins[1]!.inputsDB = { codec: 'av1' };
    expect(difference(base(), retuned)!.kind).toBe('nodes');
  });

  it('notices a changed handle', () => {
    const rehandled = base();
    rehandled.flowEdges[1] = edge('b', 2, 'c');
    expect(isomorphic(base(), rehandled)).toBe(false);
  });

  it('reports counts before anything subtler', () => {
    const extra = base();
    extra.flowPlugins.push(node('f', 'failFlow'));
    expect(difference(base(), extra)).toEqual({ kind: 'node-count', message: '5 nodes vs 6' });
  });

  it('names what is missing when node sets differ', () => {
    const swapped = base();
    swapped.flowPlugins[4] = node('e', 'failFlow');
    expect(difference(base(), swapped)!.message).toMatch(/only in first:\s+replaceOriginalFile/);
  });
});
