/**
 * One error type for everything the builder rejects. Messages name the offender
 * and say what would be legal instead - the builder is driven by a wizard, so
 * these surface to end users, not just to callers with a stack trace.
 */
export class FlowBuildError extends Error {
  readonly nodeId: string | undefined;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = 'FlowBuildError';
    this.nodeId = nodeId;
  }
}
