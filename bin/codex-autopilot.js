#!/usr/bin/env node
process.env.AUTOPILOT_AGENT = process.env.AUTOPILOT_AGENT ?? 'codex';
import('../dist/index.js').catch((err) => {
  console.error('[codex-autopilot] failed to start:', err?.stack || err);
  console.error('[codex-autopilot] did you run `npm run build`?');
  process.exit(1);
});
