import { describe, expect, it } from 'vitest';
import {
  applyFixes,
  catalogShapes,
  compileFlow,
  compileSpec,
  findingKey,
  fixesFor,
  isAccepted,
  lint,
  newSpec,
  partitionFindings,
  PRESETS,
} from '../src/index.ts';
import type { FixContext, FlowSpec, LintFinding, SpecFix } from '../src/index.ts';

function review(spec: FlowSpec): { context: FixContext; findings: LintFinding[] } {
  const { flow, stages } = compileFlow(spec);
  return { context: { spec, flow, stages }, findings: lint(flow) };
}

const verify = (spec: FlowSpec) => lint(compileSpec(spec), { shapes: catalogShapes() });

/** Every fix offered for a spec, in finding order. */
function allFixes(spec: FlowSpec): SpecFix[] {
  const { context, findings } = review(spec);
  return findings.flatMap((finding) => fixesFor(finding, context));
}

const preset = (id: string) => PRESETS.find((p) => p.id === id)!.spec();

describe('fixesFor', () => {
  it('offers to wire failures on a flow that leaves them unhandled', () => {
    const fixes = allFixes(preset('hevc-simple'));
    const wiring = fixes.find((fix) => fix.id === 'error-policy:reset-and-continue');

    expect(wiring).toBeDefined();
    expect(wiring!.kind).toBe('repair');
  });

  it('does not offer to wire an error handle that is only assumed', () => {
    // moveToDirectory is in ERROR_CAPABLE as a guess ("filesystem move"), and
    // an err1 edge on a plugin that has no err1 handle is a flow Tdarr will not
    // load. The guess may only be accepted, never acted on.
    const spec = preset('transcode-and-deliver');
    spec.policy.errorHandling = 'reset-and-continue';

    const { context, findings } = review(spec);
    const assumed = findings.filter((f) => f.rule === 'missing-error-edge');

    expect(assumed.length).toBeGreaterThan(0);
    expect(assumed.every((f) => f.assumed)).toBe(true);
    for (const finding of assumed) {
      expect(fixesFor(finding, context).every((fix) => fix.kind === 'accept')).toBe(true);
    }
  });

  it('offers nothing but acceptance once the policy is already on', () => {
    const spec = preset('hevc-simple');
    spec.policy.errorHandling = 'reset-and-continue';
    expect(allFixes(spec).some((fix) => fix.id === 'error-policy:reset-and-continue')).toBe(false);
  });

  it('offers acceptance for a deliberate dead end', () => {
    const fixes = allFixes(preset('hevc-simple'));
    const accept = fixes.find((fix) => fix.rule === 'unwired-handle');

    expect(accept?.kind).toBe('accept');
    expect(accept?.id).toContain('source/checkFileMedium/');
  });

  it('never offers to wave away a real defect', () => {
    // Acceptance exists for the two rules that report intent. If it were
    // available everywhere the panel would mean nothing.
    for (const id of PRESETS.map((p) => p.id)) {
      for (const fix of allFixes(preset(id))) {
        if (fix.kind !== 'accept') continue;
        expect(['unwired-handle', 'missing-error-edge']).toContain(fix.rule);
      }
    }
  });

  it('offers to declare a shape for an uncatalogued extra', () => {
    const spec = newSpec('Local');
    spec.extras.push({
      id: 'x1',
      pluginName: 'myLocalThing',
      version: '1.0.0',
      sourceRepo: 'Local',
      inputs: {},
      anchor: 'afterSource',
    });

    const fixes = allFixes(spec);
    const declare = fixes.find((fix) => fix.rule === 'uncatalogued-plugin');
    expect(declare?.id).toBe('declare-shape:x1');

    const fixed = structuredClone(spec);
    declare!.apply(fixed);
    expect(fixed.extras[0]!.shape).toEqual({ outputs: 1, error: false, terminal: false });
  });
});

describe('findingKey', () => {
  it('survives an edit that changes every node id', () => {
    const before = preset('hevc-simple');
    const first = review(before);
    const target = first.findings.find((f) => f.rule === 'unwired-handle')!;
    const key = findingKey(target, first.context);

    // Renaming the flow re-hashes every id, which is exactly the case a key
    // built from node ids would fail.
    const after = { ...structuredClone(before), meta: { name: 'Something else' } };
    const second = review(after);
    const moved = second.findings.find((f) => f.rule === 'unwired-handle')!;

    expect(moved.nodeId).not.toBe(target.nodeId);
    expect(findingKey(moved, second.context)).toBe(key);
  });

  it('is null for a finding that names no handle', () => {
    const context = review(newSpec()).context;
    expect(findingKey({ rule: 'entry-node', severity: 'error', message: '' }, context)).toBeNull();
  });
});

describe('acceptance', () => {
  it('moves a finding out of the open list without deleting it', () => {
    const spec = preset('hevc-simple');
    const { context, findings } = review(spec);
    const accept = findings.flatMap((f) => fixesFor(f, context)).find((f) => f.kind === 'accept')!;

    const after = structuredClone(spec);
    accept.apply(after);

    const next = review(after);
    const { open, accepted } = partitionFindings(next.findings, next.context);

    expect(accepted.length).toBe(1);
    expect(open.length).toBe(next.findings.length - 1);
    // The flow itself is untouched: accepting records a decision, it does not
    // change what runs.
    expect(compileSpec(after)).toEqual(compileSpec(spec));
  });

  it('does not offer to accept the same finding twice', () => {
    const spec = preset('hevc-simple');
    const first = review(spec);
    const accept = first.findings
      .flatMap((f) => fixesFor(f, first.context))
      .find((f) => f.kind === 'accept')!;

    const after = structuredClone(spec);
    accept.apply(after);

    const second = review(after);
    const still = second.findings.find((f) => isAccepted(f, second.context))!;
    expect(fixesFor(still, second.context)).toEqual([]);
  });
});

describe('applyFixes', () => {
  it('clears every unhandled failure it is allowed to touch', () => {
    const spec = preset('hevc-hardware-routing');
    const before = review(spec);
    const unhandled = before.findings.filter((f) => f.rule === 'missing-error-edge');
    expect(unhandled.length).toBeGreaterThan(0);

    const outcome = applyFixes(
      spec,
      before.findings.flatMap((f) => fixesFor(f, before.context)),
      verify,
    );

    const after = review(outcome.spec);
    expect(after.findings.filter((f) => f.rule === 'missing-error-edge')).toEqual([]);
    expect(outcome.rejected).toEqual([]);
  });

  it('applies a shared fix once however many findings ask for it', () => {
    const spec = preset('mp4-compatibility');
    const { context, findings } = review(spec);
    const fixes = findings.flatMap((f) => fixesFor(f, context));

    // Three separate Execute nodes, one policy switch between them.
    expect(fixes.filter((f) => f.id === 'error-policy:reset-and-continue').length)
      .toBeGreaterThan(1);
    expect(applyFixes(spec, fixes, verify).applied
      .filter((f) => f.id === 'error-policy:reset-and-continue').length).toBe(1);
  });

  it('leaves nothing to fix on a second pass', () => {
    for (const entry of PRESETS) {
      const spec = entry.spec();
      const first = review(spec);
      const outcome = applyFixes(
        spec,
        first.findings.flatMap((f) => fixesFor(f, first.context)),
        verify,
      );

      const second = review(outcome.spec);
      const { open } = partitionFindings(second.findings, second.context);
      const remaining = open.flatMap((f) => fixesFor(f, second.context));

      expect({ preset: entry.id, remaining: remaining.map((f) => f.id) })
        .toEqual({ preset: entry.id, remaining: [] });
    }
  });

  it('refuses a fix that would introduce an error', () => {
    const spec = newSpec();
    const sabotage: SpecFix = {
      id: 'sabotage',
      rule: 'unwired-handle',
      kind: 'repair',
      title: 'Break it',
      detail: '',
      apply(draft) {
        draft.extras.push({
          id: 'bad',
          pluginName: 'nothingAtAll',
          version: '9.9.9',
          sourceRepo: 'Local',
          inputs: {},
          anchor: 'afterSource',
          // Declared terminal, but the compiler chains the next stage onto it.
          shape: { outputs: 0, error: false, terminal: true },
        });
      },
    };

    const outcome = applyFixes(spec, [sabotage], verify);
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected[0]!.reason).toMatch(/stopped the flow compiling/);
    expect(outcome.spec).toEqual(spec);
  });

  it('never introduces a lint error across every preset', () => {
    for (const entry of PRESETS) {
      const spec = entry.spec();
      const { context, findings } = review(spec);
      const outcome = applyFixes(spec, findings.flatMap((f) => fixesFor(f, context)), verify);

      expect({ preset: entry.id, errors: lint(compileSpec(outcome.spec)).filter((f) =>
        f.severity === 'error'
      ) }).toEqual({ preset: entry.id, errors: [] });
    }
  });
});
