/**
 * observe() — perception primitive built on Playwright's native
 * accessibility tree (ariaSnapshot).
 *
 * Returns:
 *   1. The browser's own accessibility tree (role + name for every
 *      element) — the same tree that screen readers and Playwright MCP
 *      use. No custom JS extraction, no DOM heuristics, no opacity
 *      guessing. One line: page.locator(':root').ariaSnapshot().
 *   2. Page metadata: URL, title.
 *   3. A JPEG screenshot (q70) for vision-capable models.
 *
 * The tree is compact YAML. When `query` is provided, we filter lines
 * by keyword match to keep only the relevant subtree.
 */

import type { Page, Locator } from 'playwright';
import type { ToolContext, ToolResult, RefEntry } from './types.js';
import {
  MAX_TREE_ITEMS_DEFAULT,
  MAX_TREE_ITEMS_QUERY,
  NAME_TRUNCATE,
  looksLikeCaptcha,
} from '../config.js';

/* ─────────────── ref-based element resolution (Playwright MCP approach) ─────────────── */

/**
 * Actionable ARIA roles that get ref numbers in the observe() output.
 * Non-actionable roles (list, paragraph, heading, img, etc.) are kept
 * in the tree for context but don't get refs — the agent can't click them.
 */
const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'spinbutton',
  'checkbox', 'radio', 'switch', 'option', 'tab', 'menuitem',
  'treeitem', 'slider', 'meter', 'cell', 'row',
]);

const ARIA_REF_LINE = /^(\s*)- (\w+)(?:\s+"([^"]*)")?(.*)$/;

/**
 * Build a ref→Locator map from ariaSnapshot YAML lines.
 * Each actionable element gets a sequential ref number.
 * The locator is built from role+name+nth (same approach as Playwright MCP).
 *
 * IMPORTANT: `domOrderLines` must be the FULL tree in original DOM order
 * (before any dialog-first reordering). Playwright's .nth() resolves
 * elements in DOM order, so the nth counter must match. Without this,
 * dialog-first reordering makes the nth wrong: a dialog's "Submit"
 * button gets nth=0 but page.getByRole().nth(0) returns the listing
 * page's "Submit" button (which is earlier in DOM), causing clicks on
 * the wrong element.
 */
export function buildRefMap(
  page: Page,
  yamlLines: string[],
  domOrderLines?: string[],
): {
  refMap: Map<number, RefEntry>;
  annotatedLines: string[];
} {
  // Pre-count role:name occurrences in DOM order so .nth() matches
  // Playwright's document-order resolution.
  const domCounts = new Map<string, number>();
  const domNthMap = new Map<string, number>(); // "role:name@lineContent" → dom nth
  if (domOrderLines) {
    for (const line of domOrderLines) {
      const m = line.match(ARIA_REF_LINE);
      if (!m || !ACTIONABLE_ROLES.has(m[2]!)) continue;
      const key = `${m[2]}:${m[3] ?? ''}`;
      const nth = domCounts.get(key) ?? 0;
      domCounts.set(key, nth + 1);
      // Use the full line as identity to map back from mini-tree
      domNthMap.set(line, nth);
    }
  }

  const refMap = new Map<number, RefEntry>();
  const localCounts = new Map<string, number>();
  const annotatedLines: string[] = [];
  let ref = 1;

  for (let i = 0; i < yamlLines.length; i++) {
    const line = yamlLines[i]!;
    const m = line.match(ARIA_REF_LINE);
    if (!m) {
      annotatedLines.push(line);
      continue;
    }

    const indent = m[1]!;
    const role = m[2]!;
    const name = m[3] ?? '';
    const rest = m[4] ?? '';

    if (!ACTIONABLE_ROLES.has(role)) {
      annotatedLines.push(line);
      continue;
    }

    // Skip unnamed elements for roles where name is expected.
    // Unnamed link/button → getByRole(role).nth(N) matches ALL elements
    // of that role (including named ones), making nth unreliable.
    // Roles where unnamed is normal: checkbox, radio, switch, slider.
    const UNNAMED_OK = new Set(['checkbox', 'radio', 'switch', 'slider']);
    if (!name && !UNNAMED_OK.has(role)) {
      annotatedLines.push(line);
      continue;
    }

    // Use DOM-order nth if available, else fall back to local count
    let nth: number;
    if (domOrderLines && domNthMap.has(line)) {
      nth = domNthMap.get(line)!;
    } else {
      const key = `${role}:${name}`;
      nth = localCounts.get(key) ?? 0;
      localCounts.set(key, nth + 1);
    }

    const locator: Locator = name
      ? page.getByRole(role as any, { name, exact: true }).nth(nth)
      : page.getByRole(role as any).nth(nth);

    refMap.set(ref, { ref, role, name, locator });
    // Add ordinal hint for duplicate-name elements so the model knows
    // which instance to pick: "[5] button "Откликнуться" (1st of 4)"
    const key = `${role}:${name}`;
    const total = domCounts.get(key) ?? 1;
    const ordinal = total > 1 ? ` (${nth + 1}/${total})` : '';

    // Context annotation for duplicate-named elements.
    // When multiple elements share the same role:name (e.g. 15 buttons
    // all named "В корзину"), the ordinal (3/15) tells the model WHICH
    // instance but not WHAT it belongs to. Walk backward through the
    // tree to find the nearest preceding element with a distinct name
    // — typically a heading, link, or product name — and attach it so
    // the model can make an informed choice.
    let context = '';
    if (total > 1 && name) {
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const prevLine = yamlLines[j]!;
        // ariaSnapshot uses two name formats:
        //   - button "Submit"    → quoted name (captured by ARIA_REF_LINE group 3)
        //   - text: Some content → colon-delimited content (no quotes)
        const pm = prevLine.match(ARIA_REF_LINE);
        let prevName = '';
        if (pm) {
          prevName = (pm[3] ?? '').trim();
          // If no quoted name, try colon-style content: "- text: ..."
          if (!prevName) {
            const colonIdx = prevLine.indexOf(':');
            if (colonIdx >= 0) {
              prevName = prevLine.slice(colonIdx + 1).trim();
            }
          }
        }
        if (prevName && prevName !== name && prevName.length >= 3) {
          context = ` [of: "${prevName.slice(0, NAME_TRUNCATE)}"]`;
          break;
        }
      }
    }

    annotatedLines.push(`${indent}- [${ref}] ${role}${name ? ` "${name}"` : ''}${rest}${ordinal}${context}`);
    ref++;
  }

  return { refMap, annotatedLines };
}

/* ─────────────── keyword filtering ─────────────── */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'on', 'in', 'at', 'to', 'of', 'for', 'with', 'by', 'from', 'as',
  'this', 'that', 'and', 'or', 'but', 'if', 'so', 'what', 'where',
  'find', 'locate', 'get', 'show', 'me', 'it', 'all', 'any',
  'на', 'в', 'и', 'или', 'но', 'что', 'где', 'как', 'это',
  'для', 'по', 'с', 'от', 'до', 'из', 'о', 'все', 'найди', 'покажи',
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Filter ariaSnapshot YAML lines by keyword relevance.
 * Each line that contains a keyword match gets a score.
 * We keep the top N lines plus their parent indentation context.
 */
function filterByQuery(
  lines: string[],
  keywords: string[],
  maxItems: number,
): string[] {
  if (keywords.length === 0) return lines.slice(0, maxItems * 3);

  // Build stems: for keywords ≥4 chars, also try the first N-1 chars
  // as a prefix. This handles Russian morphology: "еду" matches "еде",
  // "стрипсы" matches "стрипс". No language-specific logic — just
  // prefix matching on the assumption that inflected forms share a stem.
  const stems: string[] = [];
  for (const k of keywords) {
    stems.push(k);
    if (k.length >= 4) stems.push(k.slice(0, -1));
  }

  // Score each line
  const scored: { idx: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    let score = 0;
    for (const s of stems) {
      if (lower.includes(s)) score += 1;
    }
    if (score > 0) scored.push({ idx: i, score });
  }

  // Sort by score desc, take top N
  scored.sort((a, b) => b.score - a.score);
  const keep = new Set<number>();
  for (const { idx } of scored.slice(0, maxItems)) {
    keep.add(idx);
    // Walk upward to indent=0 keeping ALL ancestor lines, not just the
    // first one. This reconstructs the full path so the LLM can see
    // which container/section each matching item belongs to.
    let curIndent = lines[idx]!.search(/\S/);
    for (let j = idx - 1; j >= 0 && curIndent > 0; j--) {
      const pIndent = lines[j]!.search(/\S/);
      if (pIndent >= 0 && pIndent < curIndent) {
        keep.add(j);
        curIndent = pIndent;
      }
    }
  }

  const sorted = Array.from(keep).sort((a, b) => a - b);
  return sorted.map((i) => lines[i]!);
}

/* ─────────────── dialog prioritization ─────────────── */

/**
 * Matches overlay-like elements that should be prioritized in the tree:
 * - dialog / alertdialog — modal windows
 * - listbox — dropdown popups (React portals rendered outside the dialog)
 */
const OVERLAY_RE = /^(\s*)- (dialog|alertdialog|listbox)\b/;

/**
 * Extract overlay subtrees (dialogs, listboxes) from ariaSnapshot YAML.
 * Returns overlay lines (with children) and the remaining lines.
 * These elements are often at the END of the DOM (React portals) and
 * get cut by the line cap. Moving them to the front ensures the agent
 * always sees modal controls and dropdown options.
 */
function extractDialogBlocks(lines: string[]): { dialogLines: string[]; restLines: string[] } {
  const dialogLines: string[] = [];
  const restLines: string[] = [];
  let inDialog = false;
  let dialogIndent = 0;

  for (const line of lines) {
    if (!inDialog) {
      const m = line.match(OVERLAY_RE);
      if (m) {
        inDialog = true;
        dialogIndent = m[1]!.length;
        dialogLines.push(line);
        continue;
      }
      restLines.push(line);
    } else {
      // Lines with deeper indentation are part of the dialog subtree
      const lineIndent = line.search(/\S/);
      if (lineIndent < 0 || lineIndent > dialogIndent) {
        dialogLines.push(line);
      } else {
        // Back to same or lesser indent — dialog block ended
        inDialog = false;
        // Check if this line starts another dialog
        const m = line.match(OVERLAY_RE);
        if (m) {
          inDialog = true;
          dialogIndent = m[1]!.length;
          dialogLines.push(line);
        } else {
          restLines.push(line);
        }
      }
    }
  }

  return { dialogLines, restLines };
}

/* ─────────────── tree compression ─────────────── */

/**
 * Container-only roles — these are structural wrappers with no
 * actionable content. Stripping them saves 30-40% tokens while
 * preserving every interactive/named element the LLM needs.
 */
const CONTAINER_ONLY_RE = /^(\s*)- (list|listitem|group|generic|none|paragraph|article|region|main|document|section|navigation|banner|contentinfo|complementary|form):?\s*$/;

/**
 * Compress ariaSnapshot YAML for LLM consumption:
 * 1. Strip container-only lines (list:, listitem:, group:, etc.)
 * 2. Reduce indentation (2-space steps → 1-space)
 * 3. Truncate long names
 */
const HEADING_RE = /^(\s*)- heading "([^"]*)"(.*)/;

function compressTree(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    // Skip container-only nodes
    if (CONTAINER_ONLY_RE.test(line)) continue;
    // Format headings as visual section separators for easier LLM orientation
    const hm = line.match(HEADING_RE);
    if (hm) {
      const name = hm[2]!.slice(0, NAME_TRUNCATE);
      const attrs = hm[3]!.trim();
      result.push(`--- ${name} ${attrs} ---`);
      continue;
    }
    // Truncate long names
    const truncated = line.replace(
      new RegExp(`"([^"]{${NAME_TRUNCATE},})"`, 'g'),
      (_, name) => `"${name.slice(0, NAME_TRUNCATE)}…"`,
    );
    // Halve indentation to save chars
    const indent = truncated.search(/\S/);
    const content = truncated.trimStart();
    const newIndent = ' '.repeat(Math.floor(indent / 2));
    result.push(newIndent + content);
  }
  return result;
}

/**
 * Build a compact text tree from raw ariaSnapshot YAML.
 * Used by the loop to attach a mini-tree to mutation results
 * so the model can act without a separate observe() call.
 */
export function buildMiniTree(
  page: Page,
  rawYaml: string,
  maxLines = 120,
): { text: string; refMap: Map<number, RefEntry> } {
  const allLines = rawYaml.split('\n');
  const { dialogLines, restLines } = extractDialogBlocks(allLines);
  const restCap = Math.max(0, maxLines * 3 - dialogLines.length);
  const capped = [...dialogLines, ...restLines.slice(0, restCap)];

  // Build refs — pass allLines as DOM-order reference so nth counters
  // match Playwright's document-order .nth() resolution.
  const { refMap, annotatedLines } = buildRefMap(page, capped, allLines);
  const compressed = compressTree(annotatedLines);
  if (compressed.length === 0) return { text: '', refMap };
  const hidden = allLines.length - capped.length;
  const note = hidden > 0 ? ` (${hidden} lines hidden — call observe(query) for more)` : '';
  return { text: `[TREE${note}]\n${compressed.join('\n')}`, refMap };
}

/* ─────────────── visible keys extraction ─────────────── */

/**
 * Parse "role name" pairs from ariaSnapshot YAML lines.
 * Lines look like: `  - button "Submit"` or `  - checkbox "Select all" [checked]`
 */
const ARIA_LINE_RE = /- (\w+)(?:\s+"([^"]*)")?/;

/** Strip invisible Unicode chars that break key matching (soft hyphens, ZWS, etc). */
function sanitizeName(raw: string): string {
  return raw
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

export function extractVisibleKeys(lines: string[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const m = line.match(ARIA_LINE_RE);
    if (m) {
      const role = m[1]!.toLowerCase();
      const name = sanitizeName((m[2] || '').toLowerCase());
      keys.add(`${role}:${name}`);
    }
  }
  return keys;
}

/* ─────────────── main snapshot ─────────────── */

export async function snapshotPage(
  page: Page,
  opts: { query?: string; maxItems?: number; cachedAriaYaml?: string; visual?: boolean } = {},
): Promise<{
  text: string;
  image_base64: string;
  visibleKeys: Set<string>;
  refMap: Map<number, RefEntry>;
}> {
  // Use cached ariaSnapshot if provided (post-mutation cache hit), else read fresh
  const ariaYaml = opts.cachedAriaYaml ?? await page.locator(':root').ariaSnapshot();

  const url = page.url();
  const title = await page.title();

  // Collect current input values + loading state in a single evaluate.
  const pageState = await page.evaluate(() => {
    const inputValues: Record<string, string> = {};
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable="true"]',
    ));
    for (const el of inputs) {
      const val = el.value ?? el.textContent ?? '';
      if (!val) continue;
      const name =
        el.getAttribute('aria-label')?.trim() ||
        el.labels?.[0]?.textContent?.trim() ||
        el.placeholder?.trim() ||
        el.name || '';
      if (name) inputValues[name.slice(0, 120).toLowerCase()] = val.slice(0, 120);
    }
    const isBusy = !!document.querySelector('[aria-busy="true"]');
    return { inputValues, isBusy };
  }).catch(() => ({ inputValues: {} as Record<string, string>, isBusy: false }));
  const { inputValues, isBusy } = pageState;

  const allLines = ariaYaml.split('\n');

  // ── Dialog prioritization ──
  // Modals/dialogs are rendered at the END of the DOM tree on modern SPAs.
  // Without this, the line cap cuts them off and the agent can't see modal
  // controls (submit buttons, form fields, resume selectors). Generic fix:
  // extract dialog blocks and prepend them before capping.
  const { dialogLines, restLines } = extractDialogBlocks(allLines);

  // Filter if query provided
  let treeLines: string[];
  let filterNote = '';
  if (opts.query?.trim()) {
    const keywords = extractKeywords(opts.query);
    if (keywords.length > 0) {
      // Search across all lines (dialog + rest) so queries find modal content
      treeLines = filterByQuery([...dialogLines, ...restLines], keywords, opts.maxItems ?? MAX_TREE_ITEMS_QUERY);
      filterNote = ` (filtered by "${opts.query}", ${treeLines.length} of ${allLines.length} lines)`;
    } else {
      treeLines = allLines.slice(0, (opts.maxItems ?? MAX_TREE_ITEMS_DEFAULT) * 3);
      filterNote = ' (query had no keywords, showing default)';
    }
  } else {
    // Dialog lines first, then rest, then cap
    const maxLines = (opts.maxItems ?? MAX_TREE_ITEMS_DEFAULT) * 3;
    const restCap = Math.max(0, maxLines - dialogLines.length);
    treeLines = [...dialogLines, ...restLines.slice(0, restCap)];
    if (allLines.length > maxLines) {
      filterNote = ` (${allLines.length - treeLines.length} lines hidden — use query to filter)`;
    }
  }

  // Build ref→Locator map — pass allLines as DOM-order reference so nth
  // counters match Playwright's .nth() even when treeLines is filtered/capped.
  const { refMap, annotatedLines } = buildRefMap(page, treeLines, allLines);

  // Compress: strip container-only nodes, truncate names, flatten indent
  const compressed = compressTree(annotatedLines);

  // Annotate text inputs with their current value
  const INPUT_ROLE_RE = /^(\s*-\s+(?:\[\d+\]\s+)?(?:textbox|searchbox|combobox|spinbutton))\s+"([^"]*)"/;
  const withValues = compressed.map((line) => {
    const m = line.match(INPUT_ROLE_RE);
    if (!m) return line;
    const fieldName = m[2]!.toLowerCase();
    const val = inputValues[fieldName];
    if (val) return `${line} [value="${val}"]`;
    return line;
  });

  const textParts = [
    `URL: ${url}`,
    `TITLE: ${title}`,
    ...(isBusy ? ['STATUS: page is loading (aria-busy) — consider wait() before acting'] : []),
    '',
    `ACCESSIBILITY TREE${filterNote}:`,
    ...withValues,
  ];

  const visibleKeys = extractVisibleKeys(treeLines);

  const skipScreenshot = opts.visual === false;
  const image_base64 = skipScreenshot
    ? ''
    : (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');

  return {
    text: textParts.join('\n'),
    image_base64,
    visibleKeys,
    refMap,
  };
}

/**
 * Tool entry point.
 */
export async function observe(
  ctx: ToolContext,
  args: { query?: string; max_items?: number; visual?: boolean },
): Promise<ToolResult> {
  try {
    const page = await ctx.getPage();
    const url = page.url();
    if (looksLikeCaptcha(url)) {
      return {
        ok: false,
        text:
          `CAPTCHA/BOT-CHECK detected at ${url}. You CANNOT solve this yourself. ` +
          `Call ask_user to have the human solve the challenge in the visible browser window, ` +
          `then call observe() again.`,
      };
    }
    // Use cached ariaSnapshot from post-mutation observer if URL still matches.
    // Skip cache when a query is provided — the agent is searching for something
    // specific that may have appeared AFTER the post-mutation snapshot (e.g. a
    // textarea revealed by a CSS animation). Fresh read ensures accuracy.
    let cachedYaml: string | undefined;
    const hasQuery = !!args?.query?.trim();
    if (!hasQuery && ctx.cachedAriaYaml && ctx.cachedAriaYaml.url === url) {
      cachedYaml = ctx.cachedAriaYaml.yaml;
    }
    ctx.cachedAriaYaml = undefined; // consume cache regardless

    const { text, image_base64, visibleKeys, refMap } = await snapshotPage(page, {
      query: args?.query,
      maxItems: args?.max_items,
      cachedAriaYaml: cachedYaml,
      visual: args?.visual !== false,
    });
    ctx.lastObserveVisibleKeys = visibleKeys;
    ctx.lastObserveText = text;
    ctx.refMap = refMap;
    return { ok: true, text, image_base64 };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR observe: ${msg}` };
  }
}
