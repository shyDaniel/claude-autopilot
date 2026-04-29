import { describe, expect, it } from 'vitest';
import { codexMcpConfigArgs } from '../src/codex.js';

describe('codexMcpConfigArgs', () => {
  it('renders nested TOML overrides for Codex MCP servers', () => {
    const args = codexMcpConfigArgs({
      'chrome-devtools': {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
      },
      browserbase: {
        command: 'npx',
        args: ['-y', '@browserbasehq/mcp@latest'],
        env: {
          BROWSERBASE_API_KEY: 'test-key',
          BROWSERBASE_PROJECT_ID: 'test-project',
        },
      },
    });

    expect(args).toContain('mcp_servers."chrome-devtools".command="npx"');
    expect(args).toContain('mcp_servers."chrome-devtools".args=["-y", "chrome-devtools-mcp@latest"]');
    expect(args).toContain('mcp_servers.browserbase.env={ BROWSERBASE_API_KEY = "test-key", BROWSERBASE_PROJECT_ID = "test-project" }');
  });
});
