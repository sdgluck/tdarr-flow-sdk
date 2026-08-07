/**
 * Checking the catalog's guesses against a real server.
 *
 * The catalog's weakest data is which plugins expose an `err1` handle. Nothing
 * in `details()` reports it, so `catalog/overrides.ts` carries a hand-curated
 * list and about a dozen entries are marked `assumed` - educated guesses that
 * a plugin which shells out can probably fail.
 *
 * Tdarr does not expose plugin definitions over its API. Every plausible route
 * (`list-plugins`, `get-flow-plugins`, `plugins`) 404s on 2.86.01, which is why
 * the Node-side harness reads plugin source off disk instead. But the flows on
 * a server are readable, and they are evidence of a different and rather better
 * kind: **a flow that wires an `err1` edge on a plugin proves that plugin has an
 * error handle**, because the editor would not have offered the handle and the
 * engine would not route to it otherwise. Someone already did the experiment.
 *
 * So this promotes assumptions using flows that exist, and reports the reverse
 * case too - a plugin the catalog claims can fail, which no flow has ever wired
 * an error edge on, is *not* evidence of anything and is reported as merely
 * unconfirmed rather than wrong.
 */

import { getPluginByRef, listPlugins } from '../catalog/index.ts';
import type { FlowJson } from '../types/flow.ts';

export interface ErrorHandleEvidence {
  ref: string;
  /** Flows that wire an err1 edge on this plugin. */
  seenIn: string[];
  /** What the catalog currently believes. */
  catalogued: 'observed' | 'assumed' | 'none';
}

export interface VersionGap {
  ref: string;
  flows: string[];
  /** Versions the catalog does know about, if any. */
  known: string[];
}

export interface VerifyReport {
  /** Server flows the report was built from. */
  flowsExamined: number;
  /**
   * Plugins the catalog only assumed could fail, which a real flow confirms.
   * These are safe to promote to `observed` in catalog/overrides.ts.
   */
  confirmed: ErrorHandleEvidence[];
  /**
   * Plugins wiring err1 that the catalog says have no error handle. The catalog
   * is wrong, and the linter is currently reporting a valid edge as an error.
   */
  contradicted: ErrorHandleEvidence[];
  /** Still guesses: no flow on this server exercises their error path. */
  unconfirmed: ErrorHandleEvidence[];
  /** Plugin versions in use on the server that the catalog does not have. */
  versionGaps: VersionGap[];
  ok: boolean;
}

export function verifyAgainstFlows(flows: readonly FlowJson[]): VerifyReport {
  /** ref -> names of flows that wire err1 on it. */
  const errorEvidence = new Map<string, Set<string>>();
  const seenRefs = new Map<string, Set<string>>();

  for (const flow of flows) {
    const label = flow.name || flow._id;
    const byId = new Map((flow.flowPlugins ?? []).map((n) => [n.id, n]));

    for (const node of flow.flowPlugins ?? []) {
      const ref = `${node.pluginName}@${node.version}`;
      seenRefs.set(ref, (seenRefs.get(ref) ?? new Set()).add(label));
    }

    for (const edge of flow.flowEdges ?? []) {
      if (String(edge.sourceHandle) !== 'err1') continue;
      const source = byId.get(edge.source);
      if (!source) continue;

      const ref = `${source.pluginName}@${source.version}`;
      errorEvidence.set(ref, (errorEvidence.get(ref) ?? new Set()).add(label));
    }
  }

  const confirmed: ErrorHandleEvidence[] = [];
  const contradicted: ErrorHandleEvidence[] = [];

  for (const [ref, flowNames] of errorEvidence) {
    const entry = getPluginByRef(ref);
    const catalogued = !entry?.error ? 'none' : entry.errorConfidence;
    const evidence: ErrorHandleEvidence = {
      ref,
      seenIn: [...flowNames].sort(),
      catalogued,
    };

    // A Local plugin is not in the catalog at all, so there is nothing to
    // contradict - the caller declares its shape.
    if (!entry) continue;
    if (catalogued === 'none') contradicted.push(evidence);
    else if (catalogued === 'assumed') confirmed.push(evidence);
  }

  const unconfirmed = listPlugins()
    .filter((entry) => entry.error && entry.errorConfidence === 'assumed')
    .filter((entry) => !errorEvidence.has(entry.ref))
    .map((entry): ErrorHandleEvidence => ({
      ref: entry.ref,
      seenIn: [],
      catalogued: 'assumed',
    }));

  const versionGaps: VersionGap[] = [];
  for (const [ref, flowNames] of seenRefs) {
    if (getPluginByRef(ref)) continue;
    const name = ref.slice(0, ref.lastIndexOf('@'));
    const known = listPlugins().filter((e) => e.name === name).map((e) => e.version);
    // No versions at all means a Local plugin, which is expected rather than a
    // gap. A version we do not have, of a plugin we do, means the vendored
    // snapshot is out of step with the server.
    if (!known.length) continue;
    versionGaps.push({ ref, flows: [...flowNames].sort(), known });
  }

  return {
    flowsExamined: flows.length,
    confirmed: confirmed.sort((a, b) => a.ref.localeCompare(b.ref)),
    contradicted: contradicted.sort((a, b) => a.ref.localeCompare(b.ref)),
    unconfirmed: unconfirmed.sort((a, b) => a.ref.localeCompare(b.ref)),
    versionGaps: versionGaps.sort((a, b) => a.ref.localeCompare(b.ref)),
    ok: contradicted.length === 0 && versionGaps.length === 0,
  };
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [
    `examined ${report.flowsExamined} flow${report.flowsExamined === 1 ? '' : 's'}`,
  ];

  if (report.contradicted.length) {
    lines.push('', 'the catalog is WRONG about these - they do have an error handle:');
    for (const item of report.contradicted) {
      lines.push(`  ${item.ref}  (wired in ${item.seenIn.join(', ')})`);
    }
  }

  if (report.confirmed.length) {
    lines.push('', 'assumptions confirmed - promote these to observed:');
    for (const item of report.confirmed) {
      lines.push(`  ${item.ref}  (wired in ${item.seenIn.join(', ')})`);
    }
  }

  if (report.versionGaps.length) {
    lines.push('', 'plugin versions in use that the catalog does not have:');
    for (const gap of report.versionGaps) {
      lines.push(`  ${gap.ref}  (catalogued: ${gap.known.join(', ')})`);
    }
  }

  if (report.unconfirmed.length) {
    lines.push(
      '',
      `${report.unconfirmed.length} assumption(s) still unconfirmed - no flow here uses their `
        + 'error path, which is not evidence either way.',
    );
  }

  return lines.join('\n');
}
