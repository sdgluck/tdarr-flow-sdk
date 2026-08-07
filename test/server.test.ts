/**
 * The client and the verifier.
 *
 * `fetch` is injected throughout, so the write paths are exercised without ever
 * touching a real server - which matters here more than usual, since the thing
 * being tested can overwrite somebody's flows.
 */

import { describe, expect, it, vi } from 'vitest';
import { compileSpec, TdarrClient, verifyAgainstFlows } from '../src/index.ts';
import { formatVerifyReport } from '../src/server/verify.ts';
import type { FlowJson } from '../src/types/flow.ts';
import { edge, makeFlow, node } from './fixtures.ts';
import { pipelineSpec } from './pipelineSpec.ts';

function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = handler(String(url), init ?? {});
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

const client = (fetchImpl: typeof fetch, options = {}) =>
  new TdarrClient({ url: 'https://tdarr.example.com/', fetchImpl, ...options });

describe('TdarrClient requests', () => {
  it('trims a trailing slash off the base url', () => {
    expect(client(stubFetch(() => ({}))).url).toBe('https://tdarr.example.com');
  });

  it('sends no auth header when there is no token', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      calls.push(init);
      return { status: 'good', version: '2.86.01' };
    });

    await client(fetchImpl).status();
    expect(calls[0]!.headers).toEqual({});
  });

  it('sends the token as Authorization by default', async () => {
    // Not x-api-key: a Tdarr behind the usual nginx config does not include
    // that header in its CORS allow-list, so the browser blocks the request at
    // the preflight before it is sent.
    const calls: RequestInit[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      calls.push(init);
      return { status: 'good', version: '2.86.01' };
    });

    await client(fetchImpl, { token: 'secret' }).status();
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'secret' });
  });

  it('lets the auth header be changed for a proxy that allows x-api-key', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      calls.push(init);
      return { status: 'good', version: '2.86.01' };
    });

    await client(fetchImpl, { token: 'k', authHeader: 'x-api-key' }).status();
    expect(calls[0]!.headers).toMatchObject({ 'x-api-key': 'k' });
  });

  it('treats a blank token as no token', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      calls.push(init);
      return {};
    });

    await client(fetchImpl, { token: '   ' }).status();
    expect(calls[0]!.headers).toEqual({});
  });

  it('GETs without a body and POSTs with one', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = stubFetch((url, init) => {
      calls.push({ url, init });
      return [];
    });

    const tdarr = client(fetchImpl);
    await tdarr.status();
    await tdarr.getFlows();

    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://tdarr.example.com/api/v2/status');
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      data: { collection: 'FlowsJSONDB', mode: 'getAll' },
    });
  });
});

describe('TdarrClient failures', () => {
  it('names CORS as a possibility, since a browser cannot tell it apart', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).status()).rejects.toThrow(/refusing cross-origin requests/);
    await expect(client(fetchImpl).status()).rejects.toMatchObject({ isNetwork: true });
  });

  it('points at the CORS allow-list when credentials are rejected', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 } as Response)) as
      unknown as typeof fetch;

    await expect(client(fetchImpl, { token: 'x' }).status())
      .rejects.toThrow(/allows the "Authorization" header through CORS/);
  });

  it('ping reports false rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).ping()).resolves.toBe(false);
  });

  it('says which flow id was not found', async () => {
    const fetchImpl = stubFetch(() => []);
    await expect(client(fetchImpl).getFlow('nope')).rejects.toThrow(/no flow with id "nope"/);
  });
});

describe('TdarrClient reads', () => {
  const flows: FlowJson[] = [compileSpec(pipelineSpec)];

  it('summarises flows', async () => {
    const fetchImpl = stubFetch(() => flows);
    const [summary] = await client(fetchImpl).listFlows();

    expect(summary).toMatchObject({ name: 'Transcode Pipeline', nodeCount: 35, edgeCount: 59 });
  });

  it('reads libraries, including which flow they run', async () => {
    const fetchImpl = stubFetch(() => [
      { _id: 'EQcNibtxE', name: 'Film', folder: '/mnt/media/film', flowId: 'a_CeSjPzb' },
      { _id: 'SkLghsXCM', name: 'TV', folder: '/mnt/media/tv' },
    ]);

    const libraries = await client(fetchImpl).listLibraries();
    expect(libraries[0]).toEqual({
      id: 'EQcNibtxE',
      name: 'Film',
      folder: '/mnt/media/film',
      flowId: 'a_CeSjPzb',
    });
    expect(libraries[1]!.flowId).toBeUndefined();
  });

  it('reads worker nodes out of the keyed object the API returns', async () => {
    const fetchImpl = stubFetch(() => ({
      d6qJWmgdV: { _id: 'd6qJWmgdV', nodeName: 'Nvidia', nodePaused: false },
      L9AKO5tqN: { _id: 'L9AKO5tqN', nodeName: 'Intel', nodePaused: true },
    }));

    expect(await client(fetchImpl).listNodes()).toEqual([
      { id: 'd6qJWmgdV', name: 'Nvidia', paused: false },
      { id: 'L9AKO5tqN', name: 'Intel', paused: true },
    ]);
  });

  it('copes with a collection that is not an array', async () => {
    const fetchImpl = stubFetch(() => ({ error: 'nope' }));
    await expect(client(fetchImpl).getFlows()).resolves.toEqual([]);
    await expect(client(fetchImpl).listLibraries()).resolves.toEqual([]);
  });
});

describe('TdarrClient writes', () => {
  const flow = compileSpec(pipelineSpec);

  it('updates by id when told to update', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = stubFetch((_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return {};
    });

    await client(fetchImpl).saveFlow(flow, { mode: 'update' });
    expect(bodies[0]).toMatchObject({
      data: { collection: 'FlowsJSONDB', mode: 'update', docID: flow._id },
    });
  });

  it('inserts without a docID when told to insert', async () => {
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = stubFetch((_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return {};
    });

    await client(fetchImpl).saveFlow(flow, { mode: 'insert' });
    expect(bodies[0]!['data'].mode).toBe('insert');
    expect(bodies[0]!['data'].docID).toBeUndefined();
  });

  it('requires the mode to be stated rather than inferring it', () => {
    // Inferring from "does this id already exist" would mean a typo in an id
    // silently creates a second flow instead of updating the intended one.
    // @ts-expect-error mode is required
    expect(() => client(stubFetch(() => ({}))).saveFlow(flow, {})).toBeDefined();
  });
});

describe('verifyAgainstFlows', () => {
  it('confirms an assumption when a real flow wires the error handle', () => {
    // moveToDirectory's error handle is a curated guess. A flow that routes its
    // err1 somewhere is proof the handle exists.
    const flow = makeFlow(
      [
        node('a', 'inputFile'),
        node('b', 'moveToDirectory', {}, { version: '2.0.0' }),
        node('c', 'resetFlowError'),
      ],
      [edge('a', 1, 'b'), edge('b', 'err1', 'c')],
      'Delivery',
    );

    const report = verifyAgainstFlows([flow]);
    expect(report.confirmed.map((e) => e.ref)).toContain('moveToDirectory@2.0.0');
    expect(report.confirmed[0]!.seenIn).toEqual(['Delivery']);
  });

  it('reports the catalog as wrong when a plugin it says cannot fail does', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'checkVideoCodec'), node('c', 'resetFlowError')],
      [edge('a', 1, 'b'), edge('b', 'err1', 'c')],
      'Odd',
    );

    const report = verifyAgainstFlows([flow]);
    expect(report.contradicted.map((e) => e.ref)).toEqual(['checkVideoCodec@1.0.0']);
    expect(report.ok).toBe(false);
  });

  it('leaves observed entries alone - they need no confirming', () => {
    const report = verifyAgainstFlows([compileSpec(pipelineSpec)]);
    expect(report.confirmed.map((e) => e.ref)).not.toContain('runMkvPropEdit@1.0.0');
    expect(report.contradicted).toEqual([]);
  });

  it('lists assumptions no flow exercises, without calling them wrong', () => {
    const report = verifyAgainstFlows([]);
    expect(report.unconfirmed.length).toBeGreaterThan(5);
    expect(report.unconfirmed.every((e) => e.seenIn.length === 0)).toBe(true);
    // Absence of evidence is not evidence of absence, so this alone is not a failure.
    expect(report.ok).toBe(true);
  });

  it('flags a plugin version the catalog does not have', () => {
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'checkVideoCodec', {}, { version: '9.9.9' })],
      [edge('a', 1, 'b')],
      'Future',
    );

    const report = verifyAgainstFlows([flow]);
    expect(report.versionGaps[0]).toMatchObject({
      ref: 'checkVideoCodec@9.9.9',
      known: ['1.0.0'],
    });
  });

  it('does not treat a Local plugin as a gap', () => {
    // The catalog was never going to have it, so its absence says nothing.
    const flow = makeFlow(
      [node('a', 'inputFile'), node('b', 'normaliseAudioTracks', {}, { sourceRepo: 'Local' })],
      [edge('a', 1, 'b')],
      'Local',
    );
    expect(verifyAgainstFlows([flow]).versionGaps).toEqual([]);
  });

  it('formats a readable report', () => {
    const report = verifyAgainstFlows([compileSpec(pipelineSpec)]);
    const text = formatVerifyReport(report);

    expect(text).toMatch(/examined 1 flow$/m);
    expect(text).toMatch(/still unconfirmed/);
  });
});
