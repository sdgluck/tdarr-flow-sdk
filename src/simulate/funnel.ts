/**
 * Folding a library's worth of traces into a report.
 *
 * The contract that matters is that `add` retains **nothing per file** - only
 * counters, plus a handful of sample ids kept deliberately. A library is a
 * quarter of a gigabyte of records and the answer is a few dozen numbers, so
 * anything that accumulated per-file state would put a ceiling on the library
 * size this can handle, and it would be a ceiling nobody discovered until a scan
 * died on a big library.
 *
 * The samples are the exception, and they are worth their fixed cost: a number
 * with no way to check it is a number nobody should believe. Five ids per
 * verdict, each with the decisions that produced it, is what lets someone open a
 * file and see for themselves why it landed where it did.
 */

import { getPluginByRef } from '../catalog/index.ts';
import type { PluginRefString } from '../types/catalog.ts';
import { interpret } from './interpret.ts';
import type { Branch, PreparedFlow, Trace, Verdict } from './interpret.ts';
import type { MediaRecord } from './record.ts';

export interface Bucket {
  files: number;
  /** Decimal MB, as Tdarr reports it. */
  megabytes: number;
}

export interface GateOutcome {
  handle: number;
  /** The catalog's own wording for this handle, e.g. "File medium is a Video". */
  label: string;
  /** False when nothing is wired here - the files stop. */
  wired: boolean;
  bucket: Bucket;
}

export interface GateStep {
  nodeId: string;
  ref: string;
  name: string;
  reached: Bucket;
  outcomes: GateOutcome[];
}

export interface ValueCount {
  value: string;
  scanned: Bucket;
  modified: Bucket;
}

export interface Breakdown {
  /** The record property, e.g. `video_codec_name`. */
  key: string;
  label: string;
  values: ValueCount[];
}

export interface StoppedAt {
  nodeId: string;
  ref: string;
  name: string;
  reason: string;
  bucket: Bucket;
}

export interface Sample {
  id: string;
  branches: Branch[];
}

export interface ScanReport {
  scanned: Bucket;
  /** Files the flow would do work on. */
  modified: Bucket;
  /**
   * Of `modified`: work happens, but an unknowable guard decides whether the
   * result is kept. A subset, never a separate total.
   */
  retentionUncertain: Bucket;
  /** Walked to the end without anything acting. */
  untouched: Bucket;
  /** A gate sent them down a path with nothing on it. */
  rejected: Bucket;
  /** The walk could not finish. Never folded into any of the above. */
  indeterminate: Bucket;
  funnel: GateStep[];
  /** Stopped by something that cannot be known before the flow runs. */
  unknowns: StoppedAt[];
  /** Stopped by a plugin this SDK has no simulator for. A gap, not a fact. */
  unmodelled: StoppedAt[];
  /** Stopped because the plugin would throw on the record, as it would in Tdarr. */
  errored: StoppedAt[];
  breakdowns: Breakdown[];
  samples: Record<Verdict, Sample[]>;
  /** Rows that were not usable file records at all. */
  skipped: number;
}

const BREAKDOWN_KEYS: Array<{ key: keyof MediaRecord; label: string }> = [
  { key: 'video_codec_name', label: 'Video codec' },
  { key: 'audio_codec_name', label: 'Audio codec' },
  { key: 'container', label: 'Container' },
  { key: 'video_resolution', label: 'Resolution' },
];

const empty = (): Bucket => ({ files: 0, megabytes: 0 });

function fold(bucket: Bucket, record: MediaRecord): void {
  bucket.files += 1;
  bucket.megabytes += record.file_size;
}

/**
 * The catalog's per-handle wording, which is better copy than we would write:
 * "File medium is a Video" beats "output 1". Falls back to the simulator's own
 * `handles` map, which covers refs the catalog does not carry.
 */
function handleLabel(prepared: PreparedFlow, nodeId: string, ref: string, handle: number): string {
  const tooltip = getPluginByRef(ref as PluginRefString)?.outputs?.[handle - 1]?.tooltip;
  if (tooltip?.trim()) return tooltip.trim();
  const declared = prepared.nodes.get(nodeId)?.simulator?.handles[handle];
  return declared?.trim() || `output ${handle}`;
}

export interface AccumulatorOptions {
  /** Sample ids kept per verdict. Fixed cost, so it does not grow with the library. */
  sampleSize?: number;
}

export class ScanAccumulator {
  readonly #prepared: PreparedFlow;
  readonly #sampleSize: number;

  readonly #scanned = empty();
  readonly #byVerdict = new Map<Verdict, Bucket>();
  readonly #retention = empty();
  readonly #samples = new Map<Verdict, Sample[]>();

  /** nodeId -> handle -> bucket. */
  readonly #gates = new Map<string, Map<number, Bucket>>();
  readonly #reached = new Map<string, Bucket>();
  readonly #stops = new Map<string, { stop: StoppedAt; kind: string }>();
  /** key -> value -> [scanned, modified]. */
  readonly #breakdowns = new Map<string, Map<string, [Bucket, Bucket]>>();

  #skipped = 0;

  constructor(prepared: PreparedFlow, options: AccumulatorOptions = {}) {
    this.#prepared = prepared;
    this.#sampleSize = options.sampleSize ?? 5;
  }

  /** Counts a row that could not be projected into a record. */
  skip(): void {
    this.#skipped += 1;
  }

  add(record: MediaRecord): void {
    const trace = interpret(this.#prepared, record);
    fold(this.#scanned, record);

    const bucket = this.#byVerdict.get(trace.verdict) ?? empty();
    fold(bucket, record);
    this.#byVerdict.set(trace.verdict, bucket);
    if (trace.retentionUncertain) fold(this.#retention, record);

    for (const branch of trace.branches) {
      const reached = this.#reached.get(branch.nodeId) ?? empty();
      fold(reached, record);
      this.#reached.set(branch.nodeId, reached);

      const handles = this.#gates.get(branch.nodeId) ?? new Map<number, Bucket>();
      const slot = handles.get(branch.handle) ?? empty();
      fold(slot, record);
      handles.set(branch.handle, slot);
      this.#gates.set(branch.nodeId, handles);
    }

    this.#recordStop(trace, record);
    this.#recordBreakdowns(record, trace.verdict === 'modifies');

    const samples = this.#samples.get(trace.verdict) ?? [];
    if (samples.length < this.#sampleSize) {
      samples.push({ id: record._id, branches: trace.branches });
      this.#samples.set(trace.verdict, samples);
    }
  }

  #recordStop(trace: Trace, record: MediaRecord): void {
    const { stop } = trace;
    if (stop.kind !== 'unknowable' && stop.kind !== 'unmodelled' && stop.kind !== 'threw') return;

    const existing = this.#stops.get(stop.nodeId);
    if (existing) {
      fold(existing.stop.bucket, record);
      return;
    }

    const node = this.#prepared.nodes.get(stop.nodeId);
    const bucket = empty();
    fold(bucket, record);
    this.#stops.set(stop.nodeId, {
      kind: stop.kind,
      stop: {
        nodeId: stop.nodeId,
        ref: stop.ref,
        name: node?.name ?? stop.ref,
        reason: stop.kind === 'unmodelled'
          ? 'this SDK has no simulator for the plugin'
          : (stop as { reason: string }).reason,
        bucket,
      },
    });
  }

  #recordBreakdowns(record: MediaRecord, modified: boolean): void {
    for (const { key } of BREAKDOWN_KEYS) {
      const raw = record[key];
      const value = raw === undefined || raw === '' ? '(none)' : String(raw);
      const values = this.#breakdowns.get(key) ?? new Map<string, [Bucket, Bucket]>();
      const pair = values.get(value) ?? [empty(), empty()];
      fold(pair[0], record);
      if (modified) fold(pair[1], record);
      values.set(value, pair);
      this.#breakdowns.set(key, values);
    }
  }

  report(): ScanReport {
    const verdict = (name: Verdict): Bucket => this.#byVerdict.get(name) ?? empty();

    const funnel: GateStep[] = [];
    for (const gate of this.#prepared.gates) {
      const handles = this.#gates.get(gate.id);
      if (!handles) continue;
      funnel.push({
        nodeId: gate.id,
        ref: gate.ref,
        name: gate.name,
        reached: this.#reached.get(gate.id) ?? empty(),
        outcomes: [...handles.entries()]
          .sort(([a], [b]) => a - b)
          .map(([handle, bucket]) => ({
            handle,
            label: handleLabel(this.#prepared, gate.id, gate.ref, handle),
            wired: gate.out.has(handle),
            bucket,
          })),
      });
    }

    const stopsOf = (kind: string): StoppedAt[] =>
      [...this.#stops.values()]
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.stop)
        .sort((a, b) => b.bucket.files - a.bucket.files);

    const breakdowns: Breakdown[] = BREAKDOWN_KEYS.map(({ key, label }) => ({
      key,
      label,
      values: [...(this.#breakdowns.get(key) ?? new Map()).entries()]
        .map(([value, [scanned, modified]]) => ({ value, scanned, modified }))
        .sort((a, b) => b.scanned.files - a.scanned.files),
    })).filter((breakdown) => breakdown.values.length > 0);

    return {
      scanned: this.#scanned,
      modified: verdict('modifies'),
      retentionUncertain: this.#retention,
      untouched: verdict('untouched'),
      rejected: verdict('rejected'),
      indeterminate: verdict('indeterminate'),
      funnel,
      unknowns: stopsOf('unknowable'),
      unmodelled: stopsOf('unmodelled'),
      errored: stopsOf('threw'),
      breakdowns,
      samples: {
        modifies: this.#samples.get('modifies') ?? [],
        untouched: this.#samples.get('untouched') ?? [],
        rejected: this.#samples.get('rejected') ?? [],
        indeterminate: this.#samples.get('indeterminate') ?? [],
      },
      skipped: this.#skipped,
    };
  }
}
