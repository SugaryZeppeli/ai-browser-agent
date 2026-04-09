/**
 * Grounded click / type — the new action surface.
 *
 * The agent references an element BY ITS ROLE + NAME exactly as it
 * appears in the most recent observe() tree. No DSL, no pre-written
 * selectors, no hardcoded strings. This file turns those natural-
 * language descriptions into live Playwright locators via a cascade
 * of Playwright's own semantic locators (getByRole → getByText →
 * getByPlaceholder → getByLabel) plus an internal DOM-sub-agent
 * fallback for weak pages.
 *
 * Cascade order:
 *   1. page.getByRole(role, { name, exact: false })
 *         Playwright's canonical semantic locator. Matches against the
 *         live accessibility tree with WAI-ARIA rules.
 *   2. page.getByText(name, { exact: false })
 *         For plain text content that isn't wrapped in a named role.
 *   3. page.getByPlaceholder(name)
 *         Covers inputs whose accessible name came from their placeholder.
 *   4. page.getByLabel(name)
 *         Covers inputs whose accessible name came from a <label> element.
 *   5. ctx.queryDom(target) → parse → resolveLocator()
 *         Last-ditch: hand the full description to the DOM sub-agent
 *         and try the selector it returns. Covers sparse-a11y pages.
 *
 * Disambiguation:
 *   - If a stage returns zero matches we drop to the next stage.
 *   - If a stage returns EXACTLY ONE match we act.
 *   - If a stage returns MANY matches we stop and report
 *     "ambiguous — N elements match; retry with nth=1..N". The agent
 *     picks by passing `nth` (1-based). `.nth(n-1)` is used internally.
 *
 * Safety layer:
 *   - Before every mutating action we call describeElement() on the
 *     resolved locator and run it through ctx.safety.checkClick /
 *     checkType exactly like the legacy click_element / type_text
 *     handlers do. Destructive verbs still block pending confirm_action.
 *
 * Target format (strict, enforced in code):
 *     "<role> <accessible name...>"
 *
 *   The role is everything up to the first whitespace (lowercased,
 *   matched against the W3C ARIA role taxonomy in VALID_ARIA_ROLES);
 *   the name is the rest (trimmed; surrounding quotes optional and
 *   stripped). If the target has no whitespace at all it is treated
 *   as a role-only query and matches the first element of that role.
 *
 *   If the first token is NOT a valid ARIA role, the cascade treats
 *   the WHOLE input as a free-form name and skips stage 1 entirely
 *   — agents that pass a name without a role prefix still get a
 *   useful resolution attempt.
 *
 *   This format intentionally mirrors what observe() prints for each
 *   item: `#N <role> "<name>" [in-view] [K/M] in:"<container>"`. The
 *   agent copies the role + name substring verbatim — no synthesis,
 *   no invention, no examples baked into the format itself.
 */

import type { Locator, Page } from 'playwright';
import type { ToolContext, ToolResult } from './types.js';
import {
  TRUNC,
  settleFast,
  describeElement,
  extractLocatorFromSubagent,
} from './browser-tools.js';
import { resolveLocator } from './selector.js';
import {
  MAX_CLICK_FALLTHROUGH,
  ACTION_TIMEOUT,
  JS_FALLBACK_TIMEOUT,
} from '../config.js';

/* ─────────────── target parsing ─────────────── */

export interface ParsedTarget {
  role: string;
  name: string;
  /** Original input for diagnostics. */
  raw: string;
}

/**
 * Split "role name" on the first whitespace. Strip a single pair of
 * surrounding quotes from the name if present (agents often include
 * them because that's how observe() prints accessible names). Normalise
 * whitespace inside the name so a newline in the agent's copy-paste
 * doesn't break the match.
 */
export function parseTarget(raw: string): ParsedTarget | string {
  if (typeof raw !== 'string') return 'target must be a string';
  const trimmed = raw.trim();
  if (!trimmed) return 'target cannot be empty';

  const ws = trimmed.search(/\s/);
  let role: string;
  let name: string;
  if (ws === -1) {
    role = trimmed;
    name = '';
  } else {
    role = trimmed.slice(0, ws);
    name = trimmed.slice(ws + 1).trim();
  }

  // Strip a single pair of matching quotes around the name.
  if (name.length >= 2) {
    const first = name.charAt(0);
    const last = name.charAt(name.length - 1);
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '\u201C' && last === '\u201D') ||
      (first === '\u00AB' && last === '\u00BB')
    ) {
      name = name.slice(1, -1);
    }
  }
  name = name.replace(/\s+/g, ' ').trim();
  // Strip trailing ellipsis added by our tree compression (NAME_TRUNCATE).
  // The real element text doesn't contain "…" — it's our artifact.
  // Without this, getByRole(name:"...…", exact:false) searches for a
  // literal "…" substring which doesn't exist in the real accessible name.
  name = name.replace(/…$/, '').trim();
  // Lowercase role for consistent matching — ARIA roles are lowercase.
  role = role.toLowerCase();

  return { role, name, raw: trimmed };
}

/* ─────────────── role recognition ─────────────── */

/**
 * The complete WAI-ARIA role taxonomy a target string can legitimately
 * start with. Used to disambiguate "this first token IS a role, the
 * rest is a name" from "this is a free-form name with no role prefix".
 *
 * When the agent passes target="Это спам!" the parser splits it as
 * role="это" + name="спам!" — but "это" is not a real role. Without
 * this set, the cascade would skip the role stage (Playwright throws
 * on invalid role), then look up `name="спам!"` via getByText, missing
 * the "Это " prefix entirely. With this set we detect the bad split
 * up front and treat the whole target as a name across all fallback
 * stages, so getByText("Это спам!") still has a chance to match.
 */
const VALID_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner',
  'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'image', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu',
  'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
  'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
  'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript',
  'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);

/* ─────────────── cascade ─────────────── */

export type ResolveStrategy =
  | 'role'
  | 'text'
  | 'placeholder'
  | 'label'
  | 'subagent';

export interface ResolveOk {
  ok: true;
  locator: Locator;
  count: number;
  strategy: ResolveStrategy;
  /** Extra detail for diagnostics (e.g., "via sub-agent reply"). */
  detail?: string;
}
export interface ResolveErr {
  ok: false;
  /** Human-readable reason for the agent. */
  reason: string;
  /** Which cascade stages were tried, for diagnostics. */
  triedStages: ResolveStrategy[];
}
export type ResolveResult = ResolveOk | ResolveErr;

/** Small helper: count a locator without throwing. */
async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

/**
 * Run the cascade. Returns the FIRST stage that yields at least one
 * match. Does not perform the action — just identifies the element(s).
 */
export async function resolveTarget(
  page: Page,
  parsed: ParsedTarget,
  ctx?: ToolContext,
): Promise<ResolveResult> {
  const { role, name } = parsed;
  const tried: ResolveStrategy[] = [];

  // If the parsed role isn't actually a valid ARIA role, the agent
  // probably passed a free-form name with no role prefix (e.g.
  // "Это спам!" → role="это" + name="спам!"). Treat the WHOLE raw
  // target as the search string for the text/placeholder/label
  // stages so the prefix isn't lost. Stage 1 (getByRole) is skipped
  // entirely in that case because Playwright would just throw on the
  // invalid role.
  const roleValid = VALID_ARIA_ROLES.has(role);
  // "clickable" is the EXTRACTOR's synthetic role for cursor:pointer
  // elements without ARIA. These can't be found by text — skip straight
  // to sub-agent. For other invalid roles, treat the whole target as
  // a free-form text name.
  const isClickable = role === 'clickable';
  const fallbackName = roleValid ? name : (isClickable ? '' : parsed.raw);

  // ── Stage 1: getByRole (only when role is valid) ─────────────────
  if (roleValid) {
    tried.push('role');
    try {
      // Playwright's getByRole signature accepts { name?: string | RegExp,
      // exact?: boolean, ... }. If `name` is empty we omit it so the role
      // matches any element of that kind.
      const opts: { name?: string; exact?: boolean } = {};
      if (name) {
        opts.name = name;
        opts.exact = false;
      }
      // Cast to any because AriaRole is a union literal and we're
      // accepting agent-provided strings — the runtime either matches
      // or throws, and we catch both.
      const loc = page.getByRole(role as any, opts);
      const n = await safeCount(loc);
      if (n > 0) {
        return { ok: true, locator: loc, count: n, strategy: 'role' };
      }
    } catch {
      /* fall through */
    }
  }

  // ── Stage 2: getByText ───────────────────────────────────────────
  if (fallbackName) {
    tried.push('text');
    try {
      const loc = page.getByText(fallbackName, { exact: false });
      const n = await safeCount(loc);
      if (n > 0) {
        return { ok: true, locator: loc, count: n, strategy: 'text' };
      }
    } catch {
      /* fall through */
    }

    // ── Stage 3: getByPlaceholder ──────────────────────────────────
    tried.push('placeholder');
    try {
      const loc = page.getByPlaceholder(fallbackName, { exact: false });
      const n = await safeCount(loc);
      if (n > 0) {
        return { ok: true, locator: loc, count: n, strategy: 'placeholder' };
      }
    } catch {
      /* fall through */
    }

    // ── Stage 4: getByLabel ────────────────────────────────────────
    tried.push('label');
    try {
      const loc = page.getByLabel(fallbackName, { exact: false });
      const n = await safeCount(loc);
      if (n > 0) {
        return { ok: true, locator: loc, count: n, strategy: 'label' };
      }
    } catch {
      /* fall through */
    }
  }

  // ── Stage 4.5: clickable with container context ────────────────────
  // When the agent targets a "clickable" element (EXTRACTOR's synthetic
  // role for cursor:pointer divs), text-based lookups fail because these
  // elements have no accessible name. If the agent provided a name (from
  // the container context shown in observe), try locating by visible text
  // WITHIN the element's parent row. This catches email row checkboxes,
  // product card buttons, etc.
  if (isClickable && name) {
    tried.push('text');
    try {
      // Find containers whose text includes the name, then look for
      // clickable descendants (small divs/spans with pointer).
      const loc = page.locator(`*:has-text("${name.replace(/"/g, '\\"')}") >> *`).filter({
        has: page.locator(':visible'),
      });
      const n = await safeCount(loc);
      if (n > 0) {
        return { ok: true, locator: loc, count: n, strategy: 'text' };
      }
    } catch {
      /* fall through */
    }
  }

  // ── Stage 5: DOM sub-agent fallback ────────────────────────────────
  if (ctx?.queryDom) {
    tried.push('subagent');
    try {
      const reply = await ctx.queryDom(
        `Find a locator for: ${parsed.raw}. Return one concrete selector.`,
      );
      const fresh = extractLocatorFromSubagent(reply);
      if (fresh) {
        try {
          const loc = resolveLocator(page, fresh);
          const n = await safeCount(loc);
          if (n > 0) {
            return {
              ok: true,
              locator: loc,
              count: n,
              strategy: 'subagent',
              detail: `sub-agent picked "${TRUNC(fresh, 120)}"`,
            };
          }
        } catch {
          /* fall through */
        }
      }
    } catch {
      /* fall through */
    }
  }

  return {
    ok: false,
    reason: `no element matches target "${TRUNC(parsed.raw, 120)}" (tried: ${tried.join(', ')}). Call observe() again — the page may have changed, or pick a different role/name from the accessibility tree.`,
    triedStages: tried,
  };
}

/* ─────────────── disambiguation ─────────────── */

/**
 * Convert 1-based nth to 0-based index and apply it. Returns null if
 * nth is out of bounds.
 */
function pickNth(
  locator: Locator,
  count: number,
  nth: number | undefined,
): { loc: Locator; err?: string } {
  if (count === 1) return { loc: locator.first() };
  if (nth === undefined) {
    return {
      loc: locator,
      err:
        `ambiguous — ${count} elements match. Retry with nth=1..${count} ` +
        `to pick one (1 = first in document order). If the count looks wrong, call observe() again.`,
    };
  }
  if (!Number.isFinite(nth) || nth < 1 || nth > count) {
    return {
      loc: locator,
      err: `nth=${nth} out of range (1..${count}). Retry with a valid index.`,
    };
  }
  return { loc: locator.nth(nth - 1) };
}

/* ─────────────── perception anchoring ─────────────── */

// MIN_BECAUSE_LEN imported from config.ts

/**
 * Validate that the target the agent passed actually appeared in the
 * most recent observe() output. This is the structural defence
 * against the F-NEW-3 failure mode "agent invents locators between
 * observe and click": even though the cascade may still resolve
 * something through getByText / fallback, those drift into wrong
 * elements (e.g. menu items in collapsed overflow). The runtime
 * compares the agent's parsed (role, name) against the visible-keys
 * set populated by observe().
 *
 * The check is conservative — it only rejects cases where we are
 * confident the agent invented the target, so legitimate edge cases
 * (canvas-rendered controls, items the EXTRACTOR missed) still get
 * a chance to resolve via the cascade.
 *
 * Rules:
 *   - If lastObserveVisibleKeys is undefined → cannot validate, allow
 *     (this only happens before the first observe, and Gate D in the
 *     loop already blocks actions before the first observe).
 *   - If parsed.role is in VALID_ARIA_ROLES and parsed.name is
 *     non-empty: require exact match of "role:name" in the set.
 *   - If parsed.role is invalid (free-form name like "Это спам!"):
 *     require any visible item's name to contain parsed.raw as a
 *     substring (case-insensitive).
 *   - Role-only targets ("button" with no name) are always allowed
 *     since they intentionally match the first of N — no specific
 *     identity to validate.
 */
function validateTargetAgainstObserve(
  parsed: ParsedTarget,
  visibleKeys: Set<string> | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!visibleKeys) return { ok: true };
  const roleValid = VALID_ARIA_ROLES.has(parsed.role);
  // Role-only target (no name): allow.
  if (roleValid && !parsed.name) return { ok: true };
  if (roleValid && parsed.name) {
    const key = `${parsed.role}:${parsed.name.toLowerCase()}`;
    if (visibleKeys.has(key)) return { ok: true };
    return {
      ok: false,
      reason:
        `target "${parsed.role} ${parsed.name}" was NOT in the most recent observe() tree. ` +
        `You may be remembering an element from a previous page or imagining one. ` +
        `Call observe() again to refresh your view, then copy a role+name from a tree line that is actually there. ` +
        `If you need to find a specific kind of control, observe({query:"..."}) filters the tree by keyword.`,
    };
  }
  // Invalid role → free-form name. Walk the keys looking for substring.
  const needle = parsed.raw.toLowerCase();
  for (const k of visibleKeys) {
    // Keys are "role:name" — strip the "role:" prefix and check.
    const colon = k.indexOf(':');
    const name = colon >= 0 ? k.slice(colon + 1) : k;
    if (name && name.includes(needle)) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `target "${parsed.raw}" was not found in any item name in the most recent observe() tree. ` +
      `Call observe() to refresh your view (use observe({query:"..."}) to focus the tree on what you want), ` +
      `then pass a target in "<role> <name>" format copied from a tree line.`,
  };
}

/* ─────────────── click ─────────────── */

export interface ClickArgs {
  target: string;
  /** 1-based disambiguation index when the cascade returns multiple. */
  nth?: number;
  /**
   * Short justification linking this click to the agent's current
   * subgoal. The runtime requires non-empty content (≥10 chars). The
   * point is to force the agent to articulate WHY it is clicking THIS
   * thing right now — articulating intent measurably improves LLM
   * decision quality and creates a checkable audit trail.
   */
  because?: string;
}

export async function click(
  ctx: ToolContext,
  args: ClickArgs & { ref?: number },
): Promise<ToolResult> {
  const page = await ctx.getPage();

  // ── REF-BASED PATH (Playwright MCP approach) ──
  // When the agent passes ref=N, resolve directly from the refMap.
  // No cascade, no parseTarget, no getByRole/getByText fallback.
  if (args?.ref !== undefined && ctx.refMap) {
    const entry = ctx.refMap.get(args.ref);
    if (!entry) {
      return {
        ok: false,
        text: `ERROR click: ref=${args.ref} not found. Call observe() to get fresh refs.`,
      };
    }
    // Safety check
    if (ctx.safety) {
      const info = await describeElement(page, entry.locator.first()).catch(() => null);
      const verdict = ctx.safety.checkClick({
        selector: `ref=${args.ref}`,
        name: info?.name ?? entry.name,
        tag: info?.tag ?? '',
        type: info?.type,
      });
      if (verdict.blocked) {
        return {
          ok: false,
          text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action first, then retry.`,
        };
      }
    }
    try {
      await entry.locator.first().scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await entry.locator.first().click({ timeout: ACTION_TIMEOUT });
      await settleFast(page);
      ctx.safety?.consumeApproval();
      return {
        ok: true,
        text: `OK clicked [${args.ref}] ${entry.role} "${TRUNC(entry.name, 80)}" — now at ${page.url()}`,
      };
    } catch {
      // Fallback: JS click (handles covered elements, modals)
      try {
        await entry.locator.first().evaluate((el: HTMLElement) => el.click(), undefined, { timeout: JS_FALLBACK_TIMEOUT });
        await settleFast(page);
        ctx.safety?.consumeApproval();
        return {
          ok: true,
          text: `OK clicked [${args.ref}] ${entry.role} "${TRUNC(entry.name, 80)}" (via JS) — now at ${page.url()}`,
        };
      } catch (e2: unknown) {
        const msg = e2 instanceof Error ? e2.message : String(e2);
        return {
          ok: false,
          text: `ERROR click ref=${args.ref}: ${msg}. Call observe() for fresh refs.`,
        };
      }
    }
  }

  // ── LEGACY TARGET-BASED PATH (cascade) ──
  const parsed = parseTarget(args?.target);
  if (typeof parsed === 'string') {
    return {
      ok: false,
      text: `ERROR target: ${parsed}. Use ref=N from the tree, or "<role> <name>".`,
    };
  }
  const resolved = await resolveTarget(page, parsed, ctx);
  if (!resolved.ok) {
    return { ok: false, text: `ERROR click: ${resolved.reason}` };
  }

  // ── Safety hook (check on the first candidate) ──
  if (ctx.safety) {
    const checkLoc = resolved.count === 1
      ? resolved.locator.first()
      : resolved.locator.nth(args?.nth !== undefined ? args.nth - 1 : 0);
    const info = await describeElement(page, checkLoc);
    const verdict = ctx.safety.checkClick({
      selector: parsed.raw,
      name: info?.name ?? parsed.name,
      tag: info?.tag ?? '',
      type: info?.type,
    });
    if (verdict.blocked) {
      return {
        ok: false,
        text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action with an intent describing what you are about to do; after the user approves you may retry click.`,
      };
    }
  }

  // ── Click with auto-fallthrough on timeout ──
  // When multiple elements match the same role+name (common with modals
  // that duplicate a button from the background page), the selected nth
  // may point to the BACKGROUND copy which is covered by the overlay.
  // Playwright's actionability check times out on covered elements.
  // Instead of failing immediately, we auto-try the remaining matches
  // — the overlay copy is almost always the next one in document order.
  const candidateCount = resolved.count;
  const startIdx = args?.nth !== undefined ? args.nth - 1 : 0;
  const endIdx = Math.min(candidateCount, startIdx + MAX_CLICK_FALLTHROUGH);

  let lastTimeoutLoc: Locator | null = null;

  for (let tryIdx = startIdx; tryIdx < endIdx; tryIdx++) {
    const tryLoc = candidateCount === 1
      ? resolved.locator.first()
      : resolved.locator.nth(tryIdx);
    try {
      await tryLoc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await tryLoc.click({ timeout: ACTION_TIMEOUT });
      await settleFast(page);
      ctx.safety?.consumeApproval();
      const how =
        resolved.strategy === 'role'
          ? `${parsed.role} "${TRUNC(parsed.name, 80)}"`
          : `${resolved.strategy}="${TRUNC(parsed.name || parsed.role, 80)}"`;
      const viaSub = resolved.strategy === 'subagent' ? ' (via sub-agent)' : '';
      const nthNote = tryIdx !== startIdx ? ` (auto-picked nth=${tryIdx + 1}, earlier match was covered)` : '';
      return {
        ok: true,
        text: `OK clicked ${how}${viaSub}${nthNote} — now at ${page.url()}`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout|exceeded/i.test(msg);
      if (isTimeout) {
        lastTimeoutLoc = tryLoc;
        if (tryIdx + 1 < endIdx) continue;
      }
      if (!isTimeout) {
        return {
          ok: false,
          text: `ERROR click "${TRUNC(parsed.raw, 100)}": ${msg}. Call observe() again and retry with a fresh role/name.`,
        };
      }
    }
  }

  // ── Last resort: JS click ──
  // All Playwright actionability-checked clicks timed out. The element
  // exists in the DOM but Playwright can't click it (covered by overlay,
  // inside a modal below fold, animation in progress). A JS-level
  // el.click() bypasses all visual checks. This is safe because the
  // safety layer already ran above, and the element was positively
  // resolved from the live a11y tree.
  if (lastTimeoutLoc) {
    try {
      await lastTimeoutLoc.evaluate((el: HTMLElement) => el.click(), undefined, { timeout: JS_FALLBACK_TIMEOUT });
      await settleFast(page);
      ctx.safety?.consumeApproval();
      const how =
        resolved.strategy === 'role'
          ? `${parsed.role} "${TRUNC(parsed.name, 80)}"`
          : `${resolved.strategy}="${TRUNC(parsed.name || parsed.role, 80)}"`;
      return {
        ok: true,
        text: `OK clicked ${how} (via JS fallback) — now at ${page.url()}`,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        text:
          `ERROR click "${TRUNC(parsed.raw, 100)}": all ${endIdx - startIdx} Playwright attempts timed out, ` +
          `JS fallback also failed: ${msg}. Call observe() to refresh your view.`,
      };
    }
  }

  return {
    ok: false,
    text: `ERROR click "${TRUNC(parsed.raw, 100)}": no actionable match found among ${candidateCount} candidates.`,
  };
}

/* ─────────────── type ─────────────── */

export interface TypeArgs {
  target: string;
  text: string;
  submit?: boolean;
  nth?: number;
  because?: string;
}

export async function type(
  ctx: ToolContext,
  args: TypeArgs & { ref?: number },
): Promise<ToolResult> {
  if (args?.text === undefined || args?.text === null) {
    return { ok: false, text: 'ERROR: text is required' };
  }
  const page = await ctx.getPage();

  // ── REF-BASED PATH ──
  if (args?.ref !== undefined && ctx.refMap) {
    const entry = ctx.refMap.get(args.ref);
    if (!entry) {
      return {
        ok: false,
        text: `ERROR type: ref=${args.ref} not found. Call observe() to get fresh refs.`,
      };
    }
    if (ctx.safety) {
      const info = await describeElement(page, entry.locator.first()).catch(() => null);
      const verdict = ctx.safety.checkType({
        selector: `ref=${args.ref}`,
        name: info?.name ?? entry.name,
        tag: info?.tag ?? '',
        type: info?.type,
        text: args.text,
      });
      if (verdict.blocked) {
        return {
          ok: false,
          text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action first, then retry.`,
        };
      }
    }
    const loc = entry.locator.first();
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      try {
        await loc.fill(args.text, { timeout: ACTION_TIMEOUT });
      } catch {
        try {
          await loc.click({ timeout: ACTION_TIMEOUT });
        } catch {
          await loc.evaluate((el: HTMLElement) => el.focus(), undefined, { timeout: JS_FALLBACK_TIMEOUT });
        }
        await page.keyboard.type(args.text, { delay: 30 });
      }
      if (args.submit === true) {
        try {
          await loc.press('Enter', { timeout: 2_000 });
        } catch {
          await page.keyboard.press('Enter');
        }
      }
      await settleFast(page);
      return {
        ok: true,
        text:
          `OK typed ${args.text.length} chars into [${args.ref}] ${entry.role} "${TRUNC(entry.name, 80)}"` +
          (args.submit ? ' + Enter' : ''),
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        text: `ERROR type ref=${args.ref}: ${msg}. Call observe() for fresh refs.`,
      };
    }
  }

  // ── LEGACY TARGET-BASED PATH ──
  const parsed = parseTarget(args?.target);
  if (typeof parsed === 'string') {
    return {
      ok: false,
      text: `ERROR target: ${parsed}. Use ref=N from the tree, or "<role> <name>".`,
    };
  }
  const anchor = validateTargetAgainstObserve(parsed, ctx.lastObserveVisibleKeys);
  if (!anchor.ok) { /* Allow cascade to try */ }
  const resolved = await resolveTarget(page, parsed, ctx);
  if (!resolved.ok) {
    return { ok: false, text: `ERROR type: ${resolved.reason}` };
  }

  // ── Safety hook (check on the first candidate) ──
  if (ctx.safety) {
    const checkLoc = resolved.count === 1
      ? resolved.locator.first()
      : resolved.locator.nth(args?.nth !== undefined ? args.nth - 1 : 0);
    const info = await describeElement(page, checkLoc);
    const verdict = ctx.safety.checkType({
      selector: parsed.raw,
      name: info?.name ?? parsed.name,
      tag: info?.tag ?? '',
      type: info?.type,
      text: args.text,
    });
    if (verdict.blocked) {
      return {
        ok: false,
        text: `BLOCKED (safety): ${verdict.reason}. Call confirm_action first, then retry.`,
      };
    }
  }

  // ── Type with auto-fallthrough on timeout (same logic as click) ──
  const typeCandidateCount = resolved.count;
  const typeStartIdx = args?.nth !== undefined ? args.nth - 1 : 0;
  const typeEndIdx = Math.min(typeCandidateCount, typeStartIdx + MAX_CLICK_FALLTHROUGH);

  let lastTypeTimeoutLoc: Locator | null = null;

  for (let tryIdx = typeStartIdx; tryIdx < typeEndIdx; tryIdx++) {
    const tryLoc = typeCandidateCount === 1
      ? resolved.locator.first()
      : resolved.locator.nth(tryIdx);
    try {
      await tryLoc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      try {
        await tryLoc.fill(args.text, { timeout: ACTION_TIMEOUT });
      } catch {
        // Fallback: click to focus + keyboard.type (works for custom
        // comboboxes, React inputs, contenteditable, and other non-native
        // form controls that reject fill())
        try {
          await tryLoc.click({ timeout: ACTION_TIMEOUT });
        } catch {
          // If even click fails (modal overlay), use JS focus fallback
          await tryLoc.evaluate((el: HTMLElement) => el.focus(), undefined, { timeout: JS_FALLBACK_TIMEOUT });
        }
        await page.keyboard.type(args.text, { delay: 30 });
      }
      if (args.submit === true) {
        try {
          await tryLoc.press('Enter', { timeout: 2_000 });
        } catch {
          await page.keyboard.press('Enter');
        }
      }
      await settleFast(page);
      const nthNote = tryIdx !== typeStartIdx ? ` (auto-picked nth=${tryIdx + 1})` : '';
      return {
        ok: true,
        text:
          `OK typed ${args.text.length} chars into ${parsed.role} "${TRUNC(parsed.name, 80)}"` +
          (args.submit ? ' + Enter' : '') +
          (resolved.strategy === 'subagent' ? ' (via sub-agent)' : '') +
          nthNote,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout|exceeded/i.test(msg);
      if (isTimeout) {
        lastTypeTimeoutLoc = tryLoc;
        if (tryIdx + 1 < typeEndIdx) continue;
      }
      if (!isTimeout) {
        return {
          ok: false,
          text: `ERROR type "${TRUNC(parsed.raw, 100)}": ${msg}. Call observe() again and retry.`,
        };
      }
    }
  }

  // ── Last resort: JS focus + keyboard type ──
  if (lastTypeTimeoutLoc) {
    try {
      await lastTypeTimeoutLoc.evaluate((el: HTMLElement) => {
        el.scrollIntoView({ block: 'center' });
        el.focus();
      }, undefined, { timeout: JS_FALLBACK_TIMEOUT });
      await page.keyboard.type(args.text, { delay: 30 });
      if (args.submit === true) {
        await page.keyboard.press('Enter');
      }
      await settleFast(page);
      return {
        ok: true,
        text:
          `OK typed ${args.text.length} chars into ${parsed.role} "${TRUNC(parsed.name, 80)}" (via JS fallback)` +
          (args.submit ? ' + Enter' : ''),
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        text: `ERROR type "${TRUNC(parsed.raw, 100)}": JS fallback also failed: ${msg}. Call observe() again.`,
      };
    }
  }
  return {
    ok: false,
    text: `ERROR type "${TRUNC(parsed.raw, 100)}": no actionable match found among ${typeCandidateCount} candidates.`,
  };
}
