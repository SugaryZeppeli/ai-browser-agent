/**
 * Phase 5 acceptance check for the a11y-tree state delta layer.
 *
 * Zero LLM. Drives the snapshot/renderDelta pair against three
 * scenarios that exercise the new added/removed sections of the
 * delta block:
 *
 *   1. L1-A simple-button — clicking the button removes nothing
 *      from the a11y tree (it just flips status text). The delta
 *      should show URL/title unchanged, no a11y additions, but
 *      possibly a main-text change. Sanity case.
 *
 *   2. L1-B nameless-icon — dismissing the weekly-digest card
 *      REMOVES one card from the DOM. The a11y delta should show
 *      that removal explicitly, plus a main-text change.
 *
 *   3. dialog-popup harness — opens a programmatic dialog and
 *      checks that the delta surfaces it as an "appeared" item.
 *      This is the F5 (hallucinated popup) acceptance check.
 *
 *     npm run delta-smoke
 */
import path from 'node:path';
import url from 'node:url';
import chalk from 'chalk';
import type { Page } from 'playwright';
import { launchBrowser } from '../src/browser.js';
import { snapshot, renderDelta } from '../src/agent/observer.js';
import { makeGetPage } from '../src/tools/types.js';
import { click } from '../src/tools/grounded.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const fileUrl = (name: string) =>
  url.pathToFileURL(path.join(HERE, 'pages', name)).toString();

interface Result {
  name: string;
  ok: boolean;
  msg: string;
}

async function takeBeforeAfter(
  page: Page,
  mutate: () => Promise<void>,
): Promise<{ before: Awaited<ReturnType<typeof snapshot>>; after: Awaited<ReturnType<typeof snapshot>>; delta: string }> {
  const before = await snapshot(page);
  await mutate();
  await page.waitForTimeout(150);
  const after = await snapshot(page);
  return { before, after, delta: renderDelta(before, after) };
}

async function caseSimpleButton(): Promise<Result[]> {
  const out: Result[] = [];
  const { context, page, close } = await launchBrowser({
    headless: process.env.HEADLESS !== '0',
    persistent: false,
  });
  try {
    await page.goto(fileUrl('simple-button.html'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(100);
    const ctx = { context, getPage: makeGetPage(context) };
    const { delta } = await takeBeforeAfter(page, async () => {
      const r = await click(ctx, {
        target: 'button Mark complete',
        because: 'delta-smoke L1-A: trigger a state mutation',
      });
      if (!r.ok) throw new Error(r.text);
    });
    // The button is still in the DOM, so no removed entry. Status div
    // text changed → main_text hash should change.
    out.push({
      name: 'L1-A delta sanity',
      // With ariaSnapshot, text change shows as a11y appeared/removed lines
      ok: delta.includes('Main content replaced') || delta === '' || /A11y/i.test(delta),
      msg:
        delta === ''
          ? 'empty (button click leaves a11y unchanged — acceptable)'
          : delta.replace(/\n/g, ' | '),
    });
  } finally {
    await close();
  }
  return out;
}

async function caseDismissCard(): Promise<Result[]> {
  const out: Result[] = [];
  const { context, page, close } = await launchBrowser({
    headless: process.env.HEADLESS !== '0',
    persistent: false,
  });
  try {
    await page.goto(fileUrl('nameless-icon.html'), {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(100);
    const ctx = { context, getPage: makeGetPage(context) };
    const { delta } = await takeBeforeAfter(page, async () => {
      const r = await click(ctx, {
        target: 'button ×',
        nth: 1,
        because: 'delta-smoke L1-B: dismissing first × to test removed-items diff',
      });
      if (!r.ok) throw new Error(r.text);
    });
    // Removing the weekly digest card should remove its × button (and
    // associated heading) from the a11y tree.
    out.push({
      name: 'L1-B delta has removed items',
      ok: /A11y removed/i.test(delta),
      msg: delta.replace(/\n/g, ' | '),
    });
    out.push({
      name: 'L1-B delta mentions weekly digest in removed list',
      ok: /Weekly digest/i.test(delta),
      msg: delta.length > 200 ? delta.slice(0, 200) + '…' : delta,
    });
  } finally {
    await close();
  }
  return out;
}

async function caseDialogAppears(): Promise<Result[]> {
  const out: Result[] = [];
  const { context, page, close } = await launchBrowser({
    headless: process.env.HEADLESS !== '0',
    persistent: false,
  });
  try {
    // Tiny inline page with a button that opens a dialog. Demonstrates
    // the F5 fix: the agent doesn't have to "see" the popup in the
    // screenshot — the delta literally tells it the dialog appeared.
    const html = `
      <!doctype html><html><body>
        <h1>Dialog harness</h1>
        <button id="b">Open</button>
        <div id="root"></div>
        <script>
          document.getElementById('b').addEventListener('click', () => {
            const d = document.createElement('div');
            d.setAttribute('role', 'dialog');
            d.setAttribute('aria-label', 'Confirmation');
            d.style.cssText = 'border:1px solid #aaa;padding:16px;width:240px;';
            d.innerHTML = '<h2>Confirmation</h2>' +
              '<button>Yes</button> <button>No</button>';
            document.getElementById('root').appendChild(d);
          });
        </script>
      </body></html>
    `;
    const dataUrl =
      'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await page.goto(dataUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(100);
    const ctx = { context, getPage: makeGetPage(context) };
    const { delta } = await takeBeforeAfter(page, async () => {
      const r = await click(ctx, {
        target: 'button Open',
        because: 'delta-smoke dialog harness: open the dialog to test added-items diff',
      });
      if (!r.ok) throw new Error(r.text);
    });
    out.push({
      name: 'dialog appeared in delta',
      ok: /A11y appeared/i.test(delta) || /Dialog opened/i.test(delta),
      msg: delta.replace(/\n/g, ' | '),
    });
    out.push({
      name: 'dialog buttons in added list',
      ok: /Yes|Confirmation/i.test(delta),
      msg: 'looking for Yes/No/Confirmation in delta',
    });
  } finally {
    await close();
  }
  return out;
}

async function main() {
  console.log(chalk.bold('state delta smoke (no LLM)'));
  const all: Result[] = [];
  all.push(...(await caseSimpleButton()));
  all.push(...(await caseDismissCard()));
  all.push(...(await caseDialogAppears()));

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
  console.error('delta-smoke crash:', e);
  process.exit(1);
});
