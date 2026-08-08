/**
 * What happens when a node that can fail actually does.
 *
 * This is a pass over the finished graph rather than a `Segment`, because it is
 * not a stage of the pipeline - it is a property of every stage at once. A node
 * that can fail may appear in the container stage, the video stage and the
 * output stage, and each one needs the same treatment wired to a different
 * place. Expressing that as a segment would mean threading an error target
 * through every recipe.
 *
 * Two rules constrain it, and both are deliberate:
 *
 * 1. **Only shapes read from a manifest.** About a dozen plugins are marked
 *    error-capable in `catalog/overrides.ts` on the strength of "it shells out,
 *    so it probably can fail". Wiring `err1` on one of those would produce an
 *    edge Tdarr rejects if the guess is wrong, and a flow that fails to load is
 *    far worse than one that lacks an error path. `overrides.ts` says the
 *    wizard must never auto-wire on a guess; this is where that is honoured.
 *
 * 2. **Never invent a destination.** A handler continues to wherever the node's
 *    handle 1 already goes - the failure is treated as though the step had been
 *    skipped. A node with nothing after it is left alone rather than being given
 *    a handler that leads nowhere, which would only trade one warning for
 *    another.
 */

import * as plugins from '../catalog/factories.generated.ts';
import type { FlowBuilder } from '../graph/builder.ts';
import type { PolicyStep } from '../types/spec.ts';

/** Nodes this pass will act on, and where each one would resume. */
export function errorPolicyTargets(
  builder: FlowBuilder,
): Array<{ id: string; name: string; stage?: string; resume?: string }> {
  const edges = builder.edges();
  const handled = new Set(
    edges.filter((edge) => edge.sourceHandle === 'err1').map((edge) => edge.source),
  );

  const resume = new Map<string, string>();
  for (const edge of edges) {
    if (edge.sourceHandle === 1 && !resume.has(edge.source)) resume.set(edge.source, edge.target);
  }

  return builder.nodes()
    .filter((node) => node.shape.error && node.shape.confidence === 'catalog')
    .filter((node) => !handled.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      ...(node.stage ? { stage: node.stage } : {}),
      ...(resume.get(node.id) ? { resume: resume.get(node.id)! } : {}),
    }));
}

export function applyErrorPolicy(builder: FlowBuilder, policy: PolicyStep): void {
  if (policy.errorHandling === 'none') return;

  // Snapshotted before anything is added: the handlers this pass creates must
  // not become candidates for a handler of their own.
  const targets = errorPolicyTargets(builder);
  if (!targets.length) return;

  const restore = builder.currentStage();

  if (policy.errorHandling === 'fail-flow') {
    // One shared sink. Per-node copies would say exactly the same thing several
    // times over and clutter the graph for no gain.
    builder.stage('output');
    const sink = builder.add(plugins.failFlow({}, { name: 'Fail Flow', offSpine: true }));
    for (const target of targets) builder.connect(target.id, 'err1', sink.id);
    builder.stage(restore);
    return;
  }

  for (const target of targets) {
    if (!target.resume) continue;

    // The handler belongs to the stage that produced the node it protects, so
    // the grouped preview keeps it beside the thing that can fail.
    builder.stage(target.stage);

    const reset = builder.add(
      plugins.resetFlowError({}, { name: 'Reset Error', offSpine: true }),
    );
    builder.connect(target.id, 'err1', reset.id);

    if (policy.errorHandling === 'keep-original') {
      // Clearing the error is not enough on its own: the working file may be a
      // half-written encode, and continuing with that is worse than continuing
      // with the file we started from.
      const revert = builder.add(
        plugins.setWorkingFile({ source: 'originalFile' }, {
          name: 'Back To Original',
          offSpine: true,
        }),
      );
      builder.connect(reset.id, 1, revert.id);
      builder.connect(revert.id, 1, target.resume);
    } else {
      builder.connect(reset.id, 1, target.resume);
    }
  }

  builder.stage(restore);
}
