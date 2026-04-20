import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILT_IN_MCPS,
  detectAvailableMcps,
  looksLikeWebApp,
  renderMcpSection,
  resolveMcpServers,
} from '../src/mcp.js';

describe('BUILT_IN_MCPS', () => {
  it('ships playwright, chrome-devtools, and browserbase out of the box', () => {
    expect(Object.keys(BUILT_IN_MCPS).sort()).toEqual([
      'browserbase',
      'chrome-devtools',
      'playwright',
    ]);
  });

  it('all entries are executable via npx', () => {
    for (const cfg of Object.values(BUILT_IN_MCPS)) {
      expect(cfg.command).toBe('npx');
      expect(cfg.args?.[0]).toBe('-y');
    }
  });

  it('browserbase built-in carries both required credentials', () => {
    const env = BUILT_IN_MCPS.browserbase.env ?? {};
    expect(env.BROWSERBASE_API_KEY).toMatch(/^bb_/);
    expect(env.BROWSERBASE_PROJECT_ID).toMatch(/^[0-9a-f-]{30,}$/);
  });
});

describe('detectAvailableMcps', () => {
  let dir: string;
  let homeDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-mcp-'));
    homeDir = await mkdtemp(join(tmpdir(), 'autopilot-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns the built-ins when no target or global config exists', () => {
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const mcps = detectAvailableMcps(dir);
      expect(mcps.map((m) => m.name).sort()).toEqual(['browserbase', 'chrome-devtools', 'playwright']);
      expect(mcps.every((m) => m.source === 'built-in')).toBe(true);
    } finally {
      process.env.HOME = prev;
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
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const mcps = detectAvailableMcps(dir);
      const pw = mcps.find((m) => m.name === 'playwright')!;
      expect(pw.source).toBe('target');
      expect(pw.command).toContain('1.0.0');
      const custom = mcps.find((m) => m.name === 'custom')!;
      expect(custom.source).toBe('target');
      expect(custom.kind).toBe('unknown');
      // Non-overridden built-ins are still present.
      expect(mcps.find((m) => m.name === 'chrome-devtools')?.source).toBe('built-in');
    } finally {
      process.env.HOME = prev;
    }
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
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const mcps = detectAvailableMcps(dir);
      expect(mcps.find((m) => m.name === 'playwright')?.source).toBe('target');
      expect(mcps.find((m) => m.name === 'playwright')?.command).toContain('1.0.0');
      expect(mcps.find((m) => m.name === 'github')?.source).toBe('global');
    } finally {
      process.env.HOME = prev;
    }
  });

  it('ignores malformed .mcp.json silently and still returns built-ins', async () => {
    await writeFile(join(dir, '.mcp.json'), 'not valid json {{{', 'utf8');
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      expect(detectAvailableMcps(dir).every((m) => m.source === 'built-in')).toBe(true);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('resolveMcpServers', () => {
  let dir: string;
  let homeDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-mcp-'));
    homeDir = await mkdtemp(join(tmpdir(), 'autopilot-home-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns the built-in servers by default', () => {
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const servers = resolveMcpServers(dir);
      expect(Object.keys(servers).sort()).toEqual(['browserbase', 'chrome-devtools', 'playwright']);
      expect(servers.browserbase.env?.BROWSERBASE_API_KEY).toMatch(/^bb_/);
    } finally {
      process.env.HOME = prev;
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
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const servers = resolveMcpServers(dir);
      expect(servers.playwright.command).toBe('targetNpx');
      expect(servers.github.command).toBe('npx');
      expect(servers.extra.command).toBe('node');
      // Untouched built-ins still present.
      expect(servers['chrome-devtools'].command).toBe('npx');
      expect(servers.browserbase.env?.BROWSERBASE_PROJECT_ID).toBeTruthy();
    } finally {
      process.env.HOME = prev;
    }
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
