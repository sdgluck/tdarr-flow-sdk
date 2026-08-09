/**
 * The library scanner, against a fake server that reproduces the real one's
 * awkward behaviour: a hard 10,000-row cap, no pagination, and a `string` field
 * that is the only thing it honours.
 *
 * `sleep` is injected throughout, so the backoff tests assert the delays without
 * spending them.
 */

import { describe, expect, it, vi } from 'vitest';
import { TdarrClient } from '../src/server/client.ts';
import { scanLibrary, SEARCH_DB_DEFAULTS } from '../src/server/library.ts';
import type { MediaRecord } from '../src/simulate/index.ts';

const file = (path: string) => ({
  _id: path,
  DB: 'lib1',
  file_size: 100,
  fileMedium: 'video',
  ffProbeData: { streams: [{ codec_type: 'video', codec_name: 'hevc' }] },
});

/**
 * A server that answers `search-db` from a fixed list of paths, applying the
 * substring match and the row cap exactly as the real one does.
 */
function fakeServer(paths: string[], options: { cap?: number; fail?: Map<string, number> } = {}) {
  const cap = options.cap ?? 10_000;
  const fail = options.fail ?? new Map<string, number>();
  const requests: Array<{ path: string; body: unknown }> = [];

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: target, body });

    if (target.endsWith('/api/v2/cruddb')) {
      const collection = body?.data?.collection;
      if (collection === 'StatisticsJSONDB') {
        return json([{ totalFileCount: paths.length }]);
      }
      if (collection === 'LibrarySettingsJSONDB') {
        return json([{ _id: 'lib1', name: 'Film', folder: '/mnt/media/film' }]);
      }
      return json([]);
    }

    if (target.endsWith('/api/v2/search-db')) {
      const query = String(body?.data?.string ?? '');
      const remaining = fail.get(query);
      if (remaining !== undefined && remaining > 0) {
        fail.set(query, remaining - 1);
        return { ok: false, status: 502, json: async () => ({}) } as Response;
      }
      const matched = paths.filter((path) => path.includes(query));
      return json(matched.slice(0, cap).map(file));
    }

    return json({});
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

const json = (value: unknown) =>
  ({ ok: true, status: 200, json: async () => value }) as Response;

const client = (fetchImpl: typeof fetch) =>
  new TdarrClient({ url: 'https://tdarr.example.com', fetchImpl });

const collect = () => {
  const records: MediaRecord[] = [];
  return { records, consume: (record: MediaRecord) => void records.push(record) };
};

const sleep = vi.fn(async () => {});

describe('the request the server demands', () => {
  it('sends all eight required fields', async () => {
    // Omit any one of these and every request 400s, naming only the first
    // missing field. Nothing else in the suite would notice.
    const { fetchImpl, requests } = fakeServer(['/mnt/media/film/a.mkv']);
    const { consume } = collect();
    await scanLibrary(client(fetchImpl), consume, { sleep });

    const search = requests.find((request) => request.path.endsWith('/api/v2/search-db'));
    const data = (search!.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort())
      .toEqual(['string', ...Object.keys(SEARCH_DB_DEFAULTS)].sort());
  });
});

describe('getting past the 10,000-row cap', () => {
  it('splits a capped prefix on its next path segment', async () => {
    // 12 files over two shows, with a cap of 10: the root query comes back
    // capped and useless, and the split turns it into two queries that fit.
    const paths = [
      ...Array.from({ length: 6 }, (_, i) => `/mnt/media/tv/Show A/S01E0${i}.mkv`),
      ...Array.from({ length: 6 }, (_, i) => `/mnt/media/tv/Show B/S01E0${i}.mkv`),
    ];
    const { fetchImpl } = fakeServer(paths, { cap: 10 });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv'],
      pageCap: 10,
      sleep,
    });

    expect(records).toHaveLength(12);
    expect(summary.emitted).toBe(12);
    expect(summary.truncated).toEqual([]);
    expect(new Set(records.map((record) => record._id)).size).toBe(12);
  });

  it('emits each file once when prefixes overlap', async () => {
    // `string` is a substring match, so a backup path matches the same query.
    // Without the dedup set both copies would be counted and every total would
    // be quietly inflated.
    const paths = ['/mnt/media/film/a.mkv', '/backup/mnt/media/film/a.mkv'];
    const { fetchImpl } = fakeServer(paths, { cap: 10 });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film', '/backup/mnt/media/film'],
      pageCap: 10,
      sleep,
    });

    expect(records).toHaveLength(2);
    expect(summary.duplicatesSuppressed).toBeGreaterThan(0);
  });

  it('splits a flat folder too, one character at a time', async () => {
    // Files sitting directly in a folder have no sub-folder to split on. Char
    // splitting still separates them - `movie1` and `movie2` diverge at the
    // sixth character - which is the case that folder-name splitting could only
    // report as unreadable.
    const paths = Array.from({ length: 10 }, (_, i) => `/mnt/media/film/movie${i}.mkv`);
    const { fetchImpl } = fakeServer(paths, { cap: 5 });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      pageCap: 5,
      sleep,
    });

    expect(records).toHaveLength(10);
    expect(summary.truncated).toEqual([]);
  });

  it('finds files whose character the capped page never showed', async () => {
    // Measured on the real library: querying /mnt/media/tv/ returns 10,000 rows
    // covering `1 3 5 A` through `Y`, with no `Z` anywhere in them - while
    // /mnt/media/tv/Z on its own returns six real files. Splitting on only what
    // the page showed loses them, and loses them silently.
    const paths = [
      ...Array.from({ length: 6 }, (_, i) => `/mnt/media/tv/Alpha/e${i}.mkv`),
      '/mnt/media/tv/Zulu/e1.mkv',
    ];
    // The cap is small enough that the page stops before it reaches Zulu.
    const { fetchImpl } = fakeServer(paths, { cap: 6 });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv'],
      pageCap: 6,
      sleep,
    });

    expect(records.map((record) => record._id)).toContain('/mnt/media/tv/Zulu/e1.mkv');
    expect(summary.emitted).toBe(7);
    expect(summary.complete).toBe(true);
  });

  it('reports truncation when it runs out of room to split', async () => {
    // The last resort. With no depth left there is no server-side escape, so the
    // totals become a floor and must say so.
    const paths = Array.from({ length: 10 }, (_, i) => `/mnt/media/film/movie${i}.mkv`);
    const { fetchImpl } = fakeServer(paths, { cap: 5 });
    const { consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      pageCap: 5,
      maxDepth: 0,
      sleep,
    });

    expect(summary.truncated).toEqual([{ prefix: '/mnt/media/film/', seen: 5 }]);
    expect(summary.complete).toBe(false);
  });

  it('detects the cap with >=, so a raised cap does not silently stop the split', async () => {
    // If the server one day returns 10,001 rows, an `=== 10000` test would call
    // the page uncapped and under-report the library from then on.
    const paths = Array.from({ length: 12 }, (_, i) => `/mnt/media/tv/Show ${i}/e.mkv`);
    const { fetchImpl } = fakeServer(paths, { cap: 12 });
    const { records, consume } = collect();

    await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv'],
      pageCap: 10,
      sleep,
    });
    expect(records).toHaveLength(12);
  });
});

describe('failure handling', () => {
  it('retries a 502 and then succeeds', async () => {
    const fail = new Map([['/mnt/media/film/', 1]]);
    const { fetchImpl } = fakeServer(['/mnt/media/film/a.mkv'], { fail });
    const { records, consume } = collect();
    const waits: number[] = [];

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      sleep: async (ms) => void waits.push(ms),
      jitter: () => 1,
    });

    expect(waits).toEqual([1000]);
    expect(records).toHaveLength(1);
    expect(summary.failed).toEqual([]);
  });

  it('leaves a subtree it could not read visible in the summary', async () => {
    // A prefix that keeps failing cannot be narrowed: the only way to learn its
    // child directory names is the very query that is failing, and Tdarr has no
    // directory listing endpoint. Once even the deferred retry has failed, the
    // subtree goes unread - and the point of this test is that the summary says
    // so, rather than the totals silently omitting a whole library.
    const paths = ['/mnt/media/tv/Show A/e1.mkv', '/mnt/media/film/a.mkv'];
    const fail = new Map([['/mnt/media/tv/', 99]]);
    const { fetchImpl } = fakeServer(paths, { fail });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv', '/mnt/media/film'],
      retries: 1,
      sleep,
    });

    // The healthy root still scanned.
    expect(records.map((record) => record._id)).toEqual(['/mnt/media/film/a.mkv']);
    expect(summary.failed).toEqual([
      expect.objectContaining({ prefix: '/mnt/media/tv/' }),
    ]);
    expect(summary.complete).toBe(false);
  });

  it('comes back to a failed prefix after everything else has been read', async () => {
    // Observed live: a 100 MB response leaves the proxy in front of Tdarr
    // returning 502 for longer than the immediate backoff waits, so the TV
    // library failed all five attempts in a row and then succeeded when tried
    // again at the end. Without this, a third of the library reads as unreadable.
    const paths = ['/mnt/media/tv/Show A/e1.mkv', '/mnt/media/film/a.mkv'];
    // Fails both immediate attempts, then answers on the deferred one.
    const fail = new Map([['/mnt/media/tv/', 2]]);
    const { fetchImpl } = fakeServer(paths, { fail });
    const { records, consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv', '/mnt/media/film'],
      retries: 1,
      sleep,
    });

    expect(records.map((record) => record._id).sort()).toEqual(paths.sort());
    expect(summary.failed).toEqual([]);
    expect(summary.complete).toBe(true);
  });

  it('defers a prefix only once, so a dead subtree cannot loop forever', async () => {
    const fail = new Map([['/mnt/media/film/', 99]]);
    const { fetchImpl } = fakeServer(['/mnt/media/film/a.mkv'], { fail });
    const { consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      retries: 1,
      sleep,
    });

    expect(summary.failed).toHaveLength(1);
  });

  it('records a leaf that cannot be rescued, and carries on', async () => {
    const fail = new Map([['/mnt/media/film/', 99]]);
    const { fetchImpl } = fakeServer(['/mnt/media/film/a.mkv'], { fail });
    const { consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      retries: 1,
      sleep,
    });

    expect(summary.failed).toHaveLength(1);
    expect(summary.complete).toBe(false);
  });

  it('stops promptly when aborted', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/mnt/media/tv/Show ${i}/e.mkv`);
    const { fetchImpl } = fakeServer(paths, { cap: 10 });
    const controller = new AbortController();
    const { records, consume } = collect();

    const summary = await scanLibrary(
      client(fetchImpl),
      (record) => {
        consume(record);
        controller.abort();
      },
      { roots: ['/mnt/media/tv'], pageCap: 10, signal: controller.signal, sleep },
    );

    expect(records.length).toBeLessThan(30);
    expect(summary.complete).toBe(false);
  });
});

describe('coverage', () => {
  it('reconciles against the server\'s own file count', async () => {
    const paths = ['/mnt/media/film/a.mkv', '/mnt/media/film/b.mkv'];
    const { fetchImpl } = fakeServer(paths, { cap: 10 });
    const { consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      pageCap: 10,
      sleep,
    });

    expect(summary.expectedFiles).toBe(2);
    expect(summary.emitted).toBe(2);
    expect(summary.complete).toBe(true);
  });

  it('is not complete when fewer files were seen than the server claims', async () => {
    const { fetchImpl } = fakeServer(['/mnt/media/film/a.mkv', '/elsewhere/b.mkv'], { cap: 10 });
    const { consume } = collect();

    const summary = await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/film'],
      pageCap: 10,
      sleep,
    });

    expect(summary.expectedFiles).toBe(2);
    expect(summary.emitted).toBe(1);
    expect(summary.complete).toBe(false);
  });

  it('reports progress per prefix, not per file', async () => {
    const paths = Array.from({ length: 400 }, (_, i) => `/mnt/media/tv/Show ${i % 2}/e${i}.mkv`);
    const { fetchImpl } = fakeServer(paths);
    const { consume } = collect();
    const updates: number[] = [];

    await scanLibrary(client(fetchImpl), consume, {
      roots: ['/mnt/media/tv'],
      sleep,
      onProgress: (progress) => void updates.push(progress.filesSeen),
    });

    // 400 files, a handful of updates. Firing per row would jank the tab at
    // 23,846 files.
    expect(updates.length).toBeLessThan(10);
  });
});
