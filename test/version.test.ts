import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { readPackageVersion } from '../src/version.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkgVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

describe('readPackageVersion', () => {
  it('returns the version string from package.json', () => {
    expect(readPackageVersion()).toBe(pkgVersion);
  });

  it('returns a non-empty semver-shaped string', () => {
    const v = readPackageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('CLI -V version reporter (S-006 regression)', () => {
  it('prints exactly the version recorded in package.json', () => {
    const cliPath = `${repoRoot}/bin/autopilot.js`;
    if (!existsSync(`${repoRoot}/dist/index.js`)) {
      // `npm run build` hasn't been executed in this checkout. Skip rather
      // than fail — the unit test above already pins the contract via the
      // shared helper, and the build step is enforced by `prepare`.
      return;
    }

    const out = execFileSync(process.execPath, [cliPath, '-V'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    expect(out).toBe(pkgVersion);
  });
});
