import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAvailableMcps, looksLikeWebApp, renderMcpSection } from '../src/mcp.js';

describe('detectAvailableMcps', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-mcp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when no .mcp.json anywhere', () => {
    // Use a HOME that's guaranteed empty too.
    const prevHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(detectAvailableMcps(dir)).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('parses a target-level .mcp.json and infers known kinds', async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = dir; // no global config
    try {
      await writeFile(
        join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
            'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
            custom: { command: 'node', args: ['server.js'] },
          },
        }),
        'utf8',
      );
      const mcps = detectAvailableMcps(dir);
      expect(mcps.map((m) => m.name)).toEqual(['chrome-devtools', 'custom', 'playwright']);
      expect(mcps.find((m) => m.name === 'playwright')?.kind).toBe('playwright');
      expect(mcps.find((m) => m.name === 'chrome-devtools')?.kind).toBe('chrome-devtools');
      expect(mcps.find((m) => m.name === 'custom')?.kind).toBe('unknown');
      expect(mcps.every((m) => m.source === 'target')).toBe(true);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('ignores malformed .mcp.json silently', async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await writeFile(join(dir, '.mcp.json'), 'not valid json {{{', 'utf8');
      expect(detectAvailableMcps(dir)).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  it('target takes precedence over global on name collision', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'autopilot-home-'));
    try {
      await writeFile(
        join(dir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            playwright: { command: 'npx', args: ['-y', '@playwright/mcp@1.0.0'] },
          },
        }),
        'utf8',
      );
      await writeFile(
        join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.1'] },
            github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          },
        }),
        'utf8',
      );
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const mcps = detectAvailableMcps(dir);
        const pw = mcps.find((m) => m.name === 'playwright')!;
        expect(pw.source).toBe('target');
        expect(pw.command).toContain('1.0.0');
        const gh = mcps.find((m) => m.name === 'github');
        expect(gh?.source).toBe('global');
        expect(gh?.kind).toBe('github');
      } finally {
        process.env.HOME = prevHome;
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
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
  it('returns a stern warning for web apps with no MCPs', () => {
    const s = renderMcpSection([], true);
    expect(s).toMatch(/NONE AVAILABLE/);
    expect(s).toMatch(/web app/);
  });

  it('returns a gentle "(none configured)" for non-web projects', () => {
    expect(renderMcpSection([], false)).toBe('(none configured)');
  });

  it('renders a bulleted list with kind + source + command', () => {
    const s = renderMcpSection(
      [
        { name: 'playwright', kind: 'playwright', source: 'target', command: 'npx -y @playwright/mcp@latest' },
        { name: 'github', kind: 'github', source: 'global', command: 'npx -y @mcp/github' },
      ],
      true,
    );
    expect(s).toContain('`playwright`');
    expect(s).toContain('playwright, from target');
    expect(s).toContain('github, from global');
    expect(s).toContain('npx -y @playwright/mcp@latest');
  });
});
