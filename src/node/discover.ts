/**
 * Walks the vendored plugin tree and reads every `details()` manifest.
 *
 * Deliberately keeps *every* version of a plugin, unlike tdarr-flow-test's
 * `discoverPlugins`, which collapses to the newest. Version changes shape:
 * `compareFileSizeRatio` grew a third output at 2.0.0 and real flows wire it, so
 * a name-keyed view of the world mis-lints them.
 *
 * Node-only.
 */

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FlowPluginDetails } from '../types/plugin.ts';
import { vendorPaths } from './vendor.ts';

export interface DiscoveredPlugin {
  category: string;
  name: string;
  version: string;
  ref: string;
  file: string;
  details: FlowPluginDetails;
}

const require_ = createRequire(import.meta.url);

/**
 * The vendored plugins are CommonJS and require their helpers by relative path,
 * which is why `vendor/package.json` pins `{"type":"commonjs"}` - without it
 * Node parses them as ESM and every one of them fails.
 */
export function loadDetails(file: string): FlowPluginDetails {
  const module_ = require_(file) as { details?: () => FlowPluginDetails };
  if (typeof module_.details !== 'function') {
    throw new Error(`${file} does not export details()`);
  }
  return module_.details();
}

export function discoverPlugins(root?: string): DiscoveredPlugin[] {
  const paths = vendorPaths(root);
  if (!paths.available) {
    throw new Error(
      `no vendored plugin source at ${paths.communityFlowPlugins} - run \`pnpm plugins:update\``,
    );
  }

  const found: DiscoveredPlugin[] = [];
  const dirs = (at: string) =>
    readdirSync(at, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  for (const category of dirs(paths.communityFlowPlugins)) {
    const categoryDir = join(paths.communityFlowPlugins, category);
    for (const name of dirs(categoryDir)) {
      for (const version of dirs(join(categoryDir, name))) {
        const file = join(categoryDir, name, version, 'index.js');
        if (!existsSync(file)) continue;
        found.push({
          category,
          name,
          version,
          ref: `${name}@${version}`,
          file,
          details: loadDetails(file),
        });
      }
    }
  }

  // Sorted so the generated catalog is byte-stable across filesystems.
  found.sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
    || a.version.localeCompare(b.version)
  );
  return found;
}
