/**
 * A browser-safe client for the Tdarr server API.
 *
 * No backend or proxy is needed: Tdarr answers cross-origin requests, so a
 * static page can talk to it directly. Two constraints shape this file, both
 * discovered by probing a real 2.86.01 server rather than from documentation:
 *
 *  - **Auth goes in a configurable header, defaulting to `Authorization`.**
 *    Tdarr's own convention is `x-api-key`, but a server behind the usual nginx
 *    config advertises a fixed `Access-Control-Allow-Headers` list that does
 *    *not* include it, so a browser refuses the request at the preflight before
 *    it is ever sent. `Authorization` is on that list. Whether a given Tdarr
 *    build accepts its API key that way is not something this library can
 *    promise - hence `authHeader`, so the caller can switch it and, if needed,
 *    add the header to their proxy's allow-list.
 *
 *  - **Credentials are never included.** A server sending
 *    `Access-Control-Allow-Origin: *` cannot also accept credentialed requests;
 *    the two are mutually exclusive by spec. Cookie-based auth therefore needs
 *    the server to echo a specific origin instead, which is a server change, not
 *    a client one.
 *
 * The API is not versioned separately from the app and endpoint shapes have
 * moved between releases, so everything goes through `raw()` and collection
 * names are parameters. If a convenience method 404s on your server, call
 * `raw()` directly rather than fighting the wrapper.
 */

import type { FlowJson } from '../types/flow.ts';

export interface TdarrClientOptions {
  /** Base URL, e.g. `https://tdarr.example.com`. */
  url: string;
  /** Sent only when set. Omitted entirely when blank. */
  token?: string;
  /**
   * Header the token goes in. `Authorization` by default - see the note above
   * on why `x-api-key` usually cannot be used from a browser.
   */
  authHeader?: string;
  timeoutMs?: number;
  /** Injectable, so the write paths can be tested without a live server. */
  fetchImpl?: typeof fetch;
}

export interface CrudRequest {
  collection: string;
  mode: 'getAll' | 'getById' | 'insert' | 'update' | 'delete';
  docID?: string;
  obj?: unknown;
}

export interface ServerStatus {
  status: string;
  version: string;
  os?: string;
  uptime?: number;
}

export interface FlowSummary {
  id: string;
  name: string;
  description?: string;
  nodeCount: number;
  edgeCount: number;
}

export interface LibrarySummary {
  id: string;
  name: string;
  folder?: string;
  /** The flow this library runs, when it is in flow mode. */
  flowId?: string;
}

export interface NodeSummary {
  id: string;
  name: string;
  paused: boolean;
}

export class TdarrError extends Error {
  readonly status: number | undefined;
  /** True when the request never reached the server - DNS, TLS, CORS, offline. */
  readonly isNetwork: boolean;

  constructor(message: string, options: { status?: number; isNetwork?: boolean } = {}) {
    super(message);
    this.name = 'TdarrError';
    this.status = options.status;
    this.isNetwork = options.isNetwork ?? false;
  }
}

export class TdarrClient {
  readonly url: string;
  readonly #token: string | undefined;
  readonly #authHeader: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: TdarrClientOptions) {
    this.url = options.url.trim().replace(/\/+$/, '');
    this.#token = options.token?.trim() || undefined;
    this.#authHeader = options.authHeader || 'Authorization';
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** GET when no body is given, POST when there is one. */
  async raw<T = unknown>(path: string, body?: unknown): Promise<T> {
    const target = `${this.url}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.#token) headers[this.#authHeader] = this.#token;

    let response: Response;
    try {
      response = await this.#fetch(target, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // A browser reports a CORS rejection as an indistinguishable network
      // failure, so the message has to name the possibilities rather than
      // pretend to know which one happened.
      throw new TdarrError(
        `could not reach ${target}. The server may be down or unreachable from this network, or `
          + 'it may be refusing cross-origin requests from this page.',
        { isNetwork: true },
      );
    }

    if (!response.ok) {
      const detail = response.status === 401 || response.status === 403
        ? ' The server rejected the credentials - check the API key, and that your reverse proxy '
          + `allows the "${this.#authHeader}" header through CORS.`
        : '';
      throw new TdarrError(`${target} returned ${response.status}.${detail}`, {
        status: response.status,
      });
    }

    return (await response.json()) as T;
  }

  async status(): Promise<ServerStatus> {
    return this.raw<ServerStatus>('/api/v2/status');
  }

  /** Whether the server answers at all. Never throws. */
  async ping(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }

  async crud<T = unknown>(request: CrudRequest): Promise<T> {
    return this.raw<T>('/api/v2/cruddb', { data: request });
  }

  async getFlows(collection = 'FlowsJSONDB'): Promise<FlowJson[]> {
    const rows = await this.crud<FlowJson[]>({ collection, mode: 'getAll' });
    return Array.isArray(rows) ? rows : [];
  }

  async listFlows(collection = 'FlowsJSONDB'): Promise<FlowSummary[]> {
    return (await this.getFlows(collection)).map((row) => ({
      id: row._id,
      name: row.name,
      description: row.description,
      nodeCount: row.flowPlugins?.length ?? 0,
      edgeCount: row.flowEdges?.length ?? 0,
    }));
  }

  async getFlow(id: string, collection = 'FlowsJSONDB'): Promise<FlowJson> {
    const match = (await this.getFlows(collection)).find((row) => row._id === id);
    if (!match) throw new TdarrError(`no flow with id "${id}" on ${this.url}`);
    return match;
  }

  /**
   * Writes a flow back.
   *
   * `mode` is explicit rather than inferred from whether the id already exists.
   * Guessing would mean a typo in an id silently creates a second flow instead
   * of updating the one the user meant, and the caller is the only thing that
   * knows which was intended.
   */
  async saveFlow(
    flow: FlowJson,
    options: { mode: 'insert' | 'update'; collection?: string },
  ): Promise<void> {
    const collection = options.collection ?? 'FlowsJSONDB';

    if (options.mode === 'update') {
      await this.crud({ collection, mode: 'update', docID: flow._id, obj: flow });
      return;
    }
    await this.crud({ collection, mode: 'insert', obj: flow });
  }

  async listLibraries(collection = 'LibrarySettingsJSONDB'): Promise<LibrarySummary[]> {
    const rows = await this.crud<Record<string, unknown>[]>({ collection, mode: 'getAll' });
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => ({
      id: String(row['_id'] ?? ''),
      name: String(row['name'] ?? ''),
      folder: row['folder'] === undefined ? undefined : String(row['folder']),
      flowId: typeof row['flowId'] === 'string' ? row['flowId'] : undefined,
    }));
  }

  /**
   * The worker nodes. Their names are what a flow's hardware branches match on,
   * so knowing them turns "type the node name exactly" into a choice.
   */
  async listNodes(): Promise<NodeSummary[]> {
    const body = await this.raw<Record<string, Record<string, unknown>>>('/api/v2/get-nodes');
    if (!body || typeof body !== 'object') return [];

    return Object.entries(body).map(([id, node]) => ({
      id: String(node?.['_id'] ?? id),
      name: String(node?.['nodeName'] ?? id),
      paused: node?.['nodePaused'] === true,
    }));
  }
}
