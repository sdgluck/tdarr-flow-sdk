/**
 * The one hand-maintained file in the catalog. Everything else under
 * `src/catalog/` is generated.
 *
 * `details()` does not report whether a node exposes an `err1` handle - that is
 * a property of the flow engine, not the manifest - so it has to be curated. The
 * cost of getting it wrong runs both ways: claiming a handle that does not exist
 * makes the linter reject a valid flow, and missing one makes it stay quiet
 * about an unhandled failure path.
 *
 * So each entry records *why* it is here and how sure we are. `observed` means a
 * real flow wires the handle, or tdarr-flow-test's simulator models it from
 * plugin source. `assumed` means the plugin shells out or touches the filesystem
 * and therefore almost certainly can fail, but nothing has demonstrated it.
 * Findings derived from an `assumed` shape are flagged as such, and the wizard
 * must never auto-wire an error edge on one.
 *
 * `scripts/generate-catalog.ts` hard-errors when a key here no longer resolves
 * to a vendored plugin. That is what stops this file rotting silently when
 * upstream renames or removes something.
 */

import type { PluginRefString } from '../types/catalog.ts';

export interface ErrorOverride {
  why: string;
  confidence: 'observed' | 'assumed';
}

export const ERROR_CAPABLE: Record<PluginRefString, ErrorOverride> = {
  // --- observed: wired in a real flow, or modelled from source by tdarr-flow-test
  'runClassicTranscodePlugin@1.0.0': {
    why: 'runs a classic plugin and its ffmpeg preset as a full pass',
    confidence: 'observed',
  },
  'runClassicTranscodePlugin@2.0.0': {
    why: 'err1 is wired six times in the reference transcode pipeline',
    confidence: 'observed',
  },
  'runMkvPropEdit@1.0.0': {
    why: 'rewrites Matroska statistics tags; fails outright on non-Matroska input',
    confidence: 'observed',
  },
  'ffmpegCommandExecute@1.0.0': {
    why: 'materialises the pending command; a non-zero ffmpeg exit takes err1',
    confidence: 'observed',
  },

  // --- assumed: shells out or touches the filesystem, so failure is plausible
  'runCli@1.0.0': { why: 'spawns an arbitrary process', confidence: 'assumed' },
  'runHealthCheck@1.0.0': { why: 'spawns ffmpeg for the check', confidence: 'assumed' },
  'unpack@1.0.0': { why: 'shells out to an archive tool', confidence: 'assumed' },
  'calculateFileHash@1.0.0': { why: 'reads the whole file', confidence: 'assumed' },
  'webRequest@1.0.0': { why: 'network call', confidence: 'assumed' },
  'apprise@1.0.0': { why: 'network call', confidence: 'assumed' },
  'moveToDirectory@1.0.0': { why: 'filesystem move', confidence: 'assumed' },
  'moveToDirectory@2.0.0': { why: 'filesystem move', confidence: 'assumed' },
  'copyToDirectory@1.0.0': { why: 'filesystem copy', confidence: 'assumed' },
  'deleteFile@1.0.0': { why: 'filesystem delete', confidence: 'assumed' },
  'renameFile@1.0.0': { why: 'filesystem rename', confidence: 'assumed' },
  'setFilePermissions@1.0.0': { why: 'chmod/chown', confidence: 'assumed' },
  'copyMoveFolderContent@1.0.0': { why: 'recursive filesystem operation', confidence: 'assumed' },
  'notifyRadarrOrSonarr@1.0.0': { why: 'network call', confidence: 'assumed' },
  'notifyRadarrOrSonarr@2.0.0': { why: 'network call', confidence: 'assumed' },
};

/**
 * Terminal-ness is derived from `outputs.length === 0`. Only list a plugin here
 * when that derivation is wrong.
 */
export const TERMINAL_OVERRIDE: Record<PluginRefString, boolean> = {};

/**
 * Plugins whose `inputsDB` legitimately carries keys their own `details()` does
 * not declare.
 *
 * The classic-plugin runners are wrappers: they take a `pluginSourceId` naming
 * some other plugin, then forward every remaining input to it. Tdarr's editor
 * renders the wrapped plugin's inputs dynamically, so the manifest cannot list
 * them - the reference pipeline stores `tag_language`, `remove_commentary` and
 * `remove_sdh` on a node whose manifest declares only `pluginSourceId`.
 *
 * Everywhere else an undeclared key is a typo worth catching, since a
 * misspelled input is otherwise completely silent: the plugin just reads its
 * default and carries on.
 */
export const PASSTHROUGH_INPUTS: Record<PluginRefString, string> = {
  'runClassicTranscodePlugin@1.0.0': 'forwards inputs to the classic plugin it wraps',
  'runClassicTranscodePlugin@2.0.0': 'forwards inputs to the classic plugin it wraps',
  'runClassicFilterPlugin@1.0.0': 'forwards inputs to the classic plugin it wraps',
};

/**
 * Plugins a flow conventionally ends on, even though they declare an output.
 *
 * `replaceOriginalFile` advertises "Continue to next plugin" and genuinely can
 * be followed by a notification or a move - so it is *not* terminal, and wiring
 * onward from it stays legal. But leaving its output unwired is the normal way
 * to finish a flow, not an oversight, so `unwired-handle` would otherwise warn
 * about every correct flow ever written.
 *
 * Kept deliberately short. A plugin belongs here only when the *absence* of an
 * outgoing edge is the ordinary case, not merely a common one.
 */
export const FLOW_ENDING: Record<PluginRefString, string> = {
  'replaceOriginalFile@1.0.0': 'commits the working file over the library file; the usual last node',
  // Delivering the file elsewhere is the other way a flow finishes. Wiring on
  // from it stays legal - a notification after a move is perfectly ordinary -
  // but the file has left the library by this point, so an unwired output is
  // the normal case rather than a forgotten branch.
  'moveToDirectory@1.0.0': 'delivers the file to its destination; the usual last node',
  'moveToDirectory@2.0.0': 'delivers the file to its destination; the usual last node',
  'moveToOriginalDirectory@1.0.0': 'delivers the file to its destination; the usual last node',
};
