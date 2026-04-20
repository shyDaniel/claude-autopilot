import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type McpSource = 'target' | 'global';

export interface McpSummary {
  name: string;
  source: McpSource;
  command: string;
  /**
   * Well-known playbook slug if we recognize the server (playwright,
   * chrome-devtools, browserbase, axe, lighthouse, postgres, sqlite, github).
   * Falls back to 'unknown' for custom servers.
   */
  kind:
    | 'playwright'
    | 'chrome-devtools'
    | 'browserbase'
    | 'puppeteer'
    | 'axe'
    | 'lighthouse'
    | 'postgres'
    | 'sqlite'
    | 'github'
    | 'filesystem'
    | 'unknown';
}

interface McpConfigJson {
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function inferKind(name: string, command: string, args: string[]): McpSummary['kind'] {
  const needle = [name, command, ...args].join(' ').toLowerCase();
  if (needle.includes('playwright/mcp') || /\bplaywright\b/.test(name)) return 'playwright';
  if (needle.includes('chrome-devtools-mcp') || /chrome.*devtools/.test(name)) return 'chrome-devtools';
  if (needle.includes('@browserbasehq/mcp') || /browserbase/.test(name)) return 'browserbase';
  if (needle.includes('server-puppeteer') || /puppeteer/.test(name)) return 'puppeteer';
  if (/axe/.test(name) || needle.includes('axe-core')) return 'axe';
  if (/lighthouse/.test(name)) return 'lighthouse';
  if (/postgres/.test(name)) return 'postgres';
  if (/sqlite/.test(name)) return 'sqlite';
  if (/github/.test(name) && !needle.includes('mcp-github-mocked')) return 'github';
  if (/filesystem/.test(name) || needle.includes('server-filesystem')) return 'filesystem';
  return 'unknown';
}

function summarizeCommand(command: string | undefined, args: string[]): string {
  return [command ?? '', ...args].filter(Boolean).join(' ').trim();
}

/**
 * Detect MCPs visible to a Claude Code session running at `repoPath`.
 * Target-level `.mcp.json` takes precedence over `~/.claude.json` global
 * servers when names collide.
 */
export function detectAvailableMcps(repoPath: string): McpSummary[] {
  const found = new Map<string, McpSummary>();

  const targetCfg = readJson<McpConfigJson>(join(repoPath, '.mcp.json'));
  for (const [name, cfg] of Object.entries(targetCfg?.mcpServers ?? {})) {
    const args = Array.isArray(cfg.args) ? cfg.args : [];
    const command = summarizeCommand(cfg.command, args);
    found.set(name, { name, source: 'target', command, kind: inferKind(name, cfg.command ?? '', args) });
  }

  const globalCfg = readJson<McpConfigJson>(join(homedir(), '.claude.json'));
  for (const [name, cfg] of Object.entries(globalCfg?.mcpServers ?? {})) {
    if (found.has(name)) continue;
    const args = Array.isArray(cfg.args) ? cfg.args : [];
    const command = summarizeCommand(cfg.command, args);
    found.set(name, { name, source: 'global', command, kind: inferKind(name, cfg.command ?? '', args) });
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Does the repo look like it has a web UI that will need browser-based
 * validation? Heuristic: package.json has a `dev` script referencing
 * vite/next/webpack OR there's an index.html somewhere in the top two levels.
 */
export function looksLikeWebApp(repoPath: string): boolean {
  const pkg = readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(repoPath, 'package.json'),
  );
  if (pkg) {
    const allScripts = Object.values(pkg.scripts ?? {}).join(' ').toLowerCase();
    if (/vite|next dev|webpack|react-scripts|astro dev|remix dev|nuxt dev/.test(allScripts)) return true;
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    if (
      allDeps['react'] ||
      allDeps['vue'] ||
      allDeps['svelte'] ||
      allDeps['next'] ||
      allDeps['@sveltejs/kit'] ||
      allDeps['astro'] ||
      allDeps['vite']
    ) {
      return true;
    }
  }
  return existsSync(join(repoPath, 'index.html')) || existsSync(join(repoPath, 'public', 'index.html'));
}

/**
 * Render the MCP list as a compact bulleted section for injection into the
 * judge/worker prompt. Empty list yields a prominent warning line so the
 * judge knows to flag it.
 */
export function renderMcpSection(mcps: McpSummary[], isWebApp: boolean): string {
  if (mcps.length === 0) {
    const warning = isWebApp
      ? '(NONE AVAILABLE — this is a web app but no browser MCP is configured. ' +
        'The judge CANNOT validate UI without one; see HARD DONE:FALSE rules below.)'
      : '(none configured)';
    return warning;
  }
  return mcps
    .map((m) => `- \`${m.name}\` (${m.kind}, from ${m.source} config): ${m.command}`)
    .join('\n');
}
