import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type McpSource = 'built-in' | 'global' | 'target';

export interface McpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSummary {
  name: string;
  source: McpSource;
  command: string;
  /**
   * Well-known playbook slug if we recognize the server. Falls back to
   * 'unknown' for custom community servers.
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
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * One-shot warning so we don't spam stderr in long runs / repeated calls
 * (resolveMcpServers and detectAvailableMcps both call buildBuiltInMcps).
 */
let browserbaseDisabledWarned = false;

/**
 * Build the framework's baseline MCP map. `playwright` and `chrome-devtools`
 * are always included (they need no credentials). `browserbase` is included
 * only when BOTH `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are
 * present in the environment — otherwise it's omitted with a one-line
 * stderr warning so the user knows why a multi-session validator is
 * missing.
 *
 * No credentials are EVER hardcoded here. If you want browserbase, export
 * BROWSERBASE_API_KEY (your dashboard secret) and BROWSERBASE_PROJECT_ID
 * (the project UUID) before running autopilot. Get them at
 * https://browserbase.com/settings.
 */
export function buildBuiltInMcps(env: NodeJS.ProcessEnv = process.env): Record<string, McpServerConfig> {
  const built: Record<string, McpServerConfig> = {
    playwright: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    },
    'chrome-devtools': {
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
    },
  };

  const apiKey = env.BROWSERBASE_API_KEY;
  const projectId = env.BROWSERBASE_PROJECT_ID;
  if (apiKey && projectId) {
    built.browserbase = {
      command: 'npx',
      args: ['-y', '@browserbasehq/mcp@latest'],
      env: {
        BROWSERBASE_API_KEY: apiKey,
        BROWSERBASE_PROJECT_ID: projectId,
      },
    };
  } else if (!browserbaseDisabledWarned) {
    browserbaseDisabledWarned = true;
    // eslint-disable-next-line no-console -- one-shot startup notice; logger may not be wired here
    console.warn(
      'browserbase MCP disabled — set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable multi-session browser validation',
    );
  }
  return built;
}

/**
 * Lazy view of the built-ins. Computed on first access, NOT at module load,
 * so importing this module (e.g. transitively from a CLI metadata command
 * like `--version` or `--help`) does not fire the browserbase-disabled
 * warning. Prefer `buildBuiltInMcps()` directly when you need to react to
 * env changes (e.g. tests).
 */
let _builtInMcpsCache: Record<string, McpServerConfig> | null = null;
export function getBuiltInMcps(): Record<string, McpServerConfig> {
  if (_builtInMcpsCache === null) _builtInMcpsCache = buildBuiltInMcps();
  return _builtInMcpsCache;
}

/** Test-only: reset the one-shot warn latch + lazy cache so unit tests can re-trigger them. */
export function _resetBrowserbaseWarnedForTests(): void {
  browserbaseDisabledWarned = false;
  _builtInMcpsCache = null;
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

function summarizeCommand(cfg: McpServerConfig): string {
  return [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ').trim();
}

/**
 * Merged MCP map passed into every Claude Code session autopilot spawns.
 * Precedence (later wins): built-ins → global ~/.claude.json → target .mcp.json.
 * This means the framework ships a baseline validation stack, the user can
 * override it globally, and an individual project can override it locally.
 */
export function resolveMcpServers(repoPath: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = { ...buildBuiltInMcps() };

  const globalCfg = readJson<McpConfigJson>(join(homedir(), '.claude.json'));
  for (const [name, cfg] of Object.entries(globalCfg?.mcpServers ?? {})) {
    merged[name] = cfg;
  }

  const targetCfg = readJson<McpConfigJson>(join(repoPath, '.mcp.json'));
  for (const [name, cfg] of Object.entries(targetCfg?.mcpServers ?? {})) {
    merged[name] = cfg;
  }

  return merged;
}

/**
 * Detect MCPs visible to a session running at `repoPath`, annotated with
 * where they came from (built-in / global / target). Target wins on name
 * collisions; global wins over built-in. Used to render the prompt section
 * so the judge knows what's available.
 */
export function detectAvailableMcps(repoPath: string): McpSummary[] {
  const bySource = new Map<string, McpSummary>();

  for (const [name, cfg] of Object.entries(buildBuiltInMcps())) {
    bySource.set(name, {
      name,
      source: 'built-in',
      command: summarizeCommand(cfg),
      kind: inferKind(name, cfg.command, cfg.args ?? []),
    });
  }

  const globalCfg = readJson<McpConfigJson>(join(homedir(), '.claude.json'));
  for (const [name, cfg] of Object.entries(globalCfg?.mcpServers ?? {})) {
    bySource.set(name, {
      name,
      source: 'global',
      command: summarizeCommand(cfg),
      kind: inferKind(name, cfg.command, cfg.args ?? []),
    });
  }

  const targetCfg = readJson<McpConfigJson>(join(repoPath, '.mcp.json'));
  for (const [name, cfg] of Object.entries(targetCfg?.mcpServers ?? {})) {
    bySource.set(name, {
      name,
      source: 'target',
      command: summarizeCommand(cfg),
      kind: inferKind(name, cfg.command, cfg.args ?? []),
    });
  }

  return [...bySource.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Does the repo look like it has a web UI that will need browser-based
 * validation? Heuristic: package.json scripts reference vite/next/webpack
 * etc., or React/Vue/Svelte deps are present, or an index.html exists in
 * the top two levels.
 */
export function looksLikeWebApp(repoPath: string): boolean {
  const pkg = readJson<{
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(repoPath, 'package.json'));
  if (pkg) {
    const allScripts = Object.values(pkg.scripts ?? {}).join(' ').toLowerCase();
    if (/vite|next dev|webpack|react-scripts|astro dev|remix dev|nuxt dev/.test(allScripts)) return true;
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
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
 * judge/worker prompt.
 */
export function renderMcpSection(mcps: McpSummary[], isWebApp: boolean): string {
  if (mcps.length === 0) {
    return isWebApp
      ? '(NONE AVAILABLE — this is a web app but no MCP servers are reachable. ' +
        'This should not happen with a healthy autopilot install; check that npx is on PATH.)'
      : '(none configured)';
  }
  return mcps
    .map((m) => `- \`${m.name}\` (${m.kind}, from ${m.source}): ${m.command}`)
    .join('\n');
}
