/**
 * Shared knowledge of the upstream Tdarr plugin repo, used by both
 * `plugins:update` (which vendors it) and `plugins:check` (which asserts the
 * vendored copy still matches upstream).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'HaveAGitGat/Tdarr_Plugins';

/** Paths to extract, relative to the repo root. */
export const WANTED = [
  'FlowPlugins/CommunityFlowPlugins',
  'FlowPlugins/FlowHelpers',
  'methods',
];

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const vendorDir = join(packageRoot, 'vendor');

export interface VendorVersion {
  repo: string;
  ref: string;
  sha: string;
  committedAt: string;
  vendoredPaths: string[];
}

export function readVendorVersion(): VendorVersion {
  const path = join(vendorDir, 'VERSION.json');
  return JSON.parse(readFileSync(path, 'utf8')) as VendorVersion;
}

/**
 * A token is optional but strongly preferred in CI: unauthenticated GitHub API
 * requests are rate limited per IP, which shared runners exhaust quickly.
 */
export async function resolveCommit(ref: string): Promise<{ sha: string; date: string }> {
  const token = process.env['GITHUB_TOKEN'];
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`could not resolve ref "${ref}": GitHub returned ${response.status}`);
  }
  const body = (await response.json()) as {
    sha: string;
    commit: { committer: { date: string } };
  };
  return { sha: body.sha, date: body.commit.committer.date };
}

export function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
