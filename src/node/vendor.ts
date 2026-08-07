/**
 * Locations of the vendored Tdarr plugin source, populated by
 * `pnpm plugins:update` (see scripts/update-plugins.ts).
 *
 * Node-only: the browser never reads this. Everything the app needs from the
 * vendored source has already been baked into `src/catalog/data.generated.ts`
 * at generation time.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface VendorInfo {
  repo: string;
  ref: string;
  sha: string;
  committedAt: string;
  vendoredPaths: string[];
}

export interface VendorPaths {
  root: string;
  communityFlowPlugins: string;
  flowHelpers: string;
  methods: string;
  available: boolean;
}

export function vendorPaths(root: string = join(packageRoot, 'vendor')): VendorPaths {
  const communityFlowPlugins = join(root, 'FlowPlugins', 'CommunityFlowPlugins');
  return {
    root,
    communityFlowPlugins,
    flowHelpers: join(root, 'FlowPlugins', 'FlowHelpers'),
    methods: join(root, 'methods'),
    available: existsSync(communityFlowPlugins),
  };
}

export function vendorInfo(root?: string): VendorInfo | null {
  const paths = vendorPaths(root);
  const file = join(paths.root, 'VERSION.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as VendorInfo;
}

export function describeVendor(root?: string): string {
  const info = vendorInfo(root);
  if (!info) return 'no vendored plugin source - run `pnpm plugins:update`';
  return `${info.repo}@${info.sha.slice(0, 10)} (${info.committedAt})`;
}
