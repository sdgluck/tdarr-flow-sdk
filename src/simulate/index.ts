/**
 * Predicting what a flow would do to a library, without running it.
 *
 * Browser-safe and dependency-free, like the rest of the barrel: the app runs
 * this over tens of thousands of records in a tab.
 */

export { ACTIONS, COMMITS, isAction, isCommit, isRevert, REVERTS } from './actions.ts';
export { ScanAccumulator } from './funnel.ts';
export type {
  AccumulatorOptions,
  Breakdown,
  Bucket,
  GateOutcome,
  GateStep,
  Sample,
  ScanReport,
  StoppedAt,
  ValueCount,
} from './funnel.ts';
export { interpret, prepareFlow } from './interpret.ts';
export type {
  Branch,
  InterpretOptions,
  PreparedFlow,
  PreparedNode,
  Stop,
  Trace,
  Verdict,
} from './interpret.ts';
export { SIMULATORS, simulatorFor } from './plugins.ts';
export type { InputValue, Outcome, SimulationEnv, Simulator } from './plugins.ts';
export { project, PROJECTED_KEYS } from './record.ts';
export type { MediaRecord, MediaStream } from './record.ts';
