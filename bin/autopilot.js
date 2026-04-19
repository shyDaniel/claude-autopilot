#!/usr/bin/env node
import('../dist/index.js').catch((err) => {
  console.error('[autopilot] failed to start:', err?.stack || err);
  console.error('[autopilot] did you run `npm run build`?');
  process.exit(1);
});
