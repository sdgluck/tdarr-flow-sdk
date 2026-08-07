/**
 * Vendors the official Tdarr plugin source into `vendor/`, so the harness can
 * execute the real stock plugins instead of modelling them.
 *
 *   pnpm plugins:update              # latest master
 *   pnpm plugins:update --ref <sha>  # pin to a commit, tag or branch
 *
 * Tdarr loads the COMPILED plugins from `FlowPlugins/`, not the TypeScript in
 * `FlowPluginsTs/`, so that is what is vendored. The layout mirrors the source
 * repo exactly, which matters: plugins resolve their helpers with relative
 * requires like `../../../../FlowHelpers/1.0.0/interfaces/flowUtils` and
 * `../../../../../methods/lib`, and those only resolve if the tree keeps its
 * shape.
 *
 * The plugin repo is versioned independently of Tdarr releases and carries no
 * tags, so `--ref` takes a commit sha for reproducibility. The resolved sha is
 * always recorded in vendor/VERSION.json.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arg, REPO, resolveCommit, vendorDir, WANTED } from './plugin-repo.ts';

async function download(sha: string, into: string): Promise<string> {
  const url = `https://codeload.github.com/${REPO}/tar.gz/${sha}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed: ${url} returned ${response.status}`);

  const tarball = join(into, 'plugins.tar.gz');
  writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  return tarball;
}

async function main(): Promise<void> {
  const ref = arg('ref') ?? 'master';

  console.log(`resolving ${REPO}@${ref}...`);
  const { sha, date } = await resolveCommit(ref);
  console.log(`  -> ${sha} (${date})`);

  const scratch = mkdtempSync(join(tmpdir(), 'tdarr-plugins-'));
  try {
    console.log('downloading tarball...');
    const tarball = await download(sha, scratch);

    // The tarball root is "<repo>-<sha>/", stripped so paths land at
    // vendor/FlowPlugins/... rather than vendor/Tdarr_Plugins-<sha>/FlowPlugins/...
    const stripped = WANTED.map((path) => `${REPO.split('/')[1]}-${sha}/${path}`);

    if (existsSync(vendorDir)) rmSync(vendorDir, { recursive: true });
    mkdirSync(vendorDir, { recursive: true });

    console.log('extracting...');
    execFileSync('tar', ['-xzf', tarball, '-C', vendorDir, '--strip-components=1', ...stripped], {
      stdio: 'inherit',
    });

    // This package is ESM, and Node resolves module type from the nearest
    // package.json. Without this marker every vendored file is parsed as ESM
    // and fails with "exports is not defined in ES module scope".
    writeFileSync(join(vendorDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

    writeFileSync(
      join(vendorDir, 'VERSION.json'),
      `${JSON.stringify({ repo: REPO, ref, sha, committedAt: date, vendoredPaths: WANTED }, null, 2)}\n`,
    );

    console.log(`\nvendored into ${vendorDir}`);
    console.log('run `pnpm test` to confirm the real plugins still satisfy the harness.');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

await main();
