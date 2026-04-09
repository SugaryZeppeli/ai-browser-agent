/**
 * L1 — Local HTML acceptance suite.
 *
 * Runs the agent against three offline HTML pages covering the failure
 * modes described in docs/REWRITE-PLAN.md §5. Each page exposes a
 * deterministic `window.__test_passed` flag that flips to true only
 * when the expected interaction happens. The runner navigates the
 * browser to each page, hands the agent a plain-language goal, and
 * after the agent finishes it reads the flag back.
 *
 *     npm run l1              # all three, ephemeral profile
 *     L1_ONLY=B npm run l1    # single scenario (A|B|C)
 *     HEADLESS=1 npm run l1   # headless (faster locally; spec still
 *                               requires headful for the real demo)
 *
 * These scenarios are integration tests for the harness — the agent
 * still has to figure out which element to click from the goal text.
 * There are no selectors passed to it.
 */
import path from 'node:path';
import url from 'node:url';
import chalk from 'chalk';
import { launchBrowser } from '../src/browser.js';
import { runAgent, type AgentEvent } from '../src/agent/loop.js';

interface Scenario {
  id: 'A' | 'B' | 'C';
  name: string;
  file: string;
  goal: string;
}

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const pagesDir = path.join(HERE, 'pages');
const fileUrl = (name: string) =>
  url.pathToFileURL(path.join(pagesDir, name)).toString();

const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    name: 'simple-button',
    file: fileUrl('simple-button.html'),
    goal: 'Mark the outstanding task on this page as complete, then finish.',
  },
  {
    id: 'B',
    name: 'nameless-icon',
    file: fileUrl('nameless-icon.html'),
    goal:
      'Dismiss the weekly digest notification on this page (close it with its × button). ' +
      'Leave the other notifications alone. Then finish.',
  },
  {
    id: 'C',
    name: 'virtualized-list',
    file: fileUrl('virtualized-list.html'),
    goal:
      'There is an inventory list on this page. Find the row labeled "Gold widget" ' +
      'and press its Claim button. You will need to scroll the list to find it. Then finish.',
  },
];

interface ScenarioResult {
  id: string;
  name: string;
  passed: boolean;
  steps: number;
  status: string;
  reason?: string;
  summary?: string;
}

function printEvent(e: AgentEvent) {
  switch (e.type) {
    case 'goal':
      console.log(chalk.bold.cyan(`▶ GOAL: ${e.goal}`));
      break;
    case 'step':
      console.log(chalk.gray(`── step ${e.step} ── ctx=${e.tokens}`));
      break;
    case 'action':
      console.log(
        chalk.yellow(
          `  → ${e.tool}(${JSON.stringify(e.args).slice(0, 180)})`,
        ),
      );
      break;
    case 'observation':
      console.log(
        chalk[e.ok ? 'green' : 'red'](
          `  ${e.ok ? '✓' : '✗'} ${e.summary.slice(0, 180)}`,
        ),
      );
      break;
    case 'dom_query':
      console.log(
        chalk.magenta(
          `  🔍 query_dom(${e.query.slice(0, 60)}) → ${e.answer.slice(0, 100)}`,
        ),
      );
      break;
    case 'finish':
      console.log(
        chalk.bold[e.success ? 'green' : 'red'](
          `■ finish (${e.success ? 'success' : 'failure'}): ${e.summary}`,
        ),
      );
      break;
    case 'max_steps':
      console.log(chalk.red('■ max steps'));
      break;
    case 'budget_exceeded':
      console.log(chalk.red(`■ budget exceeded: ${e.tokens}`));
      break;
    case 'error':
      console.log(chalk.red(`■ error: ${e.error}`));
      break;
  }
}

async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  const headless = process.env.HEADLESS === '1';
  console.log(chalk.bold(`\n══ L1-${sc.id} · ${sc.name} ══`));

  const { context, page, close } = await launchBrowser({
    headless,
    persistent: false,
  });

  let agentResult: Awaited<ReturnType<typeof runAgent>> | undefined;
  let testPassed = false;
  let reason: string | undefined;

  try {
    await page.goto(sc.file, { waitUntil: 'domcontentloaded' });
    // Belt-and-braces: make sure the flag is false at the start so a
    // stale inject from a prior navigation can't false-positive us.
    await page.evaluate(() => {
      (window as unknown as { __test_passed?: boolean }).__test_passed = false;
    });

    agentResult = await runAgent({
      context,
      goal: sc.goal,
      config: { maxSteps: 25 },
      onEvent: printEvent,
      // L1 pages are deterministic offline test fixtures with no real
      // external side effects — auto-approve any confirm_action so the
      // safety regex doesn't false-positive the cascade test. The
      // safety layer is exercised separately by `npm run safety`. If
      // the agent calls a real ask_user (not a confirm), record the
      // question as a soft signal — the test will still measure the
      // __test_passed flag, not the question itself.
      onAskUser: async (q) => {
        if (/CONFIRM REQUIRED/i.test(q)) return 'yes';
        reason = `ask_user during test: ${q.slice(0, 120)}`;
        return 'no';
      },
    });

    // Find the page whose URL matches our test file. The agent may
    // have opened new tabs; we care about the one we seeded.
    const target =
      context.pages().find((p) => p.url() === sc.file) ?? page;
    try {
      testPassed = await target.evaluate(
        () =>
          (window as unknown as { __test_passed?: boolean }).__test_passed ===
          true,
      );
    } catch (e) {
      reason = `flag read failed: ${(e as Error).message}`;
    }
  } catch (e) {
    reason = `exception: ${(e as Error).message}`;
  } finally {
    await close();
  }

  return {
    id: sc.id,
    name: sc.name,
    passed: testPassed,
    steps: agentResult?.steps ?? 0,
    status: agentResult?.status ?? 'no-result',
    reason,
    summary: agentResult?.summary,
  };
}

async function main() {
  const only = (process.env.L1_ONLY || '').toUpperCase();
  const picked = only
    ? SCENARIOS.filter((s) => s.id === only)
    : SCENARIOS;
  if (picked.length === 0) {
    console.error(`no scenario matches L1_ONLY=${only}`);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  for (const sc of picked) {
    results.push(await runScenario(sc));
  }

  console.log('\n' + chalk.bold('── L1 summary ──'));
  for (const r of results) {
    const mark = r.passed ? chalk.green('PASS') : chalk.red('FAIL');
    const detail = r.passed
      ? `steps=${r.steps}`
      : `steps=${r.steps} status=${r.status}` +
        (r.reason ? ` reason=${r.reason}` : '');
    console.log(`  ${mark}  L1-${r.id} ${r.name}  (${detail})`);
  }

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    console.log(chalk.red(`\n${failed}/${results.length} scenarios failed`));
    process.exit(1);
  }
  console.log(chalk.green(`\nall ${results.length} scenarios passed`));
}

main().catch((e) => {
  console.error('l1 crash:', e);
  process.exit(1);
});
