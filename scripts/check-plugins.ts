/**
 * Fails if the vendored plugin source has fallen behind upstream.
 *
 *   pnpm plugins:check              # compare against latest master
 *   pnpm plugins:check --ref <sha>  # compare against a specific ref
 *
 * Run on a schedule in CI. This only compares the recorded sha against the ref
 * upstream currently points at — it does not re-download, so it is cheap enough
 * to run daily. Fix a failure with `pnpm plugins:update && pnpm test`.
 */

import { arg, REPO, resolveCommit, readVendorVersion } from './plugin-repo.ts';

const vendored = readVendorVersion();
const ref = arg('ref') ?? vendored.ref;

console.log(`vendored: ${vendored.sha} (${vendored.committedAt})`);

const { sha, date } = await resolveCommit(ref);
console.log(`upstream: ${sha} (${date})  [${REPO}@${ref}]`);

if (sha === vendored.sha) {
  console.log('\nvendored plugins are up to date.');
  process.exit(0);
}

console.error(
  `\nvendored plugins are behind ${REPO}@${ref}.\n` +
    `  https://github.com/${REPO}/compare/${vendored.sha}...${sha}\n\n` +
    'Refresh with:\n' +
    '  pnpm plugins:update\n' +
    '  pnpm test\n',
);
process.exit(1);
