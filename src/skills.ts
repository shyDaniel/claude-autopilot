import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillFrontmatter {
  name: string;
  description?: string;
  /** "claude" | "codex" | "any" — default "any". Skill can opt out of a runtime. */
  runtime?: 'claude' | 'codex' | 'any';
  /** If true, the caller should never use a fallback model — strong-only. */
  strongModelOnly?: boolean;
  /**
   * If "json", the caller expects the skill to emit a single fenced JSON
   * block at the end. The loader does not enforce; it is documentation
   * for the orchestration layer.
   */
  outputFormat?: 'json' | 'free';
}

export interface Skill {
  name: string;
  frontmatter: SkillFrontmatter;
  body: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a SKILL.md file: optional YAML-ish frontmatter delimited by `---`,
 * followed by the prompt body. We do NOT pull in a YAML library — the
 * frontmatter is a tiny `key: value` flat map.
 */
export function parseSkillFile(name: string, path: string, raw: string): Skill {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return {
      name,
      path,
      frontmatter: { name, runtime: 'any' },
      body: raw.trim(),
    };
  }
  const frontmatter = parseFrontmatter(match[1]);
  if (!frontmatter.name) frontmatter.name = name;
  return {
    name,
    path,
    frontmatter,
    body: match[2].trim(),
  };
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const out: SkillFrontmatter = { name: '' };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
    else if (key === 'runtime') {
      if (val === 'claude' || val === 'codex' || val === 'any') out.runtime = val;
    } else if (key === 'strongModelOnly' || key === 'strong_model_only') {
      out.strongModelOnly = val === 'true';
    } else if (key === 'outputFormat' || key === 'output_format') {
      if (val === 'json' || val === 'free') out.outputFormat = val;
    }
  }
  return out;
}

/**
 * Resolve the skills/ directory shipped with this repo. Walks up from
 * `import.meta.url` until it finds a package.json named "agent-autopilot"
 * (or the legacy "claude-autopilot") with a sibling skills/ directory.
 */
export function resolveSkillsRoot(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'agent-autopilot' || pkg.name === 'claude-autopilot') {
          const skillsDir = join(dir, 'skills');
          if (existsSync(skillsDir)) return skillsDir;
        }
      } catch {
        // ignore unreadable package.json
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'agent-autopilot skills/ directory not found — installation is corrupt or this is not a writable checkout',
  );
}

const SKILL_CACHE = new Map<string, Skill>();

export function loadSkill(name: string, root?: string): Skill {
  const cacheKey = `${root ?? ''}::${name}`;
  const cached = SKILL_CACHE.get(cacheKey);
  if (cached) return cached;
  const skillsRoot = root ?? resolveSkillsRoot();
  const path = resolve(skillsRoot, name, 'SKILL.md');
  if (!existsSync(path)) {
    throw new Error(`skill "${name}" not found at ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const skill = parseSkillFile(name, path, raw);
  SKILL_CACHE.set(cacheKey, skill);
  return skill;
}

/**
 * Render a skill body with `{{var}}` template substitution. Unknown
 * variables are left as-is (so accidental {{double_braces}} in prose
 * don't blow up). Boolean false / undefined renders as empty.
 */
export function renderSkill(skill: Skill, vars: Record<string, unknown>): string {
  return skill.body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in vars)) return match;
    const v = vars[key];
    if (v === undefined || v === null || v === false) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  });
}

/** One-shot helper: load + render in a single call. */
export function renderSkillByName(name: string, vars: Record<string, unknown>, root?: string): string {
  return renderSkill(loadSkill(name, root), vars);
}

/** Test-only: clear the in-process cache between runs. */
export function clearSkillCache(): void {
  SKILL_CACHE.clear();
}
