/**
 * CLI entry point — run one goal against the browser agent.
 *
 * Usage:
 *   npm run task -- "your goal here"
 *   PERSISTENT=1 npm run task -- "your goal here"
 *
 * Flags via env:
 *   HEADLESS=1    run headless (default: visible — spec requires a visible browser)
 *   PERSISTENT=1  reuse ./user-data/ Chromium profile (for logged-in sessions)
 *   VIDEO=0       disable video recording
 */

import readline from 'node:readline/promises';
import chalk from 'chalk';
import { launchBrowser } from './browser.js';
import { runAgent, type AgentEvent } from './agent/loop.js';
import { createRun, appendLog, writeReport, findVideoFile } from './logger.js';

async function main() {
  const goal = process.argv.slice(2).join(' ').trim();
  if (!goal) {
    console.error('usage: npm run task -- "<goal>"');
    process.exit(2);
  }

  const headless = process.env.HEADLESS === '1';
  const persistent = process.env.PERSISTENT === '1';
  const recordVideo = process.env.VIDEO !== '0';

  const run = createRun(goal);
  console.log(chalk.dim(`📁 run dir: ${run.dir}`));
  if (recordVideo) console.log(chalk.dim(`🎥 video:   ${run.videoDir}`));

  const { context, close } = await launchBrowser({
    headless,
    persistent,
    recordVideoDir: recordVideo ? run.videoDir : undefined,
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const capturedEvents: AgentEvent[] = [];

  const onEvent = (e: AgentEvent) => {
    capturedEvents.push(e);
    appendLog(run, e);
    switch (e.type) {
      case 'goal':
        console.log(chalk.bold.cyan(`\n▶ GOAL: ${e.goal}\n`));
        break;
      case 'step':
        console.log(
          chalk.gray(
            `── step ${e.step} ── ctx=${e.tokens.toLocaleString()}tok` +
              (e.decayed > 0 ? ` (decayed ${e.decayed} screenshots)` : ''),
          ),
        );
        break;
      case 'thinking': {
        const t = e.text.replace(/\s+/g, ' ').slice(0, 240);
        console.log(chalk.dim(`  💭 ${t}`));
        break;
      }
      case 'action':
        console.log(
          chalk.yellow(
            `  → ${e.tool}(${JSON.stringify(e.args).slice(0, 200)})`,
          ),
        );
        break;
      case 'observation':
        console.log(
          chalk[e.ok ? 'green' : 'red'](`  ${e.ok ? '✓' : '✗'} ${e.summary}`),
        );
        break;
      case 'dom_query':
        console.log(
          chalk.magenta(
            `  🔍 query_dom(${e.query.slice(0, 80)}) → ${e.items} items → ${e.answer.slice(0, 120)}`,
          ),
        );
        break;
      case 'reflection':
        console.log(chalk.magenta(`  ⟳ ${e.kind} reflection`));
        break;
      case 'ask_user':
        console.log(chalk.blue(`  ? ${e.question}`));
        break;
      case 'safety_block':
        console.log(chalk.bgRed.white(` 🛡 SAFETY BLOCK `) + ' ' + e.reason);
        break;
      case 'safety_approved':
        console.log(chalk.bold.green(` 🛡 APPROVED `) + ' ' + e.intent);
        break;
      case 'safety_declined':
        console.log(chalk.bold.red(` 🛡 DECLINED `) + ' ' + e.intent);
        break;
      case 'finish':
        console.log(
          chalk.bold[e.success ? 'green' : 'red'](
            `\n■ FINISHED (${e.success ? 'success' : 'failure'}): ${e.summary}\n`,
          ),
        );
        break;
      case 'max_steps':
        console.log(chalk.red(`\n■ MAX STEPS REACHED\n`));
        break;
      case 'budget_exceeded':
        console.log(
          chalk.red(`\n■ TOKEN BUDGET EXCEEDED (${e.tokens.toLocaleString()})\n`),
        );
        break;
      case 'error':
        console.log(chalk.red(`\n■ ERROR: ${e.error}\n`));
        break;
    }
  };

  let result: unknown;
  try {
    result = await runAgent({
      context,
      goal,
      onEvent,
      onAskUser: async (q) =>
        rl.question(chalk.blue(`\n[user input] ${q}\n> `)),
    });
    console.log(chalk.bold('\nresult:'), JSON.stringify(result, null, 2));
  } finally {
    rl.close();
    await close();
    const videoFile = recordVideo ? findVideoFile(run.videoDir) : undefined;
    writeReport({
      run,
      finalResult: result ?? null,
      events: capturedEvents,
      videoFile,
    });
    console.log(chalk.bold.green(`\n📄 report: ${run.reportPath}`));
    if (videoFile) console.log(chalk.bold.green(`🎥 video:  ${videoFile}`));
  }
}

main().catch((e) => {
  console.error('crash:', e);
  process.exit(1);
});
