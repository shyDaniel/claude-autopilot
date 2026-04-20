import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SERVICE_PID_FILE = '.autopilot/service.pid';
const SERVICE_LOG_FILE = '.autopilot/service.log';

export interface ServiceHandle {
  cmd: string;
  pid: number;
  logPath: string;
  pidPath: string;
}

/**
 * Best-effort detection of how to start the target repo as a service.
 * Checks, in order:
 *   1. ./start.sh  — user-provided
 *   2. package.json scripts.dev  (pnpm if pnpm-lock.yaml exists, else npm run)
 *   3. package.json scripts.start
 *   4. pyproject.toml + a *.py that defines a FastAPI app → uvicorn
 * Returns null when nothing plausible is found.
 */
export function detectStartCmd(repoPath: string): string | null {
  const startSh = join(repoPath, 'start.sh');
  if (existsSync(startSh)) return './start.sh';

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const hasPnpm = existsSync(join(repoPath, 'pnpm-lock.yaml'));
      if (pkg.scripts?.dev) return hasPnpm ? 'pnpm dev' : 'npm run dev';
      if (pkg.scripts?.start) return hasPnpm ? 'pnpm start' : 'npm start';
    } catch {
      // fall through
    }
  }

  if (existsSync(join(repoPath, 'pyproject.toml'))) {
    const hasUvLock = existsSync(join(repoPath, 'uv.lock'));
    for (const candidate of ['main.py', 'app.py', 'src/main.py', 'src/app.py']) {
      const p = join(repoPath, candidate);
      if (!existsSync(p)) continue;
      try {
        const src = readFileSync(p, 'utf8');
        if (/FastAPI\s*\(|=\s*FastAPI\b/.test(src)) {
          const mod = candidate.replace(/\.py$/, '').replace(/\//g, '.');
          return hasUvLock
            ? `uv run uvicorn ${mod}:app --reload`
            : `uvicorn ${mod}:app --reload`;
        }
      } catch {
        // fall through
      }
    }
  }

  return null;
}

export async function stopPreviousService(repoPath: string): Promise<boolean> {
  const pidPath = join(repoPath, SERVICE_PID_FILE);
  if (!existsSync(pidPath)) return false;
  try {
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    // give it up to 2s to exit cleanly
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    return true;
  } catch {
    return false;
  }
}

export async function startService(
  repoPath: string,
  cmd: string,
): Promise<ServiceHandle> {
  const resolvedRepo = resolve(repoPath);
  const dir = join(resolvedRepo, '.autopilot');
  await mkdir(dir, { recursive: true });
  const logPath = join(dir, 'service.log');
  const pidPath = join(dir, 'service.pid');

  // Wipe previous log so each restart is easy to eyeball.
  await writeFile(logPath, `# ${new Date().toISOString()} — starting: ${cmd}\n`, 'utf8');

  const child = spawn('sh', ['-c', `exec ${cmd} >> ${shellQuote(logPath)} 2>&1`], {
    cwd: resolvedRepo,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  const pid = child.pid;
  if (!pid) throw new Error('failed to spawn service process');
  await writeFile(pidPath, String(pid), 'utf8');
  return { cmd, pid, logPath, pidPath };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
