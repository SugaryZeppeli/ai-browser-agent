/**
 * Phase 1 acceptance check for observe().
 *
 * Launches a browser, navigates to each L1 HTML page plus example.com,
 * calls snapshotPage(), and asserts the rendered tree contains the
 * elements we expect. No LLM calls — this is a pure Playwright-level
 * integration check for the perception primitive.
 *
 *   npm run observe-smoke
 */
import path from 'node:path';
import url from 'node:url';
import chalk from 'chalk';
import { launchBrowser } from '../src/browser.js';
import { snapshotPage } from '../src/tools/observe.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const fileUrl = (name: string) =>
  url.pathToFileURL(path.join(HERE, 'pages', name)).toString();

interface Case {
  name: string;
  url: string;
  /** Strings that MUST appear in the rendered tree text. */
  must: string[];
  /** Strings that must NOT appear (sanity). */
  mustNot?: string[];
}

const CASES: Case[] = [
  {
    name: 'L1-A simple-button',
    url: fileUrl('simple-button.html'),
    must: ['button "Mark complete"'],
  },
  {
    name: 'L1-B nameless-icon',
    url: fileUrl('nameless-icon.html'),
    // The × buttons have no accessible name ("×" literal counts — we
    // accept it as a one-char name). The surrounding card text must
    // surface via container context.
    must: ['Weekly digest ready', 'Storage almost full'],
  },
  {
    name: 'L1-C virtualized-list',
    url: fileUrl('virtualized-list.html'),
    // Only ~10 rows are mounted before scrolling; we should see a few.
    must: ['Item 1', 'button "Claim"'],
    mustNot: ['Gold widget'], // below the fold, shouldn't be in DOM yet
  },
  {
    name: 'example.com',
    url: 'https://example.com/',
    // example.com's single link currently says "Learn more".
    must: ['Example Domain', 'link "Learn more'],
  },
];

async function runCase(c: Case): Promise<{ ok: boolean; msg: string; elapsed: number }> {
  const { context, page, close } = await launchBrowser({
    headless: process.env.HEADLESS !== '0', // default headless for smoke
    persistent: false,
  });
  const started = Date.now();
  try {
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(300);
    const obs = await snapshotPage(page);
    const text = obs.text;
    const elapsed = Date.now() - started;

    const missing = c.must.filter((m) => !text.includes(m));
    const forbidden = (c.mustNot ?? []).filter((m) => text.includes(m));

    if (missing.length === 0 && forbidden.length === 0) {
      return {
        ok: true,
        msg:
          `text=${text.length}ch image=${obs.image_base64.length}b64`,
        elapsed,
      };
    }
    const bits: string[] = [];
    if (missing.length) bits.push(`missing: ${missing.join(' | ')}`);
    if (forbidden.length) bits.push(`forbidden present: ${forbidden.join(' | ')}`);
    // Print the first ~600 chars of the rendered tree so failures are diagnosable.
    return {
      ok: false,
      msg: bits.join('  ||  ') + '\n---tree head---\n' + text.slice(0, 800) + '\n---',
      elapsed,
    };
  } catch (e) {
    return {
      ok: false,
      msg: `exception: ${(e as Error).message}`,
      elapsed: Date.now() - started,
    };
  } finally {
    await close();
  }
}

async function main() {
  console.log(chalk.bold('observe() smoke'));
  let failed = 0;
  for (const c of CASES) {
    const r = await runCase(c);
    const tag = r.ok ? chalk.green('PASS') : chalk.red('FAIL');
    console.log(`  ${tag}  ${c.name}  (${r.elapsed}ms)  ${r.msg}`);
    if (!r.ok) failed++;
  }
  if (failed > 0) {
    console.log(chalk.red(`\n${failed}/${CASES.length} cases failed`));
    process.exit(1);
  }
  console.log(chalk.green(`\nall ${CASES.length} cases passed`));
}

main().catch((e) => {
  console.error('observe-smoke crash:', e);
  process.exit(1);
});
