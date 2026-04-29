import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  _resetBrowserbaseWarnedForTests,
  buildBuiltInMcps,
  detectAvailableMcps,
  looksLikeWebApp,
  renderMcpSection,
  resolveMcpServers,
} from '../src/mcp.js';

describe('buildBuiltInMcps', () => {
  beforeEach(() => {
    _resetBrowserbaseWarnedForTests();
  });

  it('always ships playwright and chrome-devtools', () => {
    const built = buildBuiltInMcps({});
    expect(built.playwright).toBeDefined();
    expect(built['chrome-devtools']).toBeDefined();
  });

  it('all credentialless entries are executable via npx', () => {
    const built = buildBuiltInMcps({});
    for (const cfg of Object.values(built)) {
      expect(cfg.command).toBe('npx');
      expect(cfg.args?.[0]).toBe('-y');
    }
  });

  it('includes browserbase when both env vars are set, with creds taken from env', () => {
    const built = buildBuiltInMcps({
      BROWSERBASE_API_KEY: 'bb_test_fromenv',
      BROWSERBASE_PROJECT_ID: 'proj-from-env',
    });
    expect(built.browserbase).toBeDefined();
    expect(built.browserbase.env?.BROWSERBASE_API_KEY).toBe('bb_test_fromenv');
    expect(built.browserbase.env?.BROWSERBASE_PROJECT_ID).toBe('proj-from-env');
  });

  it('drops browserbase from BUILT_IN_MCPS when env vars are unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildBuiltInMcps({});
      expect(built.browserbase).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('browserbase MCP disabled'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('drops browserbase when only one of the two creds is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(buildBuiltInMcps({ BROWSERBASE_API_KEY: 'bb_test_only' }).browserbase).toBeUndefined();
      _resetBrowserbaseWarnedForTests();
      expect(buildBuiltInMcps({ BROWSERBASE_PROJECT_ID: 'p' }).browserbase).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('only warns once across many calls (one-shot startup notice)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      buildBuiltInMcps({});
      buildBuiltInMcps({});
      buildBuiltInMcps({});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('never embeds a hardcoded bb_live token (regression: src/mcp.ts:63 leak)', () => {
    const built = buildBuiltInMcps({});
    const json = JSON.stringify(built);
    expect(json).not.toMatch(/bb_live_/);
  });
});

describe('detectAvailableMcps', () => {
  let dir: string;
  let homeDir: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;
  let prevProj: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-mcp-'));
    homeDir = await mkdtemp(join(tmpdir(), 'autopilot-home-'));
    prevHome = process.env.HOME;
    prevKey = process.env.BROWSERBASE_API_KEY;
    prevProj = process.env.BROWSERBASE_PROJECT_ID;
    process.env.HOME = homeDir;
    // Default: ensure browserbase IS present so the existing flow tests work.
    process.env.BROWSERBASE_API_KEY = 'bb_test_unit';
    process.env.BROWSERBASE_PROJECT_ID = 'proj-unit';
    _resetBrowserbaseWarnedForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = prevKey;
    if (prevProj === undefined) delete process.env.BROWSERBASE_PROJECT_ID;
    else process.env.BROWSERBASE_PROJECT_ID = prevProj;
  });

  it('returns the built-ins when no target or global config exists (env set)', () => {
    const mcps = detectAvailableMcps(dir);
    expect(mcps.map((m) => m.name).sort()).toEqual(['browserbase', 'chrome-devtools', 'playwright']);
    expect(mcps.every((m) => m.source === 'built-in')).toBe(true);
  });

  it('drops browserbase from detected MCPs when BROWSERBASE_API_KEY is unset', () => {
    delete process.env.BROWSERBASE_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mcps = detectAvailableMcps(dir);
      expect(mcps.map((m) => m.name).sort()).toEqual(['chrome-devtools', 'playwright']);
    } finally {
      warn.mockRestore();
    }
  });

  it('target-level .mcp.json adds new servers and overrides built-ins by name', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['-y', '@playwright/mcp@1.0.0'] },
          custom: { command: 'node', args: ['server.js'] },
        },
      }),
      'utf8',
    );
    const mcps = detectAvailableMcps(dir);
    const pw = mcps.find((m) => m.name === 'playwright')!;
    expect(pw.source).toBe('target');
    expect(pw.command).toContain('1.0.0');
    const custom = mcps.find((m) => m.name === 'custom')!;
    expect(custom.source).toBe('target');
    expect(custom.kind).toBe('unknown');
    // Non-overridden built-ins are still present.
    expect(mcps.find((m) => m.name === 'chrome-devtools')?.source).toBe('built-in');
  });

  it('global ~/.claude.json overrides built-ins and is overridden by target (later wins)', async () => {
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.9.0'] },
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'npx', args: ['-y', '@playwright/mcp@1.0.0'] },
        },
      }),
      'utf8',
    );
    const mcps = detectAvailableMcps(dir);
    expect(mcps.find((m) => m.name === 'playwright')?.source).toBe('target');
    expect(mcps.find((m) => m.name === 'playwright')?.command).toContain('1.0.0');
    expect(mcps.find((m) => m.name === 'github')?.source).toBe('global');
  });

  it('ignores malformed .mcp.json silently and still returns built-ins', async () => {
    await writeFile(join(dir, '.mcp.json'), 'not valid json {{{', 'utf8');
    expect(detectAvailableMcps(dir).every((m) => m.source === 'built-in')).toBe(true);
  });
});

describe('resolveMcpServers', () => {
  let dir: string;
  let homeDir: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;
  let prevProj: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-mcp-'));
    homeDir = await mkdtemp(join(tmpdir(), 'autopilot-home-'));
    prevHome = process.env.HOME;
    prevKey = process.env.BROWSERBASE_API_KEY;
    prevProj = process.env.BROWSERBASE_PROJECT_ID;
    process.env.HOME = homeDir;
    process.env.BROWSERBASE_API_KEY = 'bb_test_resolve';
    process.env.BROWSERBASE_PROJECT_ID = 'proj-resolve';
    _resetBrowserbaseWarnedForTests();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = prevKey;
    if (prevProj === undefined) delete process.env.BROWSERBASE_PROJECT_ID;
    else process.env.BROWSERBASE_PROJECT_ID = prevProj;
  });

  it('returns the built-in servers by default (browserbase env set)', () => {
    const servers = resolveMcpServers(dir);
    expect(Object.keys(servers).sort()).toEqual(['browserbase', 'chrome-devtools', 'playwright']);
    expect(servers.browserbase.env?.BROWSERBASE_API_KEY).toBe('bb_test_resolve');
    expect(servers.browserbase.env?.BROWSERBASE_PROJECT_ID).toBe('proj-resolve');
  });

  it('omits browserbase when BROWSERBASE_PROJECT_ID is missing', () => {
    delete process.env.BROWSERBASE_PROJECT_ID;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const servers = resolveMcpServers(dir);
      expect(Object.keys(servers).sort()).toEqual(['chrome-devtools', 'playwright']);
    } finally {
      warn.mockRestore();
    }
  });

  it('merges in extras and overrides by name (target > global > built-in)', async () => {
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'globalNpx', args: ['-y', 'pw@global'] },
          github: { command: 'npx', args: ['-y', '@mcp/github'] },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          playwright: { command: 'targetNpx', args: ['-y', 'pw@target'] },
          extra: { command: 'node', args: ['extra.js'] },
        },
      }),
      'utf8',
    );
    const servers = resolveMcpServers(dir);
    expect(servers.playwright.command).toBe('targetNpx');
    expect(servers.github.command).toBe('npx');
    expect(servers.extra.command).toBe('node');
    // Untouched built-ins still present.
    expect(servers['chrome-devtools'].command).toBe('npx');
    expect(servers.browserbase.env?.BROWSERBASE_PROJECT_ID).toBe('proj-resolve');
  });
});

describe('looksLikeWebApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-web-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects vite dev script', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
      'utf8',
    );
    expect(looksLikeWebApp(dir)).toBe(true);
  });

  it('detects react dependency', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'utf8',
    );
    expect(looksLikeWebApp(dir)).toBe(true);
  });

  it('detects index.html at root', async () => {
    await writeFile(join(dir, 'index.html'), '<html></html>', 'utf8');
    expect(looksLikeWebApp(dir)).toBe(true);
  });

  it('detects public/index.html', async () => {
    await mkdir(join(dir, 'public'));
    await writeFile(join(dir, 'public', 'index.html'), '<html></html>', 'utf8');
    expect(looksLikeWebApp(dir)).toBe(true);
  });

  it('returns false for a CLI-looking repo', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node bin/cli.js' }, dependencies: { commander: '^12' } }),
      'utf8',
    );
    expect(looksLikeWebApp(dir)).toBe(false);
  });
});

describe('renderMcpSection', () => {
  it('renders a bulleted list with kind + source + command', () => {
    const s = renderMcpSection(
      [
        { name: 'playwright', kind: 'playwright', source: 'built-in', command: 'npx -y @playwright/mcp@latest' },
        { name: 'github', kind: 'github', source: 'global', command: 'npx -y @mcp/github' },
      ],
      true,
    );
    expect(s).toContain('`playwright`');
    expect(s).toContain('playwright, from built-in');
    expect(s).toContain('github, from global');
  });
});

/**
 * S-017 regression: pure CLI metadata commands (--version, --help, status,
 * watch, log) used to print the `browserbase MCP disabled — set …` warning
 * because src/mcp.ts evaluated `BUILT_IN_MCPS = buildBuiltInMcps()` at
 * module top level, firing the one-shot console.warn for every entry point
 * that transitively imported mcp.ts (which is all of them — index.ts
 * imports autopilot.ts → mcp.ts). Making the built-ins lazy moved the
 * warn to first use, which only happens inside the `run` flow.
 *
 * These tests spawn the actual CLI binary with browserbase env scrubbed
 * so the warn would fire if the regression returned, and assert the exact
 * combined-stdio output of metadata commands.
 */
describe('CLI metadata commands stay silent on MCP config (S-017 regression)', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const cliPath = resolve(repoRoot, 'bin', 'autopilot.js');

  function runCli(args: string[]): { stdout: string; stderr: string; combined: string; status: number | null } {
    const env = { ...process.env };
    delete env.BROWSERBASE_API_KEY;
    delete env.BROWSERBASE_PROJECT_ID;
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      combined: (r.stdout ?? '') + (r.stderr ?? ''),
      status: r.status,
    };
  }

  it('--version prints exactly "0.9.0\\n" on combined stdio (no browserbase warning)', () => {
    const r = runCli(['--version']);
    expect(r.combined).toBe('0.9.0\n');
    expect(r.combined).not.toMatch(/browserbase/i);
  });

  it('--help line 1 is "Usage: ..." (not the browserbase warning)', () => {
    const r = runCli(['--help']);
    const firstLine = r.combined.split('\n')[0] ?? '';
    expect(firstLine).toMatch(/^Usage: /);
    expect(r.combined).not.toMatch(/browserbase MCP disabled/);
  });

  it('status against a non-autopilot path is silent on MCP config', async () => {
    const tmpRepo = await mkdtemp(join(tmpdir(), 'autopilot-cli-status-'));
    try {
      const r = runCli(['status', tmpRepo]);
      expect(r.combined).not.toMatch(/browserbase MCP disabled/);
      expect(r.combined).not.toMatch(/MCPs injected/);
    } finally {
      await rm(tmpRepo, { recursive: true, force: true });
    }
  });

  it('log against a non-autopilot path is silent on MCP config', async () => {
    const tmpRepo = await mkdtemp(join(tmpdir(), 'autopilot-cli-log-'));
    try {
      const r = runCli(['log', tmpRepo]);
      expect(r.combined).not.toMatch(/browserbase MCP disabled/);
      expect(r.combined).not.toMatch(/MCPs injected/);
    } finally {
      await rm(tmpRepo, { recursive: true, force: true });
    }
  });

  it('run --help is silent on MCP config', () => {
    const r = runCli(['run', '--help']);
    expect(r.combined).not.toMatch(/browserbase MCP disabled/);
    expect(r.combined).not.toMatch(/MCPs injected/);
  });
});
