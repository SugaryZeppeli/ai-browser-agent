/**
 * Login helper.
 *
 * The agent runs against a persistent Chromium profile stored in
 * `./user-data/`. Any session the user logs into manually in that
 * profile will be reused automatically by the agent on subsequent runs.
 *
 * This helper opens a visible Chromium window bound to the persistent
 * profile. It is intentionally SITE-AGNOSTIC — there are no hardcoded
 * target URLs anywhere in the code. If you pass URLs as CLI args they
 * will be opened in tabs for you; otherwise a single about:blank tab
 * opens and you navigate manually.
 *
 * Run:
 *   npm run login
 *   npm run login -- https://site-a.example https://site-b.example
 */

import readline from 'node:readline/promises';
import chalk from 'chalk';
import { launchBrowser } from './browser.js';

async function main() {
  const urls = process.argv.slice(2).filter((a) => /^https?:\/\//i.test(a));

  console.log(chalk.bold.cyan('\n════════════════  LOGIN HELPER  ════════════════\n'));
  console.log(
    'This opens a Chromium window bound to ' +
      chalk.bold('./user-data/') +
      ' (the agent profile).',
  );
  console.log(
    'Whatever you log into manually in this window will be reused by',
  );
  console.log('the agent on subsequent runs (cookies, localStorage, etc).\n');

  if (urls.length > 0) {
    console.log(chalk.bold('Opening ' + urls.length + ' URL(s) you passed:'));
    for (const u of urls) console.log('  ' + chalk.dim(u));
  } else {
    console.log(
      chalk.dim('No URLs supplied — a blank tab will open. Type URLs in the'),
    );
    console.log(
      chalk.dim('address bar manually to reach whichever sites you need.'),
    );
    console.log(
      chalk.dim(
        'Tip: pass URLs as CLI args to auto-open them: npm run login -- https://site-a https://site-b',
      ),
    );
  }
  console.log();

  const { page, context, close } = await launchBrowser({
    headless: false,
    persistent: true,
  });

  for (const u of urls) {
    const p = await context.newPage();
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(
      (e) =>
        console.error(
          chalk.red(`  ⚠ ${u} failed to load: ${(e as Error).message}`),
        ),
    );
  }

  if (urls.length > 0 && (page.url() === 'about:blank' || page.url() === '')) {
    await page.close().catch(() => {});
  }

  console.log(
    chalk.bold.green('\n✓ Browser open.') +
      ' Log into whatever you need, solve captchas,',
  );
  console.log('  then return here and press Enter.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question(chalk.cyan('▶ Press Enter when finished logging in… '));
  rl.close();

  console.log(chalk.dim('\nSaving profile and closing browser…'));
  await close();
  console.log(chalk.bold.green('\n✅ Profile saved to ./user-data/'));
  console.log(
    chalk.dim('\nNow run a task against the logged-in profile with:'),
  );
  console.log(chalk.bold('   PERSISTENT=1 npm run dev\n'));
}

main().catch((e) => {
  console.error(chalk.red('crash:'), e);
  process.exit(1);
});
