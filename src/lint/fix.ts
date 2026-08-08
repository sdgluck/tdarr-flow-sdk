/**
 * Turning a finding into a change.
 *
 * A fix here edits the **spec**, never the flow. The flow is derived - the app
 * recompiles it on every keystroke - so a repair applied to the graph would
 * survive exactly until the next edit. Working one level up means a fix is
 * durable, undoable through the same history as any other edit, and visible in
 * the form rather than only in the JSON.
 *
 * Two kinds, kept distinct because they are not the same promise:
 *
 * - `repair` changes what the flow does. It is offered only when there is one
 *   obviously-right change; anything needing a judgement call stays a finding
 *   with an explanation.
 * - `accept` changes nothing about the flow and records that the finding
 *   describes something deliberate. Several rules exist to surface decisions
 *   rather than defects - a gate's reject path is *supposed* to dead-end - and
 *   without a way to say so, the only options are a permanently noisy panel or a
 *   rule too lax to catch the real thing.
 *
 * Every fix is verifiable, and `applyFix` verifies it: recompile, re-lint, and
 * refuse the change if it introduced an error. An auto-fix that can quietly make
 * a flow worse is worth less than no auto-fix at all.
 */

import { latestVersion } from '../catalog/index.ts';
import type { FlowJson } from '../types/flow.ts';
import type { AcceptedFinding, FlowSpec } from '../types/spec.ts';
import type { LintFinding } from './rules/types.ts';

export type FixKind = 'repair' | 'accept';

export interface SpecFix {
  /** Stable within a run, so several findings sharing one fix collapse to it. */
  id: string;
  rule: string;
  kind: FixKind;
  /** Imperative and short - this is the button. */
  title: string;
  /** What it changes, and why that is the right change. */
  detail: string;
  apply(draft: FlowSpec): void;
}

/**
 * What a fix needs beyond the finding itself.
 *
 * `stages` comes from `compileFlow`. It is what lets an acceptance survive an
 * edit: node ids are hashed from the whole flow and change constantly, so the
 * durable identity of "this dead end" is the stage it is in plus the plugin plus
 * the handle.
 */
export interface FixContext {
  spec: FlowSpec;
  flow: FlowJson;
  stages: Record<string, string>;
}

/**
 * The durable identity of a finding, or `null` if it has none.
 *
 * Deliberately coarse. Two `checkFileMedium` nodes in the source stage with the
 * same handle unwired are the same decision twice, and asking someone to accept
 * it twice would be pedantry rather than rigour.
 */
export function findingKey(finding: LintFinding, context: FixContext): string | null {
  if (!finding.pluginName || !finding.handle) return null;
  const stage = finding.nodeId ? context.stages[finding.nodeId] ?? 'unstaged' : 'unstaged';
  return `${stage}/${finding.pluginName}/${finding.handle}`;
}

export function isAccepted(finding: LintFinding, context: FixContext): boolean {
  const key = findingKey(finding, context);
  if (!key) return false;
  return (context.spec.policy.accepted ?? []).some(
    (entry) => entry.rule === finding.rule && entry.at === key,
  );
}

/**
 * Splits findings into the ones still open and the ones already accepted.
 *
 * Accepted findings are returned rather than dropped: a warning that vanishes
 * without trace is indistinguishable from a warning that was never raised, and
 * the point of accepting one is to record a decision, not to hide it.
 */
export function partitionFindings(
  findings: readonly LintFinding[],
  context: FixContext,
): { open: LintFinding[]; accepted: LintFinding[] } {
  const open: LintFinding[] = [];
  const accepted: LintFinding[] = [];
  for (const finding of findings) (isAccepted(finding, context) ? accepted : open).push(finding);
  return { open, accepted };
}

// --- the fixes --------------------------------------------------------------

/** Every fix that applies to one finding, best first. */
export function fixesFor(finding: LintFinding, context: FixContext): SpecFix[] {
  const fixes: SpecFix[] = [];

  switch (finding.rule) {
    case 'missing-error-edge': {
      const wiring = errorPolicyFix(finding, context);
      if (wiring) fixes.push(wiring);
      break;
    }

    case 'uncatalogued-plugin': {
      const declare = declareShapeFix(finding, context);
      if (declare) fixes.push(declare);
      break;
    }

    case 'overlapping-nodes': {
      const relayout = relayoutFix(finding, context);
      if (relayout) fixes.push(relayout);
      break;
    }

    case 'mixed-plugin-versions': {
      const pin = pinVersionFix(finding, context);
      if (pin) fixes.push(pin);
      break;
    }

    default:
      break;
  }

  const accept = acceptFix(finding, context);
  if (accept) fixes.push(accept);

  return fixes;
}

/**
 * Wire unhandled failures according to the flow's error policy.
 *
 * The policy field has always existed; turning it on is what makes it mean
 * something. Only offered for findings drawn from a catalogued shape - an
 * `assumed` one rests on "this plugin shells out, so it probably can fail", and
 * an err1 edge on a plugin that has no err1 handle is a flow Tdarr will not
 * load. Those keep only the option to accept.
 */
function errorPolicyFix(finding: LintFinding, context: FixContext): SpecFix | null {
  if (finding.assumed) return null;
  if (context.spec.policy.errorHandling !== 'none') return null;

  return {
    id: 'error-policy:reset-and-continue',
    rule: finding.rule,
    kind: 'repair',
    title: 'Handle failures and carry on',
    detail:
      'Wires every node that can fail to a Reset Error node, which clears the failure and rejoins '
      + 'the flow where that node would have continued - so one failed step no longer sends the '
      + 'whole job to the error table. Plugins whose failure handle is only assumed are left '
      + 'alone. You can switch to a different policy in the Output step.',
    apply(draft) {
      draft.policy.errorHandling = 'reset-and-continue';
    },
  };
}

/**
 * Give an uncatalogued node a declared shape.
 *
 * Only for extras: everything else in the graph comes from the catalog by
 * construction. The shape is a claim about the plugin, so the default is the
 * conservative one - a single output and no error handle - and it is stated
 * plainly rather than inferred from something that only looks like evidence.
 */
function declareShapeFix(finding: LintFinding, context: FixContext): SpecFix | null {
  const extra = context.spec.extras.find((candidate) => candidate.id === finding.nodeId);
  if (!extra || extra.shape) return null;

  return {
    id: `declare-shape:${extra.id}`,
    rule: finding.rule,
    kind: 'repair',
    title: 'Declare one output',
    detail:
      `Records that ${extra.pluginName} has a single output and no error handle, which is what `
      + 'the flow already assumes when it wires it. Change it in the Advanced step if the plugin '
      + 'has more - the linter can only check handles it has been told about.',
    apply(draft) {
      const target = draft.extras.find((candidate) => candidate.id === extra.id);
      if (target) target.shape = { outputs: 1, error: false, terminal: false };
    },
  };
}

/** Let the layout place a node that an import pinned on top of another. */
function relayoutFix(finding: LintFinding, context: FixContext): SpecFix | null {
  const extra = context.spec.extras.find((candidate) => candidate.id === finding.nodeId);
  if (!extra?.frozen) return null;

  return {
    id: `relayout:${extra.id}`,
    rule: finding.rule,
    kind: 'repair',
    title: 'Let the layout place it',
    detail:
      `Drops the position ${extra.name ?? extra.pluginName} kept from the flow it was imported `
      + 'from, so the automatic layout gives it a column of its own. Nothing about what the flow '
      + 'does changes - a node hidden underneath another still runs, it just cannot be reviewed.',
    apply(draft) {
      const target = draft.extras.find((candidate) => candidate.id === extra.id);
      if (target?.frozen) delete target.frozen;
    },
  };
}

/** Bring extras onto the newest catalogued version of their plugin. */
function pinVersionFix(finding: LintFinding, context: FixContext): SpecFix | null {
  const pluginName = finding.pluginName;
  if (!pluginName) return null;

  const newest = latestVersion(pluginName);
  if (!newest) return null;

  const stale = context.spec.extras.filter(
    (extra) => extra.pluginName === pluginName && extra.version !== newest,
  );
  if (!stale.length) return null;

  return {
    id: `pin-version:${pluginName}`,
    rule: finding.rule,
    kind: 'repair',
    title: `Move to ${newest}`,
    detail:
      `Puts ${stale.length} node${stale.length === 1 ? '' : 's'} onto ${pluginName}@${newest}, the `
      + 'version the rest of the flow uses. Worth checking afterwards: versions can differ in how '
      + 'many outputs they have, and this does not rewire anything.',
    apply(draft) {
      for (const extra of draft.extras) {
        if (extra.pluginName === pluginName && extra.version !== newest) extra.version = newest;
      }
    },
  };
}

/**
 * Record that a finding describes something deliberate.
 *
 * Offered only for the two rules that routinely report intent rather than
 * error. A dead end is how a flow rejects a file, and leaving a failure
 * unhandled is a legitimate choice on a step whose failure should stop the job.
 * Every other rule reports something wrong, and being able to wave those away
 * would make the panel meaningless.
 */
function acceptFix(finding: LintFinding, context: FixContext): SpecFix | null {
  if (finding.rule !== 'unwired-handle' && finding.rule !== 'missing-error-edge') return null;

  const key = findingKey(finding, context);
  if (!key || isAccepted(finding, context)) return null;

  const entry: AcceptedFinding = {
    rule: finding.rule,
    at: key,
    what: finding.nodeName ?? finding.pluginName ?? key,
  };

  return {
    id: `accept:${finding.rule}:${key}`,
    rule: finding.rule,
    kind: 'accept',
    title: finding.rule === 'unwired-handle' ? 'This dead end is deliberate' : 'Leave it unhandled',
    detail:
      finding.rule === 'unwired-handle'
        ? 'Stops reporting this output. Ending here is how a flow rejects a file it does not want '
          + 'to touch, so the warning is a decision worth seeing once, not every time.'
        : 'Stops reporting this failure path. A failure here will send the job to the error table, '
          + 'which is sometimes exactly what should happen.',
    apply(draft) {
      draft.policy.accepted = [...(draft.policy.accepted ?? []), entry];
    },
  };
}

// --- applying ---------------------------------------------------------------

export interface FixOutcome {
  spec: FlowSpec;
  applied: SpecFix[];
  /**
   * Fixes that were computed but rejected because applying them introduced an
   * error-severity finding. Should always be empty; if it is not, the fix is
   * wrong and this is how you find out rather than the user.
   */
  rejected: Array<{ fix: SpecFix; reason: string }>;
}

/**
 * Applies fixes, keeping only the ones that leave the flow no worse.
 *
 * `compile` and `lint` are injected rather than imported so this module stays
 * out of the recipe layer's import graph - `lint/` is meant to be usable without
 * dragging the whole spec compiler in behind it.
 */
export function applyFixes(
  spec: FlowSpec,
  fixes: readonly SpecFix[],
  verify: (candidate: FlowSpec) => LintFinding[],
): FixOutcome {
  const errorsOf = (findings: readonly LintFinding[]) =>
    findings.filter((finding) => finding.severity === 'error').map((finding) => finding.message);

  let current = spec;
  let baseline: string[];
  try {
    baseline = errorsOf(verify(current));
  } catch (error) {
    return {
      spec,
      applied: [],
      rejected: fixes.map((fix) => ({
        fix,
        reason: `the flow does not compile as it stands: ${message(error)}`,
      })),
    };
  }

  const applied: SpecFix[] = [];
  const rejected: FixOutcome['rejected'] = [];
  const seen = new Set<string>();

  for (const fix of fixes) {
    // Several findings routinely share one fix - twenty unhandled failures are
    // all repaired by turning the error policy on once.
    if (seen.has(fix.id)) continue;
    seen.add(fix.id);

    const candidate = structuredClone(current);
    fix.apply(candidate);

    let after: string[];
    try {
      after = errorsOf(verify(candidate));
    } catch (error) {
      rejected.push({ fix, reason: `it stopped the flow compiling: ${message(error)}` });
      continue;
    }

    const introduced = after.filter((entry) => !baseline.includes(entry));
    if (introduced.length) {
      rejected.push({ fix, reason: `it would introduce: ${introduced.join('; ')}` });
      continue;
    }

    current = candidate;
    baseline = after;
    applied.push(fix);
  }

  return { spec: current, applied, rejected };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
