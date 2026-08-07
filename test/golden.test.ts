/**
 * The keystone test.
 *
 * `test/fixtures/transcode-pipeline.json` is a real, working, hand-built flow.
 * If `compileSpec` can reproduce it from a declarative spec, the spec model and
 * the recipes are good enough to be worth building a wizard on top of. If it
 * cannot, nothing else in this package matters yet.
 *
 * Compared with `isomorphic`, not by equality: the SDK derives ids from content
 * and lays out by rank, so it will never reproduce the fixture's hand-arranged
 * coordinates or its nanoid ids - nor should it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogShapes, compileSpec, lint } from '../src/index.ts';
import { difference, isomorphic } from '../src/recognise/isomorphic.ts';
import type { FlowJson } from '../src/types/flow.ts';
import { pipelineSpec } from './pipelineSpec.ts';

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcode-pipeline.json'),
    'utf8',
  ),
) as FlowJson;

/** The Local plugin the reference flow uses; the catalog cannot know its shape. */
const shapes = catalogShapes({
  'normaliseAudioTracks@1.0.0': {
    outputs: 1,
    error: false,
    terminal: false,
    confidence: 'declared',
  },
});

describe('golden: the reference transcode pipeline', () => {
  const compiled = compileSpec(pipelineSpec);

  it('reproduces the flow as a graph', () => {
    const diff = difference(compiled, fixture);
    expect(diff?.message ?? 'match').toBe('match');
    expect(isomorphic(compiled, fixture)).toBe(true);
  });

  it('has the same node and edge counts', () => {
    expect(compiled.flowPlugins).toHaveLength(fixture.flowPlugins.length);
    expect(compiled.flowEdges).toHaveLength(fixture.flowEdges.length);
  });

  it('carries the flow\'s identity', () => {
    expect(compiled._id).toBe(fixture._id);
    expect(compiled.name).toBe(fixture.name);
    expect(compiled.priority).toBe(fixture.priority);
  });

  it('lints no worse than the flow it reproduces', () => {
    const summarise = (flow: FlowJson) =>
      lint(flow, { shapes }).map((f) => `${f.severity}:${f.rule}`).sort();

    expect(summarise(compiled)).toEqual(summarise(fixture));
    expect(lint(compiled, { shapes }).filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('lays every node out somewhere distinct', () => {
    const seen = compiled.flowPlugins.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('compiles the same flow every time', () => {
    expect(compileSpec(pipelineSpec)).toEqual(compiled);
  });
});
