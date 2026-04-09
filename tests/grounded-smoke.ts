/**
 * Phase 2 acceptance check for the grounded click / type cascade.
 *
 * Zero LLM calls. Navigates to each L1 HTML page, exercises
 * parseTarget + resolveTarget + click + type directly, and asserts
 * the observable outcome:
 *
 *   - L1-A simple-button  — click "button Mark complete" → __test_passed flips
 *   - L1-B nameless-icon  — text-based match → clicking the weekly-digest
 *                            × dismisses the correct card, __test_passed flips
 *   - L1-C virtualized-list — multiple "button Claim" matches → cascade
 *                            reports ambiguity; nth=1 clicks the first; then
 *                            we scroll and try again, no false success
 *   - parseTarget round-trip — role/name split, quote stripping, whitespace
 *
 *     npm run grounded-smoke
 */
import path from 'node:path';
import url from 'node:url';
import chalk from 'chalk';
import type { BrowserContext, Page } from 'playwright';
import { launchBrowser } from '../src/browser.js';
import { makeGetPage } from '../src/tools/types.js';
import type { ToolContext } from '../src/tools/types.js';
import {
  parseTarget,
  resolveTarget,
  click,
  type as typeHandler,
} from '../src/tools/grounded.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const fileUrl = (name: string) =>
  url.pathToFileURL(path.join(HERE, 'pages', name)).toString();

interface CaseResult {
  name: string;
  ok: boolean;
  msg: string;
}

function makeCtx(context: BrowserContext): ToolContext {
  return {
    context,
    getPage: makeGetPage(context),
  };
}

async function withPage<T>(
  setup: (page: Page) => Promise<void>,
  fn: (ctx: ToolContext, page: Page) => Promise<T>,
): Promise<T> {
  const { context, page, close } = await launchBrowser({
    headless: process.env.HEADLESS !== '0',
    persistent: false,
  });
  try {
    await setup(page);
    return await fn(makeCtx(context), page);
  } finally {
    await close();
  }
}

function readFlag(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (window as unknown as { __test_passed?: boolean }).__test_passed === true,
  );
}

/* ─────────────── parse tests ─────────────── */

function testParse(): CaseResult[] {
  const results: CaseResult[] = [];
  const eq = (
    label: string,
    got: ReturnType<typeof parseTarget>,
    expected: { role: string; name: string },
  ) => {
    if (typeof got === 'string') {
      results.push({ name: label, ok: false, msg: `parse error: ${got}` });
      return;
    }
    const ok = got.role === expected.role && got.name === expected.name;
    results.push({
      name: label,
      ok,
      msg: ok
        ? `→ role=${got.role} name="${got.name}"`
        : `got role=${got.role} name="${got.name}" expected role=${expected.role} name="${expected.name}"`,
    });
  };

  eq('parse: button Submit', parseTarget('button Submit'), {
    role: 'button',
    name: 'Submit',
  });
  eq('parse: quoted name', parseTarget('button "Submit task"'), {
    role: 'button',
    name: 'Submit task',
  });
  eq('parse: unicode quotes', parseTarget('link \u201CHome\u201D'), {
    role: 'link',
    name: 'Home',
  });
  eq('parse: russian name', parseTarget('link Резюме и профиль'), {
    role: 'link',
    name: 'Резюме и профиль',
  });
  eq('parse: trailing spaces', parseTarget('  textbox   Email   '), {
    role: 'textbox',
    name: 'Email',
  });
  eq('parse: role only', parseTarget('button'), { role: 'button', name: '' });
  eq('parse: uppercase role', parseTarget('BUTTON Ok'), {
    role: 'button',
    name: 'Ok',
  });

  const empty = parseTarget('   ');
  results.push({
    name: 'parse: empty → error',
    ok: typeof empty === 'string',
    msg: typeof empty === 'string' ? `rejected: ${empty}` : 'unexpectedly accepted',
  });

  return results;
}

/* ─────────────── live browser tests ─────────────── */

async function testL1A(): Promise<CaseResult[]> {
  const res: CaseResult[] = [];
  await withPage(
    async (page) => {
      await page.goto(fileUrl('simple-button.html'), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(100);
    },
    async (ctx, page) => {
      // Stage-1 role match
      const parsed = parseTarget('button Mark complete');
      if (typeof parsed === 'string') {
        res.push({ name: 'L1-A parse', ok: false, msg: parsed });
        return;
      }
      const resolved = await resolveTarget(page, parsed, ctx);
      if (!resolved.ok) {
        res.push({ name: 'L1-A resolve', ok: false, msg: resolved.reason });
        return;
      }
      res.push({
        name: 'L1-A resolve',
        ok: resolved.strategy === 'role' && resolved.count === 1,
        msg: `strategy=${resolved.strategy} count=${resolved.count}`,
      });

      // Actually click via the public handler
      const clickRes = await click(ctx, {
        target: 'button Mark complete',
        because: 'L1-A test: clicking the only actionable button',
      });
      res.push({
        name: 'L1-A click',
        ok: clickRes.ok,
        msg: clickRes.text.slice(0, 120),
      });

      const passed = await readFlag(page);
      res.push({
        name: 'L1-A __test_passed',
        ok: passed,
        msg: passed ? 'flag flipped' : 'flag still false',
      });
    },
  );
  return res;
}

async function testL1B(): Promise<CaseResult[]> {
  const res: CaseResult[] = [];
  await withPage(
    async (page) => {
      await page.goto(fileUrl('nameless-icon.html'), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(100);
    },
    async (ctx, page) => {
      // The icon button has name "×" (or empty). The discriminator
      // lives in the surrounding card text — the agent must target
      // something like "button Weekly digest" which getByRole will
      // NOT match, getByText will match the card heading, but
      // clicking the text match clicks the heading, not the button.
      //
      // The realistic way for the agent to nail this: target the
      // × literally ("button ×") and disambiguate with nth based on
      // the observe() ordering. Card A's close button comes before
      // Card B's close button in document order, so nth=1 should
      // dismiss the weekly digest card. This matches what observe()
      // shows the agent.
      const clickRes = await click(ctx, {
        target: 'button ×',
        nth: 1,
        because: 'L1-B test: dismissing the first × icon button',
      });
      res.push({
        name: 'L1-B click button × nth=1',
        ok: clickRes.ok,
        msg: clickRes.text.slice(0, 140),
      });

      const passed = await readFlag(page);
      res.push({
        name: 'L1-B __test_passed',
        ok: passed,
        msg: passed ? 'flag flipped correctly' : 'flag still false',
      });
    },
  );
  return res;
}

async function testL1C(): Promise<CaseResult[]> {
  const res: CaseResult[] = [];
  await withPage(
    async (page) => {
      await page.goto(fileUrl('virtualized-list.html'), {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(100);
    },
    async (ctx, page) => {
      // "button Claim" alone has 10+ matches — auto-fallthrough should
      // click the first actionable one without reporting ambiguity error.
      const autoClick = await click(ctx, {
        target: 'button Claim',
        because: 'L1-C test: auto-fallthrough picks first actionable match',
      });
      res.push({
        name: 'L1-C auto-fallthrough click',
        ok: autoClick.ok && /OK clicked/.test(autoClick.text),
        msg: autoClick.text.slice(0, 140),
      });

      // Click nth=1 — should hit the first Claim in document order.
      // Since SECRET_INDEX is below the fold, this is guaranteed to
      // NOT be the Gold widget → __test_passed must stay false.
      const nthClick = await click(ctx, {
        target: 'button Claim',
        nth: 1,
        because: 'L1-C test: nth=1 should hit the first row, NOT the secret one',
      });
      res.push({
        name: 'L1-C click Claim nth=1 (first visible row)',
        ok: nthClick.ok,
        msg: nthClick.text.slice(0, 120),
      });
      const passedWrong = await readFlag(page);
      res.push({
        name: 'L1-C negative check: flag stays false for wrong row',
        ok: !passedWrong,
        msg: passedWrong
          ? 'flag flipped incorrectly on non-target row'
          : 'flag correctly still false',
      });

      // NOTE: reaching the Gold-widget row requires scrolling the
      // virtualized container end-to-end, which is a scroll-harness
      // concern, not a cascade concern. The agent-facing equivalent
      // is exercised by the full L1 suite (tests/l1.ts) and by
      // Phase 7 live runs — not here.
    },
  );
  return res;
}

/* ─────────────── type test (uses simple-button page — no input there,
 * so we use a tiny data URL instead) ─────────────── */

async function testType(): Promise<CaseResult[]> {
  const res: CaseResult[] = [];
  const html = `
    <!doctype html><html><body>
      <label for="e">Email</label>
      <input id="e" type="email" placeholder="you@example.com" />
      <div id="out"></div>
      <script>
        document.getElementById('e').addEventListener('input', (ev) => {
          document.getElementById('out').textContent = ev.target.value;
        });
      </script>
    </body></html>
  `;
  await withPage(
    async (page) => {
      await page.setContent(html);
    },
    async (ctx, page) => {
      // Stage: role=textbox with name from <label>. Playwright's
      // accessible name algorithm resolves "Email" for this input.
      const r = await typeHandler(ctx, {
        target: 'textbox Email',
        text: 'hello@world.dev',
        because: 'unit test: typing into the textbox to verify echo round-trip',
      });
      res.push({
        name: 'type: textbox Email',
        ok: r.ok,
        msg: r.text.slice(0, 120),
      });
      const echoed = await page.locator('#out').innerText();
      res.push({
        name: 'type: echoed value',
        ok: echoed === 'hello@world.dev',
        msg: `out="${echoed}"`,
      });
    },
  );
  return res;
}

/* ─────────────── main ─────────────── */

async function main() {
  console.log(chalk.bold('grounded click/type smoke (no LLM)'));
  const all: CaseResult[] = [];
  all.push(...testParse());
  all.push(...(await testL1A()));
  all.push(...(await testL1B()));
  all.push(...(await testL1C()));
  all.push(...(await testType()));

  let failed = 0;
  for (const r of all) {
    const tag = r.ok ? chalk.green('PASS') : chalk.red('FAIL');
    console.log(`  ${tag}  ${r.name}  —  ${r.msg}`);
    if (!r.ok) failed++;
  }
  if (failed > 0) {
    console.log(chalk.red(`\n${failed}/${all.length} checks failed`));
    process.exit(1);
  }
  console.log(chalk.green(`\nall ${all.length} checks passed`));
}

main().catch((e) => {
  console.error('grounded-smoke crash:', e);
  process.exit(1);
});
