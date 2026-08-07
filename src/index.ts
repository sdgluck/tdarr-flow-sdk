/**
 * Browser-safe entry point.
 *
 * Nothing reachable from here may touch the filesystem or `process` -
 * `test/browser-safe.test.ts` walks this import graph and fails if anything
 * does. Node-only helpers live behind the `tdarr-flow-sdk/node` subpath.
 */

// --- catalog ----------------------------------------------------------------
export {
  catalog,
  defaultInputs,
  evaluateDisplayConditions,
  findPlugin,
  getPlugin,
  getPluginByRef,
  latestVersion,
  listPlugins,
  pluginsByCategory,
  searchPlugins,
  visibleInputs,
} from './catalog/index.ts';
export type {
  HandlesFor,
  HasError,
  InputsFor,
  PluginErrorHandle,
  PluginHandles,
  PluginInputs,
  PluginRef,
} from './catalog/inputs.generated.ts';
export * as plugins from './catalog/factories.generated.ts';

// --- graph ------------------------------------------------------------------
export { flow, FlowBuilder, Cursor, node, localNode, segment } from './graph/builder.ts';
export type {
  AnyRef,
  Attachable,
  FlowOptions,
  GraphModel,
  HandlesOf,
  InputsOf,
  LocalNodeOptions,
  ModelEdge,
  NodeOptions,
  NodeSpec,
  PlacedNode,
  Segment,
} from './graph/builder.ts';
export { FlowBuildError } from './graph/errors.ts';
export { ffmpegCommand, FfmpegCommandBuilder } from './graph/ffmpegCommand.ts';
export type { FfmpegCommandOptions } from './graph/ffmpegCommand.ts';
export { assertHandle, serializeHandle, shapeOfRef } from './graph/handles.ts';
export type { Handle, Shape } from './graph/handles.ts';
export { decodeInputs, encodeInputs } from './graph/inputs.ts';
export type { InputValue } from './graph/inputs.ts';
export { edgeId, hashId, IdAllocator } from './graph/ids.ts';
export { layout } from './graph/layout.ts';
export type { LayoutEdge, LayoutNode, LayoutOptions, Position } from './graph/layout.ts';
export {
  embedSpec,
  extractSpec,
  fromFlowJson,
  SPEC_MARKER,
  stripSpec,
  toFlowJson,
} from './graph/serialize.ts';

// --- lint -------------------------------------------------------------------
export {
  assertNoLintErrors,
  buildContext,
  catalogShapes,
  formatFindings,
  lint,
  rules as lintRules,
} from './lint/index.ts';
export type {
  LintContext,
  LintFinding,
  LintOptions,
  LintRule,
  LintSeverity,
  NodeShape,
  ShapeResolver,
} from './lint/index.ts';

// --- recipes and the spec compiler ------------------------------------------
export {
  cleanTracks,
  compileFlow,
  compileSpec,
  extrasSegment,
  finalise,
  migrateSpec,
  newSpec,
  noop,
  normalizeAudio,
  recipe,
  remuxContainer,
  sourceFile,
  transcodeVideo,
} from './recipes/index.ts';
export type { CompiledFlow, CompileOptions, Recipe, RecipeMeta, Stage } from './recipes/index.ts';
export { SPEC_VERSION, SpecVersionError } from './types/spec.ts';

// --- import and recognition --------------------------------------------------
export { difference, importFlow, isomorphic, Walk } from './recognise/index.ts';
export type {
  ImportOptions,
  ImportResult,
  Match,
  MatchResult,
} from './recognise/index.ts';
export type { Difference } from './recognise/isomorphic.ts';

// --- server ------------------------------------------------------------------
// Browser-safe: talks to Tdarr over fetch, with no backend or proxy in between.
export { TdarrClient, TdarrError } from './server/client.ts';
export type {
  CrudRequest,
  FlowSummary,
  LibrarySummary,
  NodeSummary,
  ServerStatus,
  TdarrClientOptions,
} from './server/client.ts';
export { formatVerifyReport, verifyAgainstFlows } from './server/verify.ts';
export type { ErrorHandleEvidence, VerifyReport, VersionGap } from './server/verify.ts';

// --- types ------------------------------------------------------------------
export type * from './types/index.ts';
