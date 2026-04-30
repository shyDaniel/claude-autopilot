import { renderSkillByName } from './skills.js';

export interface WorkerPromptInput {
  repoPath: string;
  iteration: number;
  outstandingSummary: string;
  outstandingBullets: string[];
  noPush: boolean;
  availableMcps: string;
  isWebApp: boolean;
  /** Self-contained brief for the one subtask this iteration should tackle. */
  subtaskBrief?: string;
  agentName?: string;
}

export function workerPrompt(i: WorkerPromptInput): string {
  const pushLine = i.noPush
    ? '(Do NOT push — commits only. The --no-push flag is set.)'
    : 'Commit AND push to the remote. If no remote is configured, create one using `gh repo create` or stop and record the blocker in WORKLOG.md.';

  const outstandingBulletsBlock = i.outstandingBullets.length
    ? i.outstandingBullets.map((b) => '  - ' + b).join('\n')
    : '  (no bullet breakdown provided)';

  const subtaskBriefOrFallback =
    i.subtaskBrief ??
    "## THIS ITERATION'S SUBTASK\n\n(No structured brief was assigned — pick the highest-value outstanding item using your judgment.)";

  return renderSkillByName('work', {
    repoPath: i.repoPath,
    iteration: i.iteration,
    outstandingSummary: i.outstandingSummary,
    outstandingBulletsBlock,
    subtaskBriefOrFallback,
    availableMcps: i.availableMcps,
    pushLine,
    agentName: i.agentName ?? 'Claude Code',
  });
}

export interface MetaRefinePromptInput {
  autopilotRepo: string;
  targetRepo: string;
  /**
   * Path to the report that triggered this refinement — historically the
   * stagnation report; with orchestrator-driven evolves, this can be the
   * orchestrator's verdict file. Field name is generic.
   */
  triggerReportPath: string;
  recentIterationsPath: string;
  eventsPath: string;
  refinementsSoFar: number;
  maxRefinements: number;
}

export function metaRefinePrompt(i: MetaRefinePromptInput): string {
  return renderSkillByName('evolve', {
    autopilotRepo: i.autopilotRepo,
    targetRepo: i.targetRepo,
    triggerReportPath: i.triggerReportPath,
    recentIterationsPath: i.recentIterationsPath,
    eventsPath: i.eventsPath,
    refinementNumber: i.refinementsSoFar + 1,
    maxRefinements: i.maxRefinements,
    maxRefinementsClause: renderMaxRefinementsClause(i.maxRefinements),
  });
}

/**
 * Render the optional " of at most N" / " (uncapped)" tail to be
 * appended after refinement-count text in skill prompts. Returns ""
 * (empty) when uncapped so the surrounding sentence reads cleanly.
 */
function renderMaxRefinementsClause(maxRefinements: number): string {
  return Number.isFinite(maxRefinements) ? ` of at most ${maxRefinements}` : ' (no per-run cap; evolve as warranted)';
}

export interface JudgePromptInput {
  repoPath: string;
  availableMcps: string;
  isWebApp: boolean;
  /** Pre-rendered block describing subtasks that hit attempt ceiling. */
  stuckBrief?: string;
  agentName?: string;
}

export function judgePrompt(input: JudgePromptInput | string): string {
  const i: JudgePromptInput =
    typeof input === 'string'
      ? { repoPath: input, availableMcps: '(unknown — caller did not detect)', isWebApp: false }
      : input;

  return renderSkillByName('judge', {
    repoPath: i.repoPath,
    availableMcps: i.availableMcps,
    stuckBrief: i.stuckBrief ?? '',
    agentName: i.agentName ?? 'Claude Code',
  });
}

export interface EvalPromptInput {
  repoPath: string;
  availableMcps: string;
  judgeVerdictBlock: string;
  agentName?: string;
}

export function evalPrompt(i: EvalPromptInput): string {
  return renderSkillByName('eval', {
    repoPath: i.repoPath,
    availableMcps: i.availableMcps,
    judgeVerdictBlock: i.judgeVerdictBlock,
    agentName: i.agentName ?? 'Claude Code',
  });
}

export interface OrchestratePromptInput {
  repoPath: string;
  runStartedAt: string;
  iteration: number;
  judgeVerdictBlock: string;
  recentHistoryBlock: string;
  planSummaryBlock: string;
  recentCommitsBlock: string;
  recentWorkerExcerptsBlock: string;
  refinementsSoFar: number;
  maxRefinements: number;
}

export function orchestratePrompt(i: OrchestratePromptInput): string {
  return renderSkillByName('orchestrate', {
    repoPath: i.repoPath,
    runStartedAt: i.runStartedAt,
    iteration: i.iteration,
    judgeVerdictBlock: i.judgeVerdictBlock,
    recentHistoryBlock: i.recentHistoryBlock,
    planSummaryBlock: i.planSummaryBlock,
    recentCommitsBlock: i.recentCommitsBlock,
    recentWorkerExcerptsBlock: i.recentWorkerExcerptsBlock,
    refinementsSoFar: i.refinementsSoFar,
    maxRefinements: i.maxRefinements,
    maxRefinementsClause: renderMaxRefinementsClause(i.maxRefinements),
  });
}

export interface ReframePromptInput {
  repoPath: string;
  stuckSubtaskBlock: string;
  recentAttemptsBlock: string;
  touchedFilesBlock: string;
}

export function reframePrompt(i: ReframePromptInput): string {
  return renderSkillByName('reframe', {
    repoPath: i.repoPath,
    stuckSubtaskBlock: i.stuckSubtaskBlock,
    recentAttemptsBlock: i.recentAttemptsBlock,
    touchedFilesBlock: i.touchedFilesBlock,
  });
}
