/**
 * The flow document itself, as exported from the Tdarr UI or read out of
 * `flowsjsondb`. The two shapes differ only in keys this library does not read
 * (the UI export adds `description`/`tags`; the DB row carries `animated`/
 * `type` on edges).
 */

/**
 * Output handles are numbered from "1". `err1` is the error handle a node
 * exposes if it can fail; the flow takes it instead of a numbered output when
 * the node throws or its ffmpeg invocation exits non-zero.
 */
export type OutputHandle = `${number}` | 'err1';

export interface FlowNode {
  id: string;
  name: string;
  /** "Community" or "Local". */
  sourceRepo: string;
  pluginName: string;
  version: string;
  fpEnabled: boolean;
  /** Node configuration. Tdarr stores every value as a string. */
  inputsDB?: Record<string, string>;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string | number | null;
  target: string;
  targetHandle: string | null;
  animated?: boolean;
  type?: string;
}

export interface FlowJson {
  _id: string;
  name: string;
  priority?: number;
  description?: string;
  tags?: string;
  flowPlugins: FlowNode[];
  flowEdges: FlowEdge[];
  isUiLocked?: boolean;
}
