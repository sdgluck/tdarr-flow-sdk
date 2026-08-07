/**
 * Node-only entry point. Everything here touches the filesystem, so it is
 * deliberately kept out of `src/index.ts` - `test/browser-safe.test.ts` walks
 * the browser barrel's import graph and fails if any of this leaks into it.
 */

export { describeVendor, vendorInfo, vendorPaths } from './vendor.ts';
export type { VendorInfo, VendorPaths } from './vendor.ts';
export { discoverPlugins, loadDetails } from './discover.ts';
export type { DiscoveredPlugin } from './discover.ts';
