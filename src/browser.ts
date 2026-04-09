import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { FALLBACK_VIEWPORT } from './config.js';

export interface BrowserOptions {
  /** Show the browser window. Default: true (headful — agent demos need this). */
  headless?: boolean;
  /** Use a persistent on-disk user-data dir so logged-in sessions survive restarts. */
  persistent?: boolean;
  /** Override the user-data dir path. */
  userDataDir?: string;
  /** If set, video of the run is saved to this directory. */
  recordVideoDir?: string;
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Fallback size used ONLY for video recording and headless runs, where
 * there is no real window to follow. In a headful session the browser
 * starts maximized and the page viewport tracks the actual OS window
 * size (see `viewport: null` below), so the agent uses the full screen.
 */
const RECORD_SIZE = FALLBACK_VIEWPORT;

/**
 * Reduce the chance that sites detect us as an automated browser. Not
 * foolproof — some strong bot-detectors will still flag headless
 * Chromium. For those, set BROWSER_CHANNEL=chrome to use the real
 * installed Chrome, which is much harder to fingerprint.
 *
 * `--start-maximized` + `viewport: null` is the only combination that
 * makes Playwright Chromium behave like a real Chrome window: the OS
 * maximizes it on launch, and the page's rendered viewport follows the
 * actual window (including resizes), instead of being pinned to a
 * hardcoded box with gray margins on the sides.
 */
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--start-maximized',
];

/**
 * Launch Chromium for the agent.
 *
 * Two modes:
 *  - persistent: reuse ./user-data/ so the agent inherits whatever the
 *    user has manually logged into (cookies, localStorage, …)
 *  - ephemeral:  unit/manual tests where we don't want to touch user data
 */
export async function launchBrowser(opts: BrowserOptions = {}): Promise<BrowserHandle> {
  const headless = opts.headless ?? false;
  const recordVideo = opts.recordVideoDir
    ? { dir: opts.recordVideoDir, size: RECORD_SIZE }
    : undefined;
  const channel = process.env.BROWSER_CHANNEL || undefined;

  // Headful runs: viewport=null → the page size tracks the real OS
  // window, so --start-maximized actually gives us the full screen and
  // the user can resize freely. Headless runs: use RECORD_SIZE so
  // there's a deterministic box (headless has no real window).
  const viewport = headless ? RECORD_SIZE : null;

  if (opts.persistent) {
    const userDataDir = opts.userDataDir ?? path.resolve('user-data');
    fs.mkdirSync(userDataDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel,
      headless,
      viewport,
      recordVideo,
      args: STEALTH_ARGS,
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, close: () => context.close() };
  }

  const browser = await chromium.launch({
    channel,
    headless,
    args: STEALTH_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const context = await browser.newContext({ viewport, recordVideo });
  const page = await context.newPage();
  return { context, page, close: () => browser.close() };
}
