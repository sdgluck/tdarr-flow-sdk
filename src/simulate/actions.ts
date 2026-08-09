/**
 * Which plugins change the file, and which put it back.
 *
 * Hand-curated with a `why` for each, in the style of `catalog/overrides.ts`,
 * because nothing in `details()` says whether a plugin writes. The catalog knows
 * a plugin's shape - how many outputs it has, whether it can error - but "does
 * running this leave the library different" is not a question the upstream
 * manifests answer, so it is answered here and the reasoning is kept next to the
 * answer.
 *
 * The distinction that earns its keep is `REVERTS`. A flow that encodes a file
 * and then discovers the result is implausibly small will point the working file
 * back at the original and commit *that*. The library ends up untouched. A
 * scan that counted every path through `ffmpegCommandExecute` as a modification
 * would report the size guard's entire purpose as work done.
 */

/** Plugins that leave the file different from how they found it. */
export const ACTIONS: Record<string, string> = {
  'ffmpegCommandExecute@1.0.0':
    'runs the assembled ffmpeg command, producing a new working file',
  // Both versions run a classic plugin whose own logic is not modelled here, so
  // whether it really transcodes is not knowable from a scan. Counting it as
  // acting is the safe direction - it overstates rather than hides work - and
  // `@2.0.0` says so on its own handles ("Processing was not done by the classic
  // plugin"), which is why reaching it also marks the outcome uncertain.
  'runClassicTranscodePlugin@1.0.0': 'runs a classic transcode plugin, which may rewrite the file',
  'runClassicTranscodePlugin@2.0.0': 'runs a classic transcode plugin, which may rewrite the file',
  'runMkvPropEdit@1.0.0': 'rewrites the Matroska header to restamp statistics',
  'runCli@1.0.0': 'runs an arbitrary command, which is assumed to touch the file',
  'runAutomation@1.0.0': 'runs an automation, which is assumed to touch the file',
  'setFilePermissions@1.0.0': 'changes the file mode on disk',
  'runHealthCheck@1.0.0': 'runs ffmpeg over the file; it does not rewrite it, but it is work '
    + 'the flow will spend time on, so it counts as the file being processed',
};

/**
 * Plugins that commit the working file back to the library. Reaching one is how
 * a path ends in a real change - everything before it is on a temporary copy.
 */
export const COMMITS: Record<string, string> = {
  'replaceOriginalFile@1.0.0': 'overwrites the original with the working file',
  'moveToDirectory@1.0.0': 'delivers the working file to its destination',
  'moveToDirectory@2.0.0': 'delivers the working file to its destination',
  'moveToOriginalDirectory@1.0.0': 'delivers the working file beside the original',
  'copyToDirectory@1.0.0': 'copies the working file to its destination',
  'copyMoveFolderContent@1.0.0': 'moves or copies the surrounding folder',
  'deleteFile@1.0.0': 'removes the file from disk',
  'removeFromTdarr@1.0.0': 'removes the file from the library database',
};

/**
 * Plugins that point the working file back at the original, discarding whatever
 * was done to it. A path that reaches one of these has, from the library's point
 * of view, done nothing.
 */
export const REVERTS: Record<string, string> = {
  'setOriginalFile@1.0.0': 'restores the original file as the working file',
  // Only when `source` is `originalFile`; `customPath` points somewhere else
  // entirely. The interpreter checks the input rather than trusting the ref.
  'setWorkingFile@1.0.0': 'restores the original file when its source is `originalFile`',
};

export function isAction(ref: string): boolean {
  return ref in ACTIONS;
}

export function isCommit(ref: string): boolean {
  return ref in COMMITS;
}

/**
 * Whether this node discards the work done so far.
 *
 * `setWorkingFile` needs its inputs: pointing the working file at a custom path
 * is not a revert, it is redirection to a third file, and treating it as a
 * revert would silently under-report every flow that uses it.
 */
export function isRevert(ref: string, inputs: Readonly<Record<string, unknown>>): boolean {
  if (ref === 'setWorkingFile@1.0.0') return String(inputs['source'] ?? '') === 'originalFile';
  return ref in REVERTS;
}
