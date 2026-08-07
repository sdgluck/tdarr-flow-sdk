import type { LintFinding } from './rules/types.ts';

/**
 * Plain text, one finding per line. Kept separate from `lint()` so callers that
 * render findings themselves - the web app's lint panel - do not import a
 * formatter they will never call.
 */
export function formatFindings(findings: readonly LintFinding[]): string {
  if (!findings.length) return 'no findings';

  return findings
    .map((finding) => {
      const where = finding.nodeName ? ` [${finding.nodeName}]` : '';
      const flag = finding.assumed ? ' (assumed)' : '';
      return `${finding.severity}: ${finding.rule}${where}${flag} - ${finding.message}`;
    })
    .join('\n');
}
