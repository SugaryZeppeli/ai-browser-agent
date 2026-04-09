import type { Locator, Page } from 'playwright';

/**
 * Browser tool handlers — v3.
 *
 * Upgrades over v2:
 *   - Selectors now use a RICH DSL (role=/text=/placeholder=/label=/testid=/css=),
 *     resolved via tools/selector.ts → resolveLocator(). Falls back to
 *     bare CSS for backward compatibility.
 *   - click_element and type_text accept an optional `intent` arg — a short
 *     description of what the agent is trying to do. If the click/type
 *     fails because the selector became stale, we make ONE transparent
 *     query_dom(intent) call and retry.
 *   - Captcha/bot-check URL patterns are auto-detected; the tool returns
 *     a message instructing the agent to ask_user instead of silently
 *     hanging on a human-only challenge.
 *   - All handlers resolve ctx.getPage() on every invocation, so the
 *     agent survives the user opening/closing tabs in the visible window.
 */

import type { ToolContext, ToolResult } from './types.js';
import {
  describeLocator,
  parseLocator,
  resolveLocator,
} from './selector.js';
import {
  SETTLE_TIMEOUT,
  SETTLE_BUFFER_MS,
  SETTLE_BUFFER_FAST_MS,
  NAVIGATE_TIMEOUT,
  JS_FALLBACK_TIMEOUT,
  LEGACY_ACTION_TIMEOUT,
  SCREENSHOT_SETTLE_MS,
  SCROLL_SETTLE_MS,
  TRUNC_DEFAULT,
  MIN_BECAUSE_LEN,
  looksLikeCaptcha,
} from '../config.js';

/* ─────────────── helpers ─────────────── */

export const TRUNC = (s: string, n = TRUNC_DEFAULT) =>
  s.length > n ? s.slice(0, n) + '…' : s;

/**
 * Short, fast settle. We DO NOT wait for `networkidle` — modern SPAs
 * keep long-lived connections open (metrics, websockets, long-poll)
 * and `networkidle` would always time out, wasting 3+ seconds per
 * action. `domcontentloaded` is usually already true after goto/click
 * because Playwright's actionability checks wait for the DOM. A 200ms
 * buffer covers post-render hydration.
 */
export async function settle(page: Page, bufferMs = SETTLE_BUFFER_MS) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT });
  } catch {
    /* best-effort */
  }
  await page.waitForTimeout(bufferMs);
}

/** Fast settle for click/type — shorter buffer since SPA re-renders are <16ms. */
export async function settleFast(page: Page) {
  return settle(page, SETTLE_BUFFER_FAST_MS);
}



export async function describeElement(
  page: Page,
  loc: Locator,
): Promise<{ name: string; tag: string; type?: string } | null> {
  try {
    return await loc.first().evaluate((el) => {
      const anyEl = el as HTMLElement & {
        placeholder?: string;
        value?: string;
        type?: string;
        name?: string;
      };
      const aria = anyEl.getAttribute?.('aria-label');
      const title = anyEl.getAttribute?.('title');
      const txt = (anyEl.innerText || anyEl.textContent || '').trim();
      const placeholder = anyEl.placeholder;
      const name =
        (aria && aria.trim()) ||
        (txt && txt.slice(0, 160)) ||
        (title && title.trim()) ||
        (placeholder && placeholder.trim()) ||
        '';
      return {
        name,
        tag: anyEl.tagName?.toLowerCase() ?? '',
        type: anyEl.type,
      };
    }, undefined, { timeout: JS_FALLBACK_TIMEOUT });
  } catch {
    return null;
  }
}

/**
 * Extract a fresh selector from the DOM sub-agent's reply. Looks for
 * `selector:`, `locator:` or just the first line that parses as a DSL
 * expression.
 */
export function extractLocatorFromSubagent(reply: string): string | null {
  const lines = reply.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(?:selector|locator)\s*:\s*(.+)$/i);
    if (m) return m[1]!.trim().replace(/^`|`$/g, '').replace(/[;,]$/, '');
  }
  // First line that parses as something non-trivial
  for (const line of lines) {
    const p = parseLocator(line);
    if (p.kind !== 'css' || /[#.\[]/.test(line)) return line;
  }
  return null;
}

/* ─────────────── tool: navigate_to_url ─────────────── */

/**
 * Recognise errors that mean "this page object is dead, open a new one":
 *
 *  - "No frame with given id found"       — page has an orphaned frame tree
 *  - "Target closed" / "has been closed"  — underlying CDP target gone
 *  - "Execution context was destroyed"    — navigation happened mid-eval
 *  - "Protocol error (Page.navigate)"     — connection to the page is dead
 *
 * These typically happen after a long-lived persistent tab survives across
 * multiple runs and picks up a zombie state. The fix is to drop the current
 * page and open a fresh one from the same context.
 */
const STALE_PAGE_PATTERNS = [
  /no frame with given id/i,
  /target.*closed/i,
  /has been closed/i,
  /execution context was destroyed/i,
  /Protocol error \(Page\.navigate\)/i,
  /frame was detached/i,
];
function isStalePage(msg: string): boolean {
  return STALE_PAGE_PATTERNS.some((re) => re.test(msg));
}

async function doNavigate(page: Page, url: string): Promise<ToolResult> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT });
  await settle(page);
  const title = await page.title().catch(() => '');
  const finalUrl = page.url();
  if (looksLikeCaptcha(finalUrl)) {
    return {
      ok: false,
      text: `CAPTCHA/BOT-CHECK detected at ${finalUrl}. You CANNOT solve this yourself. Call ask_user to ask the human to solve the challenge in the visible browser window, then re-navigate or re-query the page.`,
    };
  }
  return {
    ok: true,
    text: `OK navigated to ${finalUrl} — title: "${TRUNC(title, 120)}"`,
  };
}

export async function navigate_to_url(
  ctx: ToolContext,
  args: { url: string },
): Promise<ToolResult> {
  if (!args?.url) return { ok: false, text: 'ERROR: url is required' };
  try {
    const page = await ctx.getPage();
    return await doNavigate(page, args.url);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Zombie page — open a fresh tab in the same context and try once more.
    if (isStalePage(msg)) {
      try {
        const fresh = await ctx.context.newPage();
        return await doNavigate(fresh, args.url);
      } catch (e2: unknown) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        return {
          ok: false,
          text: `ERROR navigate (fresh page also failed): ${msg2}`,
        };
      }
    }
    return { ok: false, text: `ERROR navigate: ${msg}` };
  }
}

/* ─────────────── tool: take_screenshot ─────────────── */

export async function take_screenshot(
  ctx: ToolContext,
  args: { full_page?: boolean },
): Promise<ToolResult> {
  try {
    const page = await ctx.getPage();
    // JPEG is 5-10× smaller than PNG for UI screenshots and vision
    // models read it perfectly. q=70 keeps button text legible.
    const buf = await page.screenshot({
      fullPage: args?.full_page === true,
      type: 'jpeg',
      quality: 70,
    });
    const b64 = buf.toString('base64');
    const title = await page.title().catch(() => '');
    const url = page.url();
    if (looksLikeCaptcha(url)) {
      return {
        ok: true,
        text: `CAPTCHA screen detected at ${url}. Ask the user to solve it in the visible browser.`,
        image_base64: b64,
      };
    }
    return {
      ok: true,
      text: `OK screenshot of ${url} (title="${TRUNC(title, 80)}")`,
      image_base64: b64,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR screenshot: ${msg}` };
  }
}

/* ─────────────── tool: scroll_page ─────────────── */

/**
 * Generic page scroll. Essential for virtualized lists (inbox rows,
 * chat threads, infinite feeds, search results) where most items do
 * not exist in the DOM until they become close to the viewport.
 *
 * Three-strategy cascade, because modern SPAs often have a custom
 * scroll container instead of scrolling the document root:
 *
 *   1. mouse.wheel at the viewport centre — dispatches a real wheel
 *      event that the application handles exactly like a user
 *      scrolling. This works on 95% of SPAs because the framework's
 *      scroll listener does not care which element is scrolling; it
 *      just handles the wheel.
 *   2. If the wheel didn't move any scrollable position, find the
 *      tallest inner element with overflow:auto/scroll and
 *      scrollTop > 0 OR scrollHeight > clientHeight, and call
 *      scrollBy/scrollTo on it directly. Catches sites where the
 *      wheel event is swallowed but an inner container is the true
 *      scroll target.
 *   3. If still nothing moves, return a clear "no effect" message so
 *      the agent knows scrolling isn't working and can try a
 *      different approach (e.g. using page search, typing in a
 *      filter, clicking a "load more" button).
 *
 * For direction "top"/"bottom" we use keyboard Home/End first (works
 * on focusable scrollable containers) before falling back to the
 * same strategies.
 */
export async function scroll_page(
  ctx: ToolContext,
  args: {
    direction?: 'down' | 'up' | 'top' | 'bottom';
    amount?: number;
  },
): Promise<ToolResult> {
  try {
    const page = await ctx.getPage();
    const direction = args?.direction ?? 'down';
    const amount = Math.max(1, Math.min(args?.amount ?? 1, 10));

    // ── Baseline: measure scroll position of root AND every inner
    // scrollable container, so we can detect whether ANYTHING moved.
    const measure = async () =>
      page.evaluate(() => {
        const root = (document.scrollingElement || document.documentElement) as HTMLElement;
        let bestInnerY = 0;
        let bestInnerMax = 0;
        // Targeted query for scrollable containers instead of querySelectorAll('*').
        // Elements with overflow:auto/scroll are almost always styled via class/style.
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(
          '[style*="overflow"], [class]',
        ));
        const cap = 300;
        let scanned = 0;
        for (const node of candidates) {
          if (++scanned > cap) break;
          if (!(node instanceof HTMLElement)) continue;
          if (node === root || node === document.body || node === document.documentElement) continue;
          // Quick check: skip if not scrollable at all
          if (node.scrollHeight <= node.clientHeight + 50) continue;
          const oy = getComputedStyle(node).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') continue;
          const maxS = node.scrollHeight - node.clientHeight;
          if (node.scrollTop > bestInnerY) bestInnerY = node.scrollTop;
          if (maxS > bestInnerMax) bestInnerMax = maxS;
        }
        return {
          rootY: root.scrollTop,
          rootMax: Math.max(0, root.scrollHeight - window.innerHeight),
          innerY: bestInnerY,
          innerMax: bestInnerMax,
          vh: window.innerHeight,
        };
      });

    const before = await measure();

    // ── Strategy 1: mouse wheel at viewport centre (down/up only). ──
    if (direction === 'down' || direction === 'up') {
      const vp = page.viewportSize();
      const w = vp?.width ?? 1280;
      const h = vp?.height ?? 800;
      const deltaY = (direction === 'down' ? 1 : -1) * (before.vh || h) * amount;
      try {
        await page.mouse.move(Math.floor(w / 2), Math.floor(h / 2));
        await page.mouse.wheel(0, deltaY);
        await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
      } catch {
        /* mouse.wheel failures are non-fatal; fall through to fallback */
      }
    } else {
      // Strategy 1 for top/bottom: keyboard Home/End on the body.
      try {
        await page.keyboard.press(direction === 'top' ? 'Home' : 'End');
        await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
      } catch {
        /* keyboard failures are non-fatal; fall through to fallback */
      }
    }

    let after = await measure();
    const positionChanged =
      Math.abs(after.rootY - before.rootY) >= 5 ||
      Math.abs(after.innerY - before.innerY) >= 5;

    // ── Strategy 2: direct programmatic scroll on the tallest inner
    //    overflow:auto container. Fires only if strategy 1 did nothing.
    let fallbackNote = '';
    if (!positionChanged) {
      const fallback = await page.evaluate(
        ({ direction, amount }) => {
          const root = (document.scrollingElement || document.documentElement) as HTMLElement;
          let best: HTMLElement | null = null;
          let bestH = 0;
          const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
          for (let i = 0; i < all.length; i++) {
            const node = all[i]!;
            if (!(node instanceof HTMLElement)) continue;
            if (node === root || node === document.body) continue;
            const cs = getComputedStyle(node);
            const oy = cs.overflowY;
            if (oy !== 'auto' && oy !== 'scroll') continue;
            const maxS = node.scrollHeight - node.clientHeight;
            if (maxS < 50) continue;
            if (node.scrollHeight > bestH) {
              best = node;
              bestH = node.scrollHeight;
            }
          }
          if (!best) {
            // Fall back to scrolling the document root itself
            // (sometimes works when window.scroll did not).
            const vh = window.innerHeight;
            const b = root.scrollTop;
            if (direction === 'top') root.scrollTo({ top: 0 });
            else if (direction === 'bottom') root.scrollTo({ top: root.scrollHeight });
            else if (direction === 'up') root.scrollBy({ top: -vh * amount });
            else root.scrollBy({ top: vh * amount });
            return {
              applied: root.scrollTop !== b,
              container: 'document-root',
              before: b,
              after: root.scrollTop,
            };
          }
          const vh = best.clientHeight || window.innerHeight;
          const b = best.scrollTop;
          if (direction === 'top') best.scrollTo({ top: 0 });
          else if (direction === 'bottom') best.scrollTo({ top: best.scrollHeight });
          else if (direction === 'up') best.scrollBy({ top: -vh * amount });
          else best.scrollBy({ top: vh * amount });
          const tag = best.tagName.toLowerCase();
          const id = best.id ? `#${best.id}` : '';
          const cls = best.className
            ? `.${String(best.className).split(/\s+/)[0]}`
            : '';
          return {
            applied: best.scrollTop !== b,
            container: `${tag}${id}${cls}`,
            before: b,
            after: best.scrollTop,
          };
        },
        { direction, amount },
      );
      if (fallback.applied) {
        fallbackNote = ` (via inner container <${fallback.container}> ${fallback.before}→${fallback.after})`;
      }
      await page.waitForTimeout(SCROLL_SETTLE_MS);
      after = await measure();
    }

    const finalChanged =
      Math.abs(after.rootY - before.rootY) >= 5 ||
      Math.abs(after.innerY - before.innerY) >= 5;

    if (!finalChanged) {
      // Nothing we tried worked. Report clearly so the agent doesn't
      // keep scrolling in a loop.
      const atEdge =
        direction === 'down' || direction === 'bottom'
          ? after.rootY >= after.rootMax - 1 && after.innerY >= after.innerMax - 1
          : after.rootY <= 1 && after.innerY <= 1;
      return {
        ok: true,
        text: atEdge
          ? `scroll_page(${direction}) — already at the ${direction === 'down' || direction === 'bottom' ? 'bottom' : 'top'} of every scrollable container. Scrolling further has no effect.`
          : `scroll_page(${direction}) — NO EFFECT detected. Neither the document nor any inner scrollable container moved. This page may use a non-standard scroll mechanism (e.g. keyboard-only lists, intersection-observer triggers, or a "load more" button). Try a different approach: use the page's own search / filter UI, click a visible "next page" / "load more" control, or use take_screenshot + query_dom to find a scroll-triggering element.`,
      };
    }

    // Describe where we ended up (prefer whichever container moved more).
    const useInner = Math.abs(after.innerY - before.innerY) >= Math.abs(after.rootY - before.rootY);
    const y = useInner ? after.innerY : after.rootY;
    const maxY = useInner ? after.innerMax : after.rootMax;
    const at =
      y <= 1 ? 'top' : y >= maxY - 1 ? 'bottom' : `y=${Math.round(y)} of ${Math.round(maxY)}`;
    return {
      ok: true,
      text: `OK scrolled ${direction}${amount > 1 ? ` x${amount}` : ''} — now at ${at}${fallbackNote}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR scroll_page: ${msg}` };
  }
}

/* ─────────────── tool: wait ─────────────── */

export async function wait(
  ctx: ToolContext,
  args: { seconds?: number },
): Promise<ToolResult> {
  const secs = Math.max(0, Math.min(args?.seconds ?? 1, 15));
  const page = await ctx.getPage();
  await page.waitForTimeout(secs * 1000);
  return { ok: true, text: `OK waited ${secs}s` };
}

/* ─────────────── tool: press_key ─────────────── */

/**
 * Press a keyboard key or combination on the active page.
 * Useful for shortcuts (Ctrl+A, Delete, Escape, Enter, Tab, etc.)
 * and interacting with controls that lack accessible names.
 */
export async function press_key(
  ctx: ToolContext,
  args: { key: string; because?: string },
): Promise<ToolResult> {
  const key = (args?.key ?? '').trim();
  if (!key) return { ok: false, text: 'ERROR: key is required' };
  const because = (args?.because ?? '').trim();
  if (because.length < MIN_BECAUSE_LEN) {
    return {
      ok: false,
      text: `ERROR press_key: missing or too-short \`because\` (≥10 chars). Explain why you are pressing this key.`,
    };
  }
  try {
    const page = await ctx.getPage();
    await page.keyboard.press(key);
    await settle(page);
    return { ok: true, text: `OK pressed "${key}" — now at ${page.url()}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR press_key "${key}": ${msg}` };
  }
}

/* ─────────────── tool: click_element ─────────────── */

/**
 * Click an element. Selector uses the rich DSL — see tools/selector.ts.
 *
 * Optional `intent` is a 2-6 word natural-language hint ("corner cart icon",
 * "'Добавить в корзину' button on first tile") describing what the agent
 * is trying to click. If provided and the initial attempt fails, we make
 * ONE transparent query_dom(intent) call to re-fetch a fresh selector
 * and retry exactly once. This implements the "structured selector
 * recovery" part of the error-handling advanced pattern.
 */
export async function click_element(
  ctx: ToolContext,
  args: { selector: string; intent?: string },
): Promise<ToolResult> {
  if (!args?.selector) {
    return { ok: false, text: 'ERROR: selector is required' };
  }
  return await tryClick(ctx, args.selector, args.intent, /*autoRetry*/ true);
}

async function tryClick(
  ctx: ToolContext,
  selectorExpr: string,
  intent: string | undefined,
  autoRetry: boolean,
): Promise<ToolResult> {
  const page = await ctx.getPage();

  let locator: Locator;
  try {
    locator = resolveLocator(page, selectorExpr);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `ERROR invalid locator "${TRUNC(selectorExpr)}": ${msg}. Call query_dom again.`,
    };
  }

  let count: number;
  try {
    count = await locator.count();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `ERROR locator "${TRUNC(selectorExpr)}": ${msg}. Call query_dom again.`,
    };
  }

  if (count === 0) {
    if (autoRetry && intent && ctx.queryDom) {
      return await recoverAndRetryClick(ctx, selectorExpr, intent);
    }
    return {
      ok: false,
      text: `ERROR element not found for ${describeLocator(selectorExpr)}. Call query_dom again — the DOM may have changed.`,
    };
  }

  // ── Safety layer hook ──
  if (ctx.safety) {
    const info = await describeElement(page, locator);
    const verdict = ctx.safety.checkClick({
      selector: selectorExpr,
      name: info?.name ?? '',
      tag: info?.tag ?? '',
      type: info?.type,
    });
    if (verdict.blocked) {
      return {
        ok: false,
        text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action with an intent describing what you are about to do; after the user approves you may retry click_element.`,
      };
    }
  }

  try {
    await locator.first().click({ timeout: LEGACY_ACTION_TIMEOUT });
    await settle(page);
    return {
      ok: true,
      text: `OK clicked ${describeLocator(selectorExpr)} — now at ${page.url()}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (autoRetry && intent && ctx.queryDom) {
      return await recoverAndRetryClick(ctx, selectorExpr, intent, msg);
    }
    return {
      ok: false,
      text: `ERROR click ${describeLocator(selectorExpr)}: ${msg}. Try query_dom again.`,
    };
  }
}

async function recoverAndRetryClick(
  ctx: ToolContext,
  oldSelector: string,
  intent: string,
  prevError?: string,
): Promise<ToolResult> {
  if (!ctx.queryDom) {
    return {
      ok: false,
      text: `ERROR element not found and no sub-agent available to recover. Intent was: ${intent}`,
    };
  }
  const query = `The previous selector "${oldSelector}" failed${prevError ? ` (${prevError})` : ''}. Find a FRESH locator for the following intent (prefer role/text/placeholder over raw CSS): ${intent}`;
  try {
    const reply = await ctx.queryDom(query);
    const fresh = extractLocatorFromSubagent(reply);
    if (!fresh) {
      return {
        ok: false,
        text: `ERROR auto-recovery: DOM sub-agent did not return a selector. Reply: ${TRUNC(reply, 200)}`,
      };
    }
    const second = await tryClick(ctx, fresh, intent, /*autoRetry*/ false);
    if (second.ok) {
      return {
        ok: true,
        text: `OK (after auto-recovery: ${describeLocator(fresh)}) ${second.text}`,
      };
    }
    return {
      ok: false,
      text: `ERROR recovered selector "${fresh}" also failed: ${second.text}. Call query_dom with a different query.`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `ERROR during auto-recovery: ${msg}.`,
    };
  }
}

/* ─────────────── tool: type_text ─────────────── */

export async function type_text(
  ctx: ToolContext,
  args: { selector: string; text: string; submit?: boolean; intent?: string },
): Promise<ToolResult> {
  if (!args?.selector) return { ok: false, text: 'ERROR: selector is required' };
  if (args.text === undefined || args.text === null) {
    return { ok: false, text: 'ERROR: text is required' };
  }
  return await tryType(
    ctx,
    args.selector,
    args.text,
    args.submit === true,
    args.intent,
    /*autoRetry*/ true,
  );
}

async function tryType(
  ctx: ToolContext,
  selectorExpr: string,
  text: string,
  submit: boolean,
  intent: string | undefined,
  autoRetry: boolean,
): Promise<ToolResult> {
  const page = await ctx.getPage();

  let locator: Locator;
  try {
    locator = resolveLocator(page, selectorExpr);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `ERROR invalid locator "${TRUNC(selectorExpr)}": ${msg}.`,
    };
  }

  let count: number;
  try {
    count = await locator.count();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `ERROR locator "${TRUNC(selectorExpr)}": ${msg}.`,
    };
  }
  if (count === 0) {
    if (autoRetry && intent && ctx.queryDom) {
      return await recoverAndRetryType(
        ctx,
        selectorExpr,
        text,
        submit,
        intent,
      );
    }
    return {
      ok: false,
      text: `ERROR element not found for ${describeLocator(selectorExpr)}. Call query_dom again.`,
    };
  }

  // ── Safety layer hook ──
  if (ctx.safety) {
    const info = await describeElement(page, locator);
    const verdict = ctx.safety.checkType({
      selector: selectorExpr,
      name: info?.name ?? '',
      tag: info?.tag ?? '',
      type: info?.type,
      text,
    });
    if (verdict.blocked) {
      return {
        ok: false,
        text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action first, then retry.`,
      };
    }
  }

  try {
    const loc = locator.first();
    await loc.fill(text, { timeout: LEGACY_ACTION_TIMEOUT });
    if (submit) await loc.press('Enter', { timeout: LEGACY_ACTION_TIMEOUT });
    await settle(page);
    return {
      ok: true,
      text: `OK typed ${text.length} chars into ${describeLocator(selectorExpr)}${submit ? ' + Enter' : ''}`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (autoRetry && intent && ctx.queryDom) {
      return await recoverAndRetryType(
        ctx,
        selectorExpr,
        text,
        submit,
        intent,
        msg,
      );
    }
    return {
      ok: false,
      text: `ERROR type ${describeLocator(selectorExpr)}: ${msg}.`,
    };
  }
}

async function recoverAndRetryType(
  ctx: ToolContext,
  oldSelector: string,
  text: string,
  submit: boolean,
  intent: string,
  prevError?: string,
): Promise<ToolResult> {
  if (!ctx.queryDom) {
    return {
      ok: false,
      text: `ERROR element not found and no sub-agent available. Intent: ${intent}`,
    };
  }
  const query = `The previous selector "${oldSelector}" failed${prevError ? ` (${prevError})` : ''}. Find a FRESH locator for an input/textarea matching this intent (prefer role=searchbox/placeholder="..." over raw CSS): ${intent}`;
  try {
    const reply = await ctx.queryDom(query);
    const fresh = extractLocatorFromSubagent(reply);
    if (!fresh) {
      return {
        ok: false,
        text: `ERROR auto-recovery: sub-agent returned no usable selector. Reply: ${TRUNC(reply, 200)}`,
      };
    }
    const second = await tryType(
      ctx,
      fresh,
      text,
      submit,
      intent,
      /*autoRetry*/ false,
    );
    if (second.ok) {
      return {
        ok: true,
        text: `OK (after auto-recovery: ${describeLocator(fresh)}) ${second.text}`,
      };
    }
    return {
      ok: false,
      text: `ERROR recovered selector "${fresh}" also failed: ${second.text}.`,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR during auto-recovery: ${msg}.` };
  }
}

/* ─────────────── control tools: ask_user, finish, confirm_action ─────────────── */

export async function ask_user(
  _ctx: ToolContext,
  args: { question: string },
): Promise<ToolResult> {
  return {
    ok: true,
    text: 'asking user',
    control: 'ask_user',
    question: args?.question ?? '',
  };
}

export async function finish(
  _ctx: ToolContext,
  args: { summary: string; success: boolean },
): Promise<ToolResult> {
  return {
    ok: true,
    text: `finished success=${args?.success}`,
    control: 'finish',
    summary: args?.summary ?? '',
    success: args?.success ?? false,
  };
}

export async function confirm_action(
  _ctx: ToolContext,
  args: { intent: string; target?: string },
): Promise<ToolResult> {
  return {
    ok: true,
    text: 'requesting confirmation',
    control: 'confirm_action',
    intent: args?.intent ?? '',
    target: args?.target ?? '',
  };
}

/**
 * Non-blocking narrative channel to the user. Use when you have
 * intermediate findings, a proposal, a progress update, or a classification
 * result you want the user to see without ending the run and without
 * demanding an answer. The loop delivers the message to the REPL and
 * then CONTINUES — the agent keeps working toward the goal. This is the
 * difference from ask_user (blocking question) and finish (terminal).
 */
export async function respond(
  _ctx: ToolContext,
  args: { text: string },
): Promise<ToolResult> {
  return {
    ok: true,
    text: 'responded',
    control: 'respond',
    message: args?.text ?? '',
  };
}

/**
 * Plan-Act-Verify: planning step. The agent commits to a plan before
 * acting. Stored in loop state; the loop uses it as a gatekeeper before
 * allowing finish(success=true). The plan is entirely written by the
 * agent in its own words — no templates, no categories.
 */
export async function create_plan(
  _ctx: ToolContext,
  args: {
    success_condition: string;
    subgoals: string[];
    verification_strategy: string;
    risks?: string[];
  },
): Promise<ToolResult> {
  const plan = {
    success_condition: (args?.success_condition ?? '').trim(),
    subgoals: Array.isArray(args?.subgoals) ? args.subgoals.filter(Boolean) : [],
    verification_strategy: (args?.verification_strategy ?? '').trim(),
    risks: Array.isArray(args?.risks) ? args.risks.filter(Boolean) : undefined,
  };
  if (!plan.success_condition) {
    return { ok: false, text: 'ERROR: success_condition is required' };
  }
  if (plan.subgoals.length === 0) {
    return {
      ok: false,
      text: 'ERROR: subgoals must be a non-empty list of short natural-language steps',
    };
  }
  return {
    ok: true,
    text: 'plan accepted',
    control: 'create_plan',
    plan,
  };
}

/**
 * Plan-Act-Verify: verification step. Agent reports that it believes a
 * sub-goal (or the whole goal) is reached, provides observed evidence,
 * and self-assesses. Loop captures the most recent verdict and uses it
 * to gate finish(success=true): the agent may not claim overall success
 * unless its last verify call had verdict="pass" AFTER its last
 * mutating action.
 */
export async function verify(
  _ctx: ToolContext,
  args: {
    target: string;
    evidence: string;
    verdict: 'pass' | 'fail' | 'partial';
    notes?: string;
  },
): Promise<ToolResult> {
  const target = (args?.target ?? '').trim() || 'goal';
  const evidence = (args?.evidence ?? '').trim();
  const verdict = args?.verdict ?? 'fail';
  const notes = (args?.notes ?? '').trim() || undefined;
  if (!['pass', 'fail', 'partial'].includes(verdict)) {
    return {
      ok: false,
      text: `ERROR: verdict must be one of pass | fail | partial (got "${verdict}")`,
    };
  }
  if (!evidence) {
    return {
      ok: false,
      text: 'ERROR: evidence is required — describe what you observed on the page that proves (or disproves) the target',
    };
  }
  return {
    ok: true,
    text: `verify ${verdict}: ${target}`,
    control: 'verify',
    verification: { target, evidence, verdict, notes },
  };
}
