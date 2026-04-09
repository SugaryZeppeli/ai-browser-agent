import type { Page } from 'playwright';
import { SCROLL_JUMP_THRESHOLD_PX } from '../config.js';

/**
 * Observer layer — state delta injection using native a11y tree.
 *
 * Computes a structured snapshot BEFORE and AFTER every mutating tool
 * call, diffs the two, and injects a "[STATE DELTA]" block into the
 * tool result so the agent sees exactly what changed.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  dialogs: string[];
  selectionCount: number;
  interactiveCount: number;
  scrollY: number;
  scrollHeight: number;
  mainTextHash: number;
  /** Short excerpt of main content for delta readability. */
  mainTextExcerpt: string;
  /** Set of "role name" lines from ariaSnapshot for set-diff. */
  a11yLines: string[];
  /** Raw ariaSnapshot YAML — cached for observe() reuse after mutation. */
  rawAriaYaml?: string;
}

/**
 * Capture a snapshot. Uses page.evaluate for counters + ariaSnapshot
 * for the a11y diff set.
 */
export async function snapshot(page: Page): Promise<PageSnapshot> {
  try {
    const url = page.url();
    if (!url || url === 'about:blank') {
      return {
        url, title: '', dialogs: [], selectionCount: 0,
        interactiveCount: 0, scrollY: 0, scrollHeight: 0, mainTextHash: 0, mainTextExcerpt: '', a11yLines: [],
      };
    }
    const title = await page.title().catch(() => '');

    // Counters via page.evaluate (cheap, ~20ms)
    const raw = await page.evaluate(() => {
      const safe = <T>(fn: () => T, fb: T): T => { try { return fn(); } catch { return fb; } };
      const dialogs = safe(() =>
        Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
          .filter(d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(d => {
            const el = d as HTMLElement;
            return el.getAttribute('aria-label')?.trim()?.slice(0, 80)
              || el.querySelector('h1,h2,h3')?.textContent?.trim()?.slice(0, 80)
              || el.innerText?.trim()?.slice(0, 80) || '';
          }).filter(Boolean), [] as string[]);
      const checked = safe(() => document.querySelectorAll('input:checked, [aria-checked="true"], [aria-selected="true"]').length, 0);
      const interactive = safe(() => document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]').length, 0);
      const rootEl = (document.scrollingElement || document.documentElement) as HTMLElement;
      const rootScrollY = safe(() => rootEl?.scrollTop || 0, 0);
      const rootScrollH = safe(() => rootEl?.scrollHeight || 0, 0);
      // Targeted query for inner scrollable containers — no querySelectorAll('*')
      let bestInnerY = 0;
      safe(() => {
        const containers = Array.from(document.querySelectorAll<HTMLElement>('[style*="overflow"], [class]'));
        let scanned = 0;
        for (const el of containers) {
          if (++scanned > 200) break;
          if (el === rootEl || el === document.body) continue;
          if (el.scrollHeight <= el.clientHeight + 50) continue;
          const oy = getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') continue;
          if (el.scrollTop > bestInnerY) bestInnerY = el.scrollTop;
        }
      }, undefined);
      const scrollY = Math.max(rootScrollY, bestInnerY);
      const scrollHeight = rootScrollH;
      const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; };
      const main = safe(() => document.querySelector('main') || document.querySelector('[role="main"]') || document.body, document.body);
      const mainText = safe(() => (main as HTMLElement)?.innerText?.slice(0, 4000) || '', '');
      const mainHash = hashStr(mainText);
      const mainExcerpt = mainText.replace(/\s+/g, ' ').trim().slice(0, 200);
      return { dialogs, selectionCount: checked, interactiveCount: interactive, scrollY, scrollHeight, mainTextHash: mainHash, mainTextExcerpt: mainExcerpt };
    }).catch(() => ({ dialogs: [] as string[], selectionCount: 0, interactiveCount: 0, scrollY: 0, scrollHeight: 0, mainTextHash: 0, mainTextExcerpt: '' }));

    // Native a11y tree for set diff (~50-150ms per call)
    // Keep indentation so same-name elements in different containers
    // (e.g. modal "OK" vs background "OK") produce distinct set entries.
    let a11yLines: string[] = [];
    let rawAriaYaml: string | undefined;
    try {
      rawAriaYaml = await page.locator(':root').ariaSnapshot();
      a11yLines = rawAriaYaml.split('\n')
        .filter(l => l.trimStart().startsWith('- ') && l.trim().length > 4)
        .slice(0, 200);
    } catch { /* ariaSnapshot may fail mid-navigation */ }

    return { url, title, ...raw, a11yLines, rawAriaYaml };
  } catch {
    return {
      url: '', title: '', dialogs: [], selectionCount: 0,
      interactiveCount: 0, scrollY: 0, scrollHeight: 0, mainTextHash: 0, mainTextExcerpt: '', a11yLines: [],
    };
  }
}

/**
 * Render a human-readable delta. Empty string = no change.
 */
export function renderDelta(before: PageSnapshot, after: PageSnapshot): string {
  const lines: string[] = [];

  if (before.url !== after.url)
    lines.push(`- URL: ${before.url} → ${after.url}`);
  if (before.title !== after.title)
    lines.push(`- Title: "${before.title}" → "${after.title}"`);

  const newDialogs = after.dialogs.filter(d => !before.dialogs.includes(d));
  const closedDialogs = before.dialogs.filter(d => !after.dialogs.includes(d));
  if (newDialogs.length) lines.push(`- Dialog opened: "${newDialogs.join('", "')}"`);
  if (closedDialogs.length) lines.push(`- Dialog closed: "${closedDialogs.join('", "')}"`);

  if (before.selectionCount !== after.selectionCount) {
    const d = after.selectionCount - before.selectionCount;
    lines.push(`- Selected: ${before.selectionCount} → ${after.selectionCount} (${d > 0 ? '+' : ''}${d})`);
  }

  const iDelta = after.interactiveCount - before.interactiveCount;
  if (Math.abs(iDelta) >= 5)
    lines.push(`- Interactive elements: ${before.interactiveCount} → ${after.interactiveCount} (${iDelta > 0 ? '+' : ''}${iDelta})`);

  if (Math.abs(after.scrollY - before.scrollY) >= SCROLL_JUMP_THRESHOLD_PX) {
    const pct = after.scrollHeight > 0 ? Math.round((after.scrollY / after.scrollHeight) * 100) : 0;
    lines.push(`- Scrolled: y=${before.scrollY} → ${after.scrollY} (${pct}% of page)`);
  }

  if (before.url === after.url && before.title === after.title &&
      before.mainTextHash !== after.mainTextHash && before.mainTextHash !== 0 && after.mainTextHash !== 0) {
    const excerpt = after.mainTextExcerpt ? `: "${after.mainTextExcerpt.slice(0, 120)}"` : '';
    lines.push(`- Main content replaced in-place${excerpt}`);
  }

  // A11y set diff from native tree — skip when URL changed (everything
  // changed, the diff is pure noise and wastes tokens).
  const urlChanged = before.url !== after.url;
  if (!urlChanged && (before.a11yLines.length > 0 || after.a11yLines.length > 0)) {
    const bSet = new Set(before.a11yLines);
    const aSet = new Set(after.a11yLines);
    const added = after.a11yLines.filter(l => !bSet.has(l));
    const removed = before.a11yLines.filter(l => !aSet.has(l));
    const fmt = (items: string[], cap: number) =>
      items.length <= cap ? items.join('; ') : items.slice(0, cap).join('; ') + `; … (+${items.length - cap} more)`;
    if (added.length) lines.push(`- A11y appeared (${added.length}): ${fmt(added, 8)}`);
    if (removed.length) lines.push(`- A11y removed (${removed.length}): ${fmt(removed, 8)}`);
  }

  return lines.length ? `[STATE DELTA]\n${lines.join('\n')}` : '';
}

export function isMutatingTool(name: string): boolean {
  return name === 'navigate_to_url' || name === 'click' || name === 'type' ||
    name === 'click_element' || name === 'type_text' || name === 'press_key';
}

export function isPageStateChangingTool(name: string): boolean {
  return isMutatingTool(name) || name === 'scroll_page';
}
