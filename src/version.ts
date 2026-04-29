import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Read the published package version from the on-disk package.json.
 *
 * Resolved relative to this module so it works whether the code is run
 * from `src/` (via tsx) or `dist/` (after `tsc`) — both directories sit
 * one level below `package.json`.
 *
 * Kept in its own module so the CLI's `-V` and a vitest can both call
 * it, eliminating the drift bug where `src/index.ts` carried a stale
 * literal ('0.3.0') for six release cuts.
 */
export function readPackageVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const raw = readFileSync(fileURLToPath(pkgUrl), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`package.json at ${pkgUrl.href} has no string "version" field`);
  }
  return parsed.version;
}
