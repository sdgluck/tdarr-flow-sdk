/**
 * Read access to the generated plugin catalog.
 *
 * Browser-safe: the catalog is baked into `data.generated.ts` at build time, so
 * nothing here reaches for the vendored source. That is the whole reason
 * generation is a script rather than a runtime concern.
 */

import type {
  Catalog,
  CatalogEntry,
  CatalogInput,
  PluginRefString,
} from '../types/catalog.ts';
import type { ClassicPluginEntry } from '../types/classic.ts';
import type { DisplayConditions } from '../types/plugin.ts';
import { CATALOG } from './data.generated.ts';
import { CLASSIC_PLUGINS } from './classic.generated.ts';
import { fuzzySearch } from './fuzzy.ts';
import type { PluginRef } from './inputs.generated.ts';

export const catalog: Catalog = CATALOG;

const byRef = new Map<string, CatalogEntry>(CATALOG.entries.map((e) => [e.ref, e]));

/** Newest version first, so `[0]` is the current one. */
const byName = new Map<string, CatalogEntry[]>();
for (const entry of CATALOG.entries) {
  const list = byName.get(entry.name) ?? [];
  list.push(entry);
  byName.set(entry.name, list);
}
for (const list of byName.values()) {
  list.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export function listPlugins(): readonly CatalogEntry[] {
  return CATALOG.entries;
}

export function latestVersion(name: string): string | undefined {
  return byName.get(name)?.[0]?.version;
}

export function getPluginByRef(ref: PluginRefString): CatalogEntry | undefined {
  return byRef.get(ref);
}

/** Omitting `version` resolves to the newest catalogued version of the plugin. */
export function findPlugin(name: string, version?: string): CatalogEntry | undefined {
  if (version) return byRef.get(`${name}@${version}`);
  return byName.get(name)?.[0];
}

export function getPlugin(name: string, version?: string): CatalogEntry {
  const entry = findPlugin(name, version);
  if (entry) return entry;

  const known = byName.get(name);
  if (known) {
    throw new Error(
      `no such plugin version: ${name}@${version}. Catalogued versions: `
        + known.map((e) => e.version).join(', '),
    );
  }
  throw new Error(
    `no such plugin: ${name}. It may be a Local flow plugin, or newer than the vendored `
      + 'catalog - use localNode() to declare its shape, or run `pnpm plugins:update`.',
  );
}

export function pluginsByCategory(): ReadonlyMap<string, readonly CatalogEntry[]> {
  const grouped = new Map<string, CatalogEntry[]>();
  for (const entry of CATALOG.entries) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  return grouped;
}

/** Case-insensitive substring match over name, title, description and tags. */
export function searchPlugins(query: string): readonly CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return CATALOG.entries;
  return CATALOG.entries.filter((e) =>
    e.name.toLowerCase().includes(needle)
    || e.title.toLowerCase().includes(needle)
    || e.description.toLowerCase().includes(needle)
    || e.tags.some((t) => t.includes(needle))
  );
}

/**
 * Every input at its default, as the strings Tdarr would store. Useful as the
 * starting point for a form; not what the builder writes, which only emits keys
 * the caller actually set.
 */
export function defaultInputs(entry: CatalogEntry): Record<string, string> {
  return Object.fromEntries(entry.inputs.map((i) => [i.name, i.defaultValue]));
}

/**
 * Evaluates an input's `displayConditions` against the current *string* form of
 * the sibling values - the same comparison Tdarr's own UI makes, which is why
 * `'true'`/`'false'` are compared as strings rather than coerced first.
 *
 * Every occurrence in the vendored catalog uses `logic: 'AND'` at both levels,
 * but `OR` is implemented because the shape allows it.
 */
export function evaluateDisplayConditions(
  conditions: DisplayConditions | undefined,
  current: Record<string, string>,
): boolean {
  if (!conditions?.sets?.length) return true;

  const setPasses = conditions.sets.map((set) => {
    const results = (set.inputs ?? []).map(({ name, value, condition }) => {
      const actual = current[name] ?? '';
      return condition === '===' ? actual === value : actual !== value;
    });
    if (!results.length) return true;
    return set.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
  });

  return conditions.logic === 'OR' ? setPasses.some(Boolean) : setPasses.every(Boolean);
}

/** The inputs a form should render, given what the user has entered so far. */
export function visibleInputs(
  entry: CatalogEntry,
  current: Record<string, string>,
): readonly CatalogInput[] {
  const values = { ...defaultInputs(entry), ...current };
  return entry.inputs.filter((i) => evaluateDisplayConditions(i.displayConditions, values));
}

// --- classic (pre-flow) plugins ---------------------------------------------

export function listClassicPlugins(): readonly ClassicPluginEntry[] {
  return CLASSIC_PLUGINS;
}

/** Accepts either the bare id or the `Community:`-prefixed source id. */
export function findClassicPlugin(idOrSourceId: string): ClassicPluginEntry | undefined {
  const id = idOrSourceId.includes(':') ? idOrSourceId.split(':').slice(1).join(':') : idOrSourceId;
  return CLASSIC_PLUGINS.find((entry) => entry.id === id);
}

/**
 * Ranked by how well the query matches, name first. Every id shares the
 * `Tdarr_Plugin_` prefix, so a substring search over ids alone would rank
 * everything equally - which is why this is fuzzy and weighted.
 */
export function searchClassicPlugins(query: string): readonly ClassicPluginEntry[] {
  return fuzzySearch(query, CLASSIC_PLUGINS, (entry) => [
    entry.name,
    entry.id,
    entry.description,
    entry.tags.join(' '),
  ]).map((result) => result.item);
}

export { fuzzyScore, fuzzySearch } from './fuzzy.ts';
export type { FuzzyResult } from './fuzzy.ts';
export type { ClassicPluginEntry };
export type { PluginRef };
export type { Catalog, CatalogEntry, CatalogInput, PluginRefString };
