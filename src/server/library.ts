/**
 * Reading every file record out of a Tdarr library.
 *
 * Everything here is shaped by what a real 2.86.01 server does, probed rather
 * than read from documentation, because the documentation does not exist and the
 * endpoint's own schema is misleading:
 *
 *  - `POST /api/v2/search-db` **requires** all eight fields of its request body -
 *    it 400s naming each missing one in turn - and then **ignores all of them
 *    except `string`**. `pageSize: 1` returns 10,000 rows. `lastId` set to the
 *    last row's `_id` returns a byte-identical page. `filters`, `sorts`, `opts`,
 *    `greaterThanGB` and `lessThanGB` change nothing. There is no pagination and
 *    there is no server-side filtering.
 *
 *  - Responses are **capped at 10,000 rows**, and the cap is silent. A library
 *    of 23,846 files answers a naive query with 10,000 records and no indication
 *    that 13,846 are missing. Trusting that number would mean reporting, with
 *    total confidence, on 42% of a library.
 *
 *  - Nothing aggregates server-side. `client/scanned-files`,
 *    `client/status-request` and `client/library-stats` all validate their input
 *    and then return `{array: [], totalCount: 0}`; `list-files`, `get-files`,
 *    `stats` and `statistics` 404; `StatisticsJSONDB.pies` is empty.
 *
 * So the whole library has to be pulled through a 10,000-row window, uncompressed
 * (there is no gzip - 44 MB takes about 3.5 s), and reduced as it arrives.
 *
 * # Getting past the cap
 *
 * `string` works. It is a substring match on the file path, which is enough to
 * partition a library by directory. The trick is what to do with a response that
 * came back capped: it is useless as *data*, since there is no way to ask for the
 * rows it left out - but it is a perfectly good **directory listing**. Splitting
 * on the next path segment of the 10,000 paths it did return turns one wasted
 * request into hundreds of prefixes that each fit under the cap. In practice that
 * bottoms out after two or three rounds.
 *
 * That trick needs a response, though. A prefix whose query keeps *failing*
 * cannot be narrowed at all - naming its children means running the query that
 * is failing, and there is no directory listing endpoint to ask instead. Such a
 * prefix is recorded in `ScanSummary.failed` and the scan continues, so the hole
 * is visible in the report rather than hidden inside a plausible-looking total.
 */

import { project } from '../simulate/record.ts';
import type { MediaRecord } from '../simulate/record.ts';
import { TdarrError } from './client.ts';
import type { TdarrClient } from './client.ts';

/**
 * The seven fields beyond `string` that the server demands and then ignores.
 *
 * Kept as one frozen object rather than inlined, because omitting any single one
 * of them turns every request into a 400 and the failure names only the first
 * missing field.
 */
export const SEARCH_DB_DEFAULTS = Object.freeze({
  lastId: '',
  pageSize: 10_000,
  filters: [] as unknown[],
  sorts: [] as unknown[],
  opts: {} as Record<string, unknown>,
  greaterThanGB: 0,
  lessThanGB: 1_000_000,
});

export interface ScanProgress {
  phase: 'discovering' | 'scanning' | 'done';
  /** Prefixes still queued. Grows when a capped response is split. */
  pending: number;
  /** Prefixes finished. */
  done: number;
  /** What is being read right now. */
  current: string;
  filesSeen: number;
  /** Present once the total is known, so a coverage bar can be honest. */
  expectedFiles?: number;
  /** Set while waiting out a failure, so a long pause does not look like a hang. */
  retrying?: { attempt: number; waitMs: number; reason: string };
}

export interface Truncation {
  prefix: string;
  seen: number;
}

export interface ScanSummary {
  emitted: number;
  /** Rows that were not usable file records. */
  skipped: number;
  /**
   * Rows dropped because another prefix already yielded them. `string` matches a
   * substring, so `/mnt/media/tv/` also matches `/backup/mnt/media/tv/x.mkv`.
   */
  duplicatesSuppressed: number;
  /** Prefixes that stayed capped and could not be split further. */
  truncated: Truncation[];
  /** Prefixes abandoned after repeated failures. The scan continued regardless. */
  failed: Array<{ prefix: string; reason: string }>;
  /** `totalFileCount` from the server, when it could be read. */
  expectedFiles?: number;
  /** True when every file the server claims to have was seen. */
  complete: boolean;
}

export interface ScanOptions {
  /** Path prefixes to start from. Defaults to the libraries' own folders. */
  roots?: string[];
  /** Keep only records whose `DB` is one of these. Filtered here; the server ignores `filters`. */
  libraries?: string[];
  /** Rows at or above this count mean the response was capped. */
  pageCap?: number;
  /** Runaway guard on prefix depth, not a tuning parameter. */
  maxDepth?: number;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /** Injected so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so retry delays are deterministic in tests. */
  jitter?: () => number;
}

const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface SearchRow {
  _id?: unknown;
}

/**
 * Walks every file record, calling `consume` once per distinct file.
 *
 * `consume` is called synchronously as each response is walked and the raw row
 * is dropped immediately afterwards, so memory stays flat regardless of library
 * size. The one unavoidable peak is `response.json()` on a capped page, which is
 * about 106 MB; parsing that incrementally would need a streaming JSON parser,
 * and the SDK has no runtime dependencies.
 */
export async function scanLibrary(
  client: TdarrClient,
  consume: (record: MediaRecord) => void,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const pageCap = options.pageCap ?? 10_000;
  const maxDepth = options.maxDepth ?? 12;
  const retries = options.retries ?? BACKOFF_MS.length;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? (() => 1);
  const wanted = options.libraries?.length ? new Set(options.libraries) : undefined;

  const summary: ScanSummary = {
    emitted: 0,
    skipped: 0,
    duplicatesSuppressed: 0,
    truncated: [],
    failed: [],
    complete: false,
  };

  const seen = new Set<string>();
  let done = 0;

  const report = (
    phase: ScanProgress['phase'],
    current: string,
    pending: number,
    retrying?: ScanProgress['retrying'],
  ): void => {
    options.onProgress?.({
      phase,
      pending,
      done,
      current,
      filesSeen: summary.emitted,
      ...(summary.expectedFiles === undefined ? {} : { expectedFiles: summary.expectedFiles }),
      ...(retrying ? { retrying } : {}),
    });
  };

  report('discovering', 'libraries', 0);
  summary.expectedFiles = await readTotalFileCount(client);

  const queue: Array<{ prefix: string; depth: number }> = [];
  const roots = options.roots ?? await readRoots(client);
  for (const root of roots) queue.push({ prefix: normalise(root), depth: 0 });
  if (queue.length === 0) queue.push({ prefix: '', depth: 0 });

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const { prefix, depth } = queue.pop()!;
    report('scanning', prefix, queue.length);

    let rows: SearchRow[] | undefined;
    let lastError = '';

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.signal?.aborted) break;
      try {
        rows = await search(client, prefix);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!isRetryable(error) || attempt === retries) break;
        const waitMs = Math.round((BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 1_000)
          * jitter());
        report('scanning', prefix, queue.length, { attempt: attempt + 1, waitMs, reason: lastError });
        await sleep(waitMs);
      }
    }

    if (options.signal?.aborted) break;

    if (!rows) {
      // Nothing clever is possible here. Narrowing the query would very likely
      // succeed - a 502 on a wide prefix is usually the response being too big -
      // but the only way to learn the child directory names is to run this exact
      // query, and it is the one that keeps failing. There is no directory
      // listing endpoint to fall back on. So the prefix is recorded and the scan
      // carries on; the summary makes the hole visible rather than papering over
      // it with a total that quietly excludes a subtree.
      summary.failed.push({ prefix, reason: lastError || 'unknown error' });
      done += 1;
      continue;
    }

    if (rows.length >= pageCap) {
      // Capped: the rows are an unusable sample, but a usable directory listing.
      const children = depth < maxDepth ? splitOn(rows, prefix) : [];
      if (children.length > 0) {
        for (const child of children) queue.push({ prefix: child, depth: depth + 1 });
      } else {
        // Nothing left to split on - every row is a direct child of this prefix.
        // There is no server-side escape, so emit what we have and say plainly
        // that the total is a floor rather than a count.
        emit(rows);
        summary.truncated.push({ prefix, seen: rows.length });
      }
      done += 1;
      continue;
    }

    emit(rows);
    done += 1;
  }

  summary.complete = summary.truncated.length === 0 && summary.failed.length === 0
    && !options.signal?.aborted
    && (summary.expectedFiles === undefined || summary.emitted >= summary.expectedFiles);

  report('done', '', 0);
  return summary;

  function emit(rows: SearchRow[]): void {
    for (const row of rows) {
      const id = typeof row._id === 'string' ? row._id : undefined;
      if (id !== undefined && seen.has(id)) {
        summary.duplicatesSuppressed += 1;
        continue;
      }

      const record = project(row);
      if (!record) {
        summary.skipped += 1;
        continue;
      }
      seen.add(record._id);
      if (wanted && !wanted.has(record.DB)) continue;

      summary.emitted += 1;
      consume(record);
    }
  }
}

function normalise(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

async function search(client: TdarrClient, prefix: string): Promise<SearchRow[]> {
  const rows = await client.raw<SearchRow[]>('/api/v2/search-db', {
    data: { string: prefix, ...SEARCH_DB_DEFAULTS },
  });
  return Array.isArray(rows) ? rows : [];
}

/**
 * The distinct next path segments below `prefix`, each as a prefix of its own.
 *
 * Rows that do not start with `prefix` are ignored here: `string` is a substring
 * match, so a capped page can contain paths from elsewhere entirely, and
 * splitting on those would produce prefixes that go nowhere.
 */
function splitOn(rows: SearchRow[], prefix: string): string[] {
  const segments = new Set<string>();
  for (const row of rows) {
    const id = typeof row._id === 'string' ? row._id : undefined;
    if (!id || !id.startsWith(prefix)) continue;
    const rest = id.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    segments.add(`${prefix}${rest.slice(0, slash)}/`);
  }
  return [...segments];
}

async function readRoots(client: TdarrClient): Promise<string[]> {
  try {
    const libraries = await client.listLibraries();
    return libraries.map((library) => library.folder ?? '').filter((folder) => folder.length > 0);
  } catch {
    return [];
  }
}

/**
 * `totalFileCount` from `StatisticsJSONDB`, which is what makes "complete
 * coverage" a checkable claim rather than a hope.
 */
async function readTotalFileCount(client: TdarrClient): Promise<number | undefined> {
  try {
    const rows = await client.crud<Array<{ totalFileCount?: unknown }>>({
      collection: 'StatisticsJSONDB',
      mode: 'getAll',
    });
    const total = Array.isArray(rows) ? rows[0]?.totalFileCount : undefined;
    return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Worth another go?
 *
 * `isNetwork` is included because a 502 from the proxy in front of Tdarr
 * sometimes reaches the browser as an indistinguishable network failure, and
 * treating those as permanent would abandon prefixes that would have succeeded.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof TdarrError)) return false;
  if (error.isNetwork) return true;
  return error.status !== undefined && (error.status >= 500 || error.status === 429);
}
