/**
 * Interactive chat REPL — this is the primary UX for the agent.
 *
 * Matches the "ideal solution" screenshots from the task spec: a visible
 * browser on one side, a terminal chat on the other. User types a task,
 * sees the agent call tools in real time, gets an Assistant reply at the
 * end. Types another task, same browser, same session, logged-in state
 * carries over.
 *
 * Run:
 *   npm run dev                      ephemeral Chromium
 *   PERSISTENT=1 npm run dev         reuses ./user-data/ (logged-in profile)
 *   HEADLESS=1 npm run dev           hide window (not recommended — spec says visible)
 */

import readline from 'node:readline/promises';
import chalk from 'chalk';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { launchBrowser } from './browser.js';
import { runAgent, type AgentEvent } from './agent/loop.js';
import { createRun, appendLog, writeReport, findVideoFile } from './logger.js';
import { startScreenRecording, type ScreenRecorder } from './screen-recorder.js';
import { MAX_STEPS, REPL_TRUNC } from './config.js';

/* ─────────────── pretty printer ─────────────── */

const TRUNC = (s: string, n = REPL_TRUNC) =>
  s.length > n ? s.slice(0, n) + '…' : s;

function prettyArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args, null, 2);
    return json
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n');
  } catch {
    return '    ' + String(args);
  }
}

function makeEventPrinter() {
  let printedAssistantPrefix = false;
  return (e: AgentEvent) => {
    switch (e.type) {
      case 'goal':
        // We already printed "You: ..." when the user typed; nothing to add.
        printedAssistantPrefix = false;
        break;

      case 'thinking': {
        // Free-form model message — render as the Assistant speaking.
        const text = e.text.replace(/\s+/g, ' ').trim();
        if (!text) break;
        if (!printedAssistantPrefix) {
          console.log(chalk.bold.green('\nAssistant:') + ' ' + text);
          printedAssistantPrefix = true;
        } else {
          console.log('  ' + chalk.green(text));
        }
        break;
      }

      case 'action':
        if (!printedAssistantPrefix) {
          // The model skipped straight to a tool call — still emit the prefix
          // so the chat flow reads naturally.
          console.log(chalk.bold.green('\nAssistant:'));
          printedAssistantPrefix = true;
        }
        console.log(chalk.cyan(`\n  Using tool: ${chalk.bold(e.tool)}`));
        console.log(chalk.dim('    Input:'));
        console.log(chalk.dim(prettyArgs(e.args)));
        break;

      case 'observation': {
        const mark = e.ok ? chalk.green('    Result:') : chalk.red('    Result (ERROR):');
        console.log(mark + ' ' + TRUNC(e.summary, 220));
        break;
      }

      case 'dom_query':
        console.log(
          chalk.magenta('    DOM Sub-agent: ') +
            chalk.dim(`query="${TRUNC(e.query, 100)}" items=${e.items}`),
        );
        console.log(chalk.magenta('    Sub-agent result: ') + TRUNC(e.answer, 220));
        break;

      case 'step':
        // Steps are background info — keep them dim and on one line.
        process.stdout.write(
          chalk.dim(
            `\n── step ${e.step} · ctx=${e.tokens.toLocaleString()}tok` +
              (e.decayed > 0 ? ` · decayed ${e.decayed} screenshots` : '') +
              ' ──',
          ) + '\n',
        );
        break;

      case 'reflection':
        console.log(chalk.dim(`    [${e.kind} reflection]`));
        break;

      case 'ask_user':
        console.log(chalk.bold.blue(`\n  [agent asks] ${e.question}`));
        break;

      case 'respond': {
        // Non-blocking narrative from the agent — render as a green
        // Assistant line. Unlike `thinking`, this is an explicit
        // user-facing message (not a reasoning trace).
        const text = e.text.trim();
        if (!text) break;
        if (!printedAssistantPrefix) {
          console.log(chalk.bold.green('\nAssistant:') + ' ' + text);
          printedAssistantPrefix = true;
        } else {
          console.log('\n' + chalk.bold.green('Assistant:') + ' ' + text);
        }
        break;
      }

      case 'plan': {
        const subgoals = e.subgoals
          .map((s, i) => `      ${i + 1}. ${s}`)
          .join('\n');
        console.log(chalk.bold.yellow('\n  📋 PLAN'));
        console.log(
          chalk.yellow(`    success: `) + chalk.dim(e.success_condition),
        );
        console.log(chalk.yellow(`    subgoals:`));
        console.log(chalk.dim(subgoals));
        console.log(
          chalk.yellow(`    verify via: `) + chalk.dim(e.verification_strategy),
        );
        if (e.risks && e.risks.length > 0) {
          console.log(
            chalk.yellow(`    risks: `) + chalk.dim(e.risks.join(' | ')),
          );
        }
        break;
      }

      case 'verify': {
        const badge =
          e.verdict === 'pass'
            ? chalk.bold.green(' ✓ VERIFY PASS ')
            : e.verdict === 'partial'
              ? chalk.bold.yellow(' ~ VERIFY PARTIAL ')
              : chalk.bold.red(' ✗ VERIFY FAIL ');
        console.log('\n  ' + badge + ' ' + chalk.dim(`(${TRUNC(e.target, 60)})`));
        console.log(chalk.dim('    evidence: ' + TRUNC(e.evidence, 220)));
        if (e.notes) console.log(chalk.dim('    notes: ' + TRUNC(e.notes, 180)));
        break;
      }

      case 'safety_block':
        console.log(chalk.bgRed.white(' 🛡 SAFETY BLOCK ') + ' ' + e.reason);
        break;
      case 'safety_approved':
        console.log(chalk.bold.green(' 🛡 APPROVED ') + e.intent);
        break;
      case 'safety_declined':
        console.log(chalk.bold.red(' 🛡 DECLINED ') + e.intent);
        break;

      case 'finish':
        console.log(
          chalk.bold.green('\nAssistant:') +
            ' ' +
            chalk[e.success ? 'green' : 'red'](e.summary),
        );
        if (e.success) console.log(chalk.green('✅ Выполнено.'));
        else console.log(chalk.red('❌ Не удалось.'));
        break;

      case 'max_steps':
        console.log(chalk.red('\n■ MAX STEPS REACHED'));
        break;
      case 'budget_exceeded':
        console.log(
          chalk.red(
            `\n■ TOKEN BUDGET EXCEEDED (${e.tokens.toLocaleString()})`,
          ),
        );
        break;
      case 'error':
        console.log(chalk.red(`\n■ ERROR: ${e.error}`));
        break;
    }
  };
}

/* ─────────────── main REPL ─────────────── */

async function main() {
  const headless = process.env.HEADLESS === '1';
  const persistent = process.env.PERSISTENT === '1';
  const recordScreen = process.env.VIDEO !== '0';

  console.log(chalk.bold.cyan('\n════════════════  AI Browser Agent  ════════════════\n'));
  console.log(
    chalk.dim(
      `mode: ${persistent ? chalk.green('PERSISTENT') : 'ephemeral'}  ` +
        `browser: ${headless ? 'headless' : chalk.green('visible')}  ` +
        `video: ${recordScreen ? chalk.green('on') : 'off'}`,
    ),
  );
  console.log(
    chalk.dim(
      'Type a task and press Enter. Empty line or Ctrl+C to quit.\n',
    ),
  );

  // Launch one browser, share across all chat turns.
  const sessionRun = createRun('chat-session');
  const { context, close } = await launchBrowser({
    headless,
    persistent,
  });

  // Full-screen recording (browser + terminal in one file).
  let screenRec: ScreenRecorder | undefined;
  if (recordScreen) {
    const path = await import('node:path');
    const screenPath = path.join(sessionRun.dir, 'screen.mp4');
    screenRec = startScreenRecording(screenPath);
    console.log(chalk.dim(`🖥️  screen recording: ${screenPath}`));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 50,
  });

  // Graceful shutdown: one close, one video save.
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try {
      rl.close();
    } catch {}
    if (screenRec) {
      console.log(chalk.dim('\n⏹  stopping screen recording...'));
      await screenRec.stop();
      console.log(chalk.green(`🎥 video: ${screenRec.filePath}`));
    }
    try {
      await close();
    } catch {}
    console.log(chalk.dim('bye.'));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Cross-turn conversation memory. Each runAgent call receives this
  // array and returns an updated version, so the agent remembers what
  // it did and reported in earlier turns of the same REPL session.
  // Cleared only when the process restarts.
  let conversation: ChatCompletionMessageParam[] = [];

  // Multi-line paste support: accumulate lines with debounce.
  // When the user pastes a multi-line goal, readline fires 'line'
  // for each line nearly simultaneously. We collect them all and
  // treat the batch as one goal after 150ms of silence.
  function readGoal(): Promise<string | null> {
    process.stdout.write(chalk.bold.yellow('\nYou: '));
    return new Promise((resolve) => {
      const lines: string[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        rl.removeListener('line', onLine);
        const text = lines.join('\n').trim();
        resolve(text || null);
      };
      const onLine = (line: string) => {
        lines.push(line);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 150);
      };
      rl.on('line', onLine);
      rl.once('close', () => {
        if (timer) clearTimeout(timer);
        rl.removeListener('line', onLine);
        resolve(null);
      });
    });
  }

  let turn = 0;
  while (true) {
    turn++;
    let goal: string;
    try {
      const g = await readGoal();
      if (!g) { await shutdown(); return; }
      goal = g;
    } catch {
      await shutdown();
      return;
    }

    // Per-turn run folder for structured logs.
    const run = createRun(goal);
    const capturedEvents: AgentEvent[] = [];
    const pretty = makeEventPrinter();

    const onEvent = (e: AgentEvent) => {
      capturedEvents.push(e);
      appendLog(run, e);
      pretty(e);
    };

    try {
      const result = await runAgent({
        context,
        goal,
        history: conversation,
        onEvent,
        onAskUser: async (q) => {
          // Re-prompt inside the same REPL. Also works for confirm_action.
          const answer = await rl.question(chalk.bold.magenta('\n[you] ') + q + '\n> ');
          return answer.trim();
        },
        config: { maxSteps: MAX_STEPS },
      });

      // Thread the updated conversation back in for the next turn so
      // the agent can reference what it observed, reported, or decided
      // on earlier turns of this session.
      conversation = result.history;

      // Write the per-turn report for later inspection.
      writeReport({
        run,
        finalResult: result,
        events: capturedEvents,
      });
      console.log(
        chalk.dim(
          `\n  (turn ${turn} report: ${run.reportPath} · ${result.steps} steps)`,
        ),
      );
    } catch (e: unknown) {
      console.error(chalk.red('crash:'), e);
    }
  }
}

main().catch(async (e) => {
  console.error('fatal:', e);
  process.exit(1);
});
