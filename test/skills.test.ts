import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillFile,
  loadSkill,
  renderSkill,
  renderSkillByName,
  clearSkillCache,
} from '../src/skills.js';

describe('parseSkillFile', () => {
  it('parses frontmatter and body', () => {
    const raw = `---
name: judge
description: be uncompromising
runtime: any
strongModelOnly: true
outputFormat: json
---
hello {{name}}`;
    const skill = parseSkillFile('judge', '/tmp/SKILL.md', raw);
    expect(skill.frontmatter.name).toBe('judge');
    expect(skill.frontmatter.description).toBe('be uncompromising');
    expect(skill.frontmatter.runtime).toBe('any');
    expect(skill.frontmatter.strongModelOnly).toBe(true);
    expect(skill.frontmatter.outputFormat).toBe('json');
    expect(skill.body).toBe('hello {{name}}');
  });

  it('handles missing frontmatter as plain body', () => {
    const raw = 'no frontmatter here';
    const skill = parseSkillFile('x', '/tmp/SKILL.md', raw);
    expect(skill.body).toBe('no frontmatter here');
    expect(skill.frontmatter.runtime).toBe('any');
  });

  it('strips quoted frontmatter values', () => {
    const raw = `---
name: "judge"
description: 'critic mode'
---
body`;
    const skill = parseSkillFile('judge', '/tmp/SKILL.md', raw);
    expect(skill.frontmatter.name).toBe('judge');
    expect(skill.frontmatter.description).toBe('critic mode');
  });
});

describe('renderSkill', () => {
  beforeEach(() => clearSkillCache());

  it('substitutes {{var}} placeholders', () => {
    const skill = parseSkillFile('x', '/tmp/x', '---\nname: x\n---\nhello {{name}}, you are {{role}}');
    const out = renderSkill(skill, { name: 'Claude', role: 'judge' });
    expect(out).toBe('hello Claude, you are judge');
  });

  it('leaves unknown placeholders as-is', () => {
    const skill = parseSkillFile('x', '/tmp/x', '---\nname: x\n---\nhello {{unknown}}');
    expect(renderSkill(skill, {})).toBe('hello {{unknown}}');
  });

  it('renders boolean false / undefined / null as empty', () => {
    const skill = parseSkillFile('x', '/tmp/x', '---\nname: x\n---\nA{{a}}B{{b}}C{{c}}D');
    expect(renderSkill(skill, { a: false, b: undefined, c: null })).toBe('ABCD');
  });

  it('handles whitespace inside braces', () => {
    const skill = parseSkillFile('x', '/tmp/x', '---\nname: x\n---\n{{ name }}');
    expect(renderSkill(skill, { name: 'foo' })).toBe('foo');
  });
});

describe('loadSkill from disk', () => {
  it('reads SKILL.md from a custom root', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-test-'));
    mkdirSync(join(root, 'demo'), { recursive: true });
    writeFileSync(
      join(root, 'demo', 'SKILL.md'),
      `---
name: demo
description: demo skill
---
hello {{who}}`,
    );
    clearSkillCache();
    const out = renderSkillByName('demo', { who: 'world' }, root);
    expect(out).toBe('hello world');
  });

  it('throws on missing skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-test-'));
    expect(() => loadSkill('nonexistent', root)).toThrow(/not found/);
  });
});

describe('shipped skills load', () => {
  beforeEach(() => clearSkillCache());

  it('judge skill loads and renders required vars', () => {
    const out = renderSkillByName('judge', {
      repoPath: '/tmp/repo',
      availableMcps: '(none configured)',
      stuckBrief: '',
      agentName: 'Claude Code',
    });
    expect(out).toContain('/tmp/repo');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Output format');
  });

  it('eval skill loads and includes the verdict block', () => {
    const out = renderSkillByName('eval', {
      repoPath: '/tmp/repo',
      availableMcps: '(none configured)',
      judgeVerdictBlock: '{"done":true}',
      agentName: 'Claude Code',
    });
    expect(out).toContain('/tmp/repo');
    expect(out).toContain('{"done":true}');
    expect(out).toContain('overrule');
    expect(out).toContain('passed');
  });

  it('orchestrate skill loads and includes inputs', () => {
    const out = renderSkillByName('orchestrate', {
      repoPath: '/tmp/repo',
      runStartedAt: '2026-04-29T00:00:00Z',
      iteration: 5,
      judgeVerdictBlock: '{"done":false}',
      recentHistoryBlock: '(history)',
      planSummaryBlock: '(plan)',
      recentCommitsBlock: '(commits)',
      recentWorkerExcerptsBlock: '(transcripts)',
      refinementsSoFar: 0,
      maxRefinements: 3,
    });
    expect(out).toContain('next_skill');
    expect(out).toContain('iteration: 5');
    expect(out).toContain('budget cap');
  });

  it('work skill loads and includes outstanding bullets', () => {
    const out = renderSkillByName('work', {
      repoPath: '/tmp/repo',
      iteration: 2,
      outstandingSummary: 'short summary',
      outstandingBulletsBlock: '  - bullet A\n  - bullet B',
      subtaskBriefOrFallback: '## SUBTASK\n\nbrief here',
      availableMcps: '(none)',
      pushLine: 'Commit AND push.',
      agentName: 'Claude Code',
    });
    expect(out).toContain('iteration 2');
    expect(out).toContain('bullet A');
    expect(out).toContain('brief here');
    expect(out).toContain('Commit AND push.');
  });

  it('evolve skill loads with renamed triggerReportPath var', () => {
    const out = renderSkillByName('evolve', {
      autopilotRepo: '/repo/agent-autopilot',
      targetRepo: '/repo/target',
      triggerReportPath: '/tmp/trigger.md',
      recentIterationsPath: '/repo/target/.autopilot/iterations',
      eventsPath: '/repo/target/.autopilot/events.jsonl',
      refinementNumber: 1,
      maxRefinements: 3,
    });
    expect(out).toContain('/tmp/trigger.md');
    expect(out).toContain('refinement #1 of at most 3');
    expect(out).toContain('skills/');
  });

  it('reframe skill loads', () => {
    const out = renderSkillByName('reframe', {
      repoPath: '/tmp/repo',
      stuckSubtaskBlock: 'subtask blob',
      recentAttemptsBlock: 'attempts blob',
      touchedFilesBlock: 'files blob',
    });
    expect(out).toContain('subtask blob');
    expect(out).toContain('action');
    expect(out).toContain('replacements');
  });
});
