import type { LintRule } from './types.ts';

/**
 * The same plugin at two versions in one flow. Legal, and occasionally
 * deliberate - but usually it means a node was added long after the others and
 * quietly picked up different behaviour, and since versions can differ in output
 * count the two nodes may not even be wired the same way.
 */
export const mixedPluginVersions: LintRule = {
  id: 'mixed-plugin-versions',
  describe: 'a plugin is used at a single version throughout the flow',
  check(context) {
    const byPlugin = new Map<string, Map<string, string[]>>();

    for (const node of context.nodes) {
      const versions = byPlugin.get(node.pluginName) ?? new Map<string, string[]>();
      versions.set(node.version, [...(versions.get(node.version) ?? []), node.name]);
      byPlugin.set(node.pluginName, versions);
    }

    return [...byPlugin]
      .filter(([, versions]) => versions.size > 1)
      .map(([pluginName, versions]) => ({
        rule: 'mixed-plugin-versions',
        severity: 'warning' as const,
        message: `${pluginName} is used at more than one version: `
          + [...versions].map(([v, names]) => `${v} (${names.join(', ')})`).join(' vs '),
      }));
  },
};
