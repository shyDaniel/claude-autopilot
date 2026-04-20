import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStartCmd } from '../src/service.js';

describe('detectStartCmd', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'autopilot-start-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers ./start.sh when present', async () => {
    await writeFile(join(dir, 'start.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
      'utf8',
    );
    expect(detectStartCmd(dir)).toBe('./start.sh');
  });

  it('falls back to pnpm dev when pnpm-lock present', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
      'utf8',
    );
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    expect(detectStartCmd(dir)).toBe('pnpm dev');
  });

  it('falls back to npm run dev without pnpm lock', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } }),
      'utf8',
    );
    expect(detectStartCmd(dir)).toBe('npm run dev');
  });

  it('uses scripts.start when dev is missing', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node server.js' } }),
      'utf8',
    );
    expect(detectStartCmd(dir)).toBe('npm start');
  });

  it('detects FastAPI + uv', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname="x"\n', 'utf8');
    await writeFile(join(dir, 'uv.lock'), '', 'utf8');
    await writeFile(join(dir, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n', 'utf8');
    expect(detectStartCmd(dir)).toBe('uv run uvicorn main:app --reload');
  });

  it('detects FastAPI in src/main.py with module path', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[project]\nname="x"\n', 'utf8');
    await mkdir(join(dir, 'src'));
    await writeFile(
      join(dir, 'src/main.py'),
      'from fastapi import FastAPI\napp = FastAPI()\n',
      'utf8',
    );
    expect(detectStartCmd(dir)).toBe('uvicorn src.main:app --reload');
  });

  it('returns null when nothing is detectable', () => {
    expect(detectStartCmd(dir)).toBeNull();
  });

  it('returns null on malformed package.json', async () => {
    await writeFile(join(dir, 'package.json'), 'not valid json {{{', 'utf8');
    expect(detectStartCmd(dir)).toBeNull();
  });
});
