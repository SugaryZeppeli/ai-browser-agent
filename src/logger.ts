import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from './agent/loop.js';

/**
 * Per-run structured logger.
 *
 * Every run creates a timestamped folder under `./runs/<ts>-<slug>/` containing:
 *   - log.jsonl          one JSON object per AgentEvent
 *   - video/*.webm       (if the browser was launched with recordVideoDir)
 *   - final_report.md    human-readable summary, written when the run ends
 */

export interface RunContext {
  dir: string;
  videoDir: string;
  logPath: string;
  reportPath: string;
  startedAt: string;
  goal: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function createRun(goal: string): RunContext {
  const root = path.resolve('runs');
  fs.mkdirSync(root, { recursive: true });
  const slug = slugify(goal) || 'run';
  const dir = path.join(root, `${timestamp()}-${slug}`);
  const videoDir = path.join(dir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });
  const logPath = path.join(dir, 'log.jsonl');
  const reportPath = path.join(dir, 'final_report.md');
  fs.writeFileSync(logPath, '');
  return {
    dir,
    videoDir,
    logPath,
    reportPath,
    startedAt: new Date().toISOString(),
    goal,
  };
}

export function appendLog(run: RunContext, event: AgentEvent) {
  try {
    const line =
      JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
    fs.appendFileSync(run.logPath, line);
  } catch (e) {
    console.warn('logger: failed to append log', (e as Error).message);
  }
}

export interface ReportInput {
  run: RunContext;
  finalResult: unknown;
  events: AgentEvent[];
  videoFile?: string;
}

export function writeReport(input: ReportInput) {
  const { run, finalResult, events, videoFile } = input;
  const steps = events.filter((e) => e.type === 'step').length;
  const actions = events.filter((e) => e.type === 'action');
  const reflections = events.filter((e) => e.type === 'reflection');
  const domQueries = events.filter((e) => e.type === 'dom_query');
  const safetyBlocks = events.filter((e) => e.type === 'safety_block');
  const safetyApprovals = events.filter((e) => e.type === 'safety_approved');
  const endedAt = new Date().toISOString();

  const lines: string[] = [];
  lines.push(`# Run Report`);
  lines.push('');
  lines.push(`**Goal:** ${run.goal}`);
  lines.push(`**Started:** ${run.startedAt}`);
  lines.push(`**Ended:** ${endedAt}`);
  lines.push(`**Directory:** \`${run.dir}\``);
  if (videoFile) lines.push(`**Video:** \`${videoFile}\``);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('```json');
  lines.push(JSON.stringify(finalResult, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## Counters`);
  lines.push(`- Agent steps: **${steps}**`);
  lines.push(`- Tool calls: **${actions.length}**`);
  lines.push(`- DOM sub-agent queries: **${domQueries.length}**`);
  lines.push(`- Reflections triggered: **${reflections.length}**`);
  lines.push(`- Safety blocks: **${safetyBlocks.length}**`);
  lines.push(`- Safety approvals: **${safetyApprovals.length}**`);
  lines.push('');
  lines.push(`## Tool-call breakdown`);
  const toolCounts: Record<string, number> = {};
  for (const a of actions) {
    if (a.type === 'action') {
      toolCounts[a.tool] = (toolCounts[a.tool] ?? 0) + 1;
    }
  }
  for (const [tool, n] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${tool}\` × ${n}`);
  }
  lines.push('');
  lines.push(`## Timeline`);
  let step = 0;
  for (const e of events) {
    switch (e.type) {
      case 'step':
        step = e.step;
        lines.push(
          `\n**Step ${step}** — ctx=${e.tokens}tok${e.decayed > 0 ? ` (decayed ${e.decayed})` : ''}`,
        );
        break;
      case 'action':
        lines.push(
          `  - → \`${e.tool}\`(${JSON.stringify(e.args).slice(0, 200)})`,
        );
        break;
      case 'observation':
        lines.push(`  - ${e.ok ? '✓' : '✗'} ${e.summary}`);
        break;
      case 'dom_query':
        lines.push(
          `  - 🔍 query_dom(${e.query.slice(0, 80)}) → ${e.answer.slice(0, 160)}`,
        );
        break;
      case 'reflection':
        lines.push(`  - ⟳ ${e.kind} reflection`);
        break;
      case 'ask_user':
        lines.push(`  - ? ${e.question}`);
        break;
      case 'safety_block':
        lines.push(`  - 🛡 BLOCK: ${e.reason}`);
        break;
      case 'safety_approved':
        lines.push(`  - 🛡 APPROVED: ${e.intent}`);
        break;
      case 'safety_declined':
        lines.push(`  - 🛡 DECLINED: ${e.intent}`);
        break;
      case 'finish':
        lines.push(
          `  - ■ finished (success=${e.success}): ${e.summary}`,
        );
        break;
      case 'error':
        lines.push(`  - ■ error: ${e.error}`);
        break;
      case 'max_steps':
        lines.push(`  - ■ max steps reached`);
        break;
      case 'budget_exceeded':
        lines.push(`  - ■ token budget exceeded: ${e.tokens}`);
        break;
    }
  }
  try {
    fs.writeFileSync(run.reportPath, lines.join('\n') + '\n');
  } catch (e) {
    console.warn('logger: failed to write report', (e as Error).message);
  }
}

export function findVideoFile(videoDir: string): string | undefined {
  if (!fs.existsSync(videoDir)) return undefined;
  const files = fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (files.length === 0) return undefined;
  return path.join(videoDir, files[0]!);
}
