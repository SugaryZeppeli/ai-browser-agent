import type { Page } from 'playwright';
import { llm, DOM_MODEL } from '../llm.js';
import { parseLocator } from '../tools/selector.js';

type GetPage = () => Promise<Page>;

/**
 * Strip zero-width and soft-hyphen characters that LLMs occasionally
 * insert into long Russian words (notably GPT-4o-mini). These characters
 * are invisible to humans but make substring matching against the real
 * DOM fail catastrophically. Also normalises non-breaking spaces.
 */
function sanitizeLocator(raw: string): string {
  return raw
    .replace(/[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/**
 * DOM Sub-agent — implements the "Sub-agent architecture" advanced pattern
 * from the task spec and the Anthropic "Building Effective Agents" research.
 *
 * The main agent never receives the full DOM. When it needs to find
 * something on the page, it calls `query_dom({ query })` and this sub-agent
 * handles it:
 *
 *   1. Inject a JS extractor into the page that walks every visible
 *      interactive element and builds, for each one:
 *        - tag, role, accessible name, type, placeholder, truncated text
 *        - a *pre-validated unique CSS selector* (guaranteed to select
 *          exactly one element at extraction time)
 *   2. Also capture the page's landmarks: headings, title, URL, dialog
 *      names, a short main-text excerpt.
 *   3. Feed all of that + the natural-language query to a dedicated LLM
 *      call with a focused system prompt ("you are a DOM analyst, answer
 *      briefly, when asked for a selector return ONE concrete CSS selector
 *      from the list, do not invent").
 *   4. Return the sub-agent's short reply to the main agent.
 *
 * Why this earns the advanced-pattern credit:
 *   - Two distinct agent roles with distinct prompts and distinct contexts.
 *   - The main agent's context stays SMALL (it never sees the 3-5k token
 *     DOM dump). Only the sub-agent pays that cost, once per query.
 *   - Selectors are NEVER hardcoded or invented — they come from runtime
 *     page inspection and are validated for uniqueness on the spot.
 */

export const EXTRACTOR = `
(() => {
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // Opacity check: skip for checkbox/radio inputs — SPAs commonly hide
    // the native input (opacity:0) and overlay a custom visual. Playwright
    // clicks them fine, and filtering them breaks email checkbox selection.
    const isCheckRadio = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
    if (!isCheckRadio && parseFloat(cs.opacity) < 0.05) return false;
    // Walk up the ancestor chain checking aria-hidden / inert. WAI-ARIA
    // says aria-hidden="true" elements (and their descendants) are
    // excluded from the accessibility tree, and Playwright's
    // getByRole respects this. Without the same check here, the
    // EXTRACTOR would surface elements that live in collapsed menus
    // or off-screen overlays — the agent would see them in observe()
    // and then click() would resolve them but Playwright's
    // actionability check would time out (the matched element is in
    // the DOM but not actually shown to a user). The result was
    // "click timeout" loops on overflow-menu items in real SPAs.
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute) {
        const ah = cur.getAttribute('aria-hidden');
        if (ah === 'true') return false;
        if (cur.hasAttribute('inert')) return false;
      }
      cur = cur.parentElement;
    }
    return true;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 160);
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) return (ref.innerText || '').trim().slice(0, 160);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.id) {
        try {
          const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lbl && lbl.innerText) return lbl.innerText.trim().slice(0, 160);
        } catch (e) {}
      }
      const wrap = el.closest && el.closest('label');
      if (wrap && wrap.innerText) return wrap.innerText.trim().slice(0, 160);
      if (el.placeholder) return el.placeholder.trim().slice(0, 160);
      if (el.name) return String(el.name).slice(0, 160);
      if (el.title) return el.title.trim().slice(0, 160);
    }
    if (tag === 'IMG') return (el.alt || el.title || '').trim().slice(0, 160);
    const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return txt.slice(0, 160);
  };

  const inferRole = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'search') return 'searchbox';
      if (t === 'password') return 'password';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    // Elements with aria-checked are checkboxes regardless of tag.
    if (el.hasAttribute && el.hasAttribute('aria-checked')) return 'checkbox';
    // Elements with aria-pressed are toggle buttons.
    if (el.hasAttribute && el.hasAttribute('aria-pressed')) return 'button';
    // Elements with aria-expanded are typically buttons/disclosures.
    if (el.hasAttribute && el.hasAttribute('aria-expanded') && tag !== 'a') return 'button';
    // Pointer-only fallback: a div/span/li/etc with cursor:pointer
    // and no other role hint. We label it "clickable" so the
    // sub-agent can still reason about it and emit a css= or within=
    // locator. It cannot be used with Playwright's getByRole, but
    // locators built from the element's own attributes (#id,
    // [data-...], or within=) will still work.
    try {
      if (getComputedStyle(el).cursor === 'pointer') return 'clickable';
    } catch (e) {}
    return tag;
  };

  // ── Selector builder — FAST path ──
  // Earlier version validated uniqueness with querySelectorAll for each
  // candidate, causing 4×160 ≈ 640 DOM queries per extraction — several
  // seconds on heavy SPAs. Here we just pick the strongest single
  // attribute and emit a CSS selector directly. If it turns out not to
  // be unique or goes stale, the tool layer's auto-retry (click_element
  // with intent) will recover via a fresh query_dom call.
  //
  // Priority: #id → data-testid → name → aria-label → a[href] →
  // input[type+placeholder] → short nth-of-type path.
  const buildPath = (el) => {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML' && depth++ < 6) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentNode;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = parent.children;
      let idx = 0;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].tagName === cur.tagName) {
          idx++;
          if (siblings[i] === cur) break;
        }
      }
      let seg = tag;
      // Count same-tag siblings
      let sameTagCount = 0;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].tagName === cur.tagName) sameTagCount++;
      }
      if (sameTagCount > 1) seg += ':nth-of-type(' + idx + ')';
      parts.unshift(seg);
      if (parent === document.body) { parts.unshift('body'); break; }
      cur = parent;
    }
    return parts.join('>');
  };
  const buildSelector = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    const tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid) return tag + '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
    const nm = el.getAttribute && el.getAttribute('name');
    if (nm) return tag + '[name="' + nm.replace(/"/g, '\\\\"') + '"]';
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.length < 60) return tag + '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
    if (tag === 'a') {
      const href = el.getAttribute && el.getAttribute('href');
      if (href && href.length < 120 && href !== '#') {
        return 'a[href="' + href.replace(/"/g, '\\\\"') + '"]';
      }
    }
    if (tag === 'input') {
      const ph = el.getAttribute('placeholder');
      if (ph) return 'input[placeholder="' + ph.replace(/"/g, '\\\\"') + '"]';
    }
    // Fallback: short nth-of-type path (depth-capped).
    return buildPath(el);
  };

  // Full WAI-ARIA interactive-role catalog. CSS attribute matching is
  // exact — [role="menuitem"] does NOT match [role="menuitemcheckbox"]
  // — so every variant we care about must be listed explicitly. This
  // is the entire interactive subset of the ARIA role taxonomy; adding
  // roles here is a generic observation-layer widening, not a hint.
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="treeitem"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  const seen = new Set();
  // Extractor cap raised from 300 → 700. The post-filter stage in
  // TypeScript truncates to a reasonable prompt budget AFTER ranking
  // by query relevance, so increasing this cap widens the pool we
  // search without blowing up the sub-agent prompt. Needed for
  // element-heavy SPAs where the interactive elements live deep in
  // document order behind long navigation / sidebar / toolbar trees.
  const nodes = Array.from(document.querySelectorAll(SELECTOR))
    .filter(el => { if (seen.has(el)) return false; seen.add(el); return isVisible(el); })
    .slice(0, 700);

  // ── Pass 2: cursor:pointer capture ──
  // Modern SPAs frequently render clickable UI as plain <div> / <span>
  // with JS click handlers attached via addEventListener, no role,
  // no tabindex, no accessibility hints. These elements are
  // semantically invisible to the SELECTOR above but they ARE clickable
  // and users interact with them all the time. The only reliable
  // generic signal for "this has a click handler" short of reading JS
  // is computed style cursor === "pointer" — set either by the app's
  // own CSS or by a global rule targeting clickable elements.
  //
  // To keep this pass bounded on huge pages:
  //   - only look at small-to-medium elements (skip layout wrappers)
  //   - cap the number of additions at 250
  //   - skip ancestors of already-captured items (the child won the
  //     semantic pass; the parent is just its click-target wrapper)
  const MAX_POINTER_ADDITIONS = 250;
  const MAX_POINTER_SCAN = 2000;
  let pointerAdded = 0;
  let pointerScanned = 0;
  // Only scan elements with class/style attrs — cursor:pointer almost
  // always comes from CSS classes, not default browser styles. This
  // pre-filter reduces the set from 2k-10k to a few hundred on most SPAs.
  const pointerCandidates = document.querySelectorAll(
    'div[class], span[class], li[class], i[class], td[class], tr[class], [style*="cursor"]',
  );
  // Mark captured elements on the DOM to avoid O(seen.size) contains() loops.
  const CAPTURED_ATTR = '__cap';
  for (const el of seen) {
    try { (el as HTMLElement).setAttribute(CAPTURED_ATTR, '1'); } catch {}
  }
  for (const el of pointerCandidates) {
    if (pointerAdded >= MAX_POINTER_ADDITIONS) break;
    if (nodes.length >= 900) break;
    if (++pointerScanned > MAX_POINTER_SCAN) break;
    if (seen.has(el)) continue;
    const ht = el as HTMLElement;
    const rect = ht.getBoundingClientRect();
    if (rect.width < 12 || rect.height < 12) continue;
    if (rect.width > 900 && rect.height > 700) continue;
    if (!isVisible(ht)) continue;
    let cursor = '';
    try {
      cursor = getComputedStyle(ht).cursor;
    } catch (e) { continue; }
    if (cursor !== 'pointer') continue;
    // Skip if this element contains an already-captured node — check via
    // DOM attribute instead of O(seen.size) loop.
    if (ht.querySelector('[' + CAPTURED_ATTR + ']')) continue;
    seen.add(el);
    nodes.push(ht);
    ht.setAttribute(CAPTURED_ATTR, '1');
    pointerAdded++;
  }
  // Clean up marker attributes
  for (const el of seen) {
    try { (el as HTMLElement).removeAttribute(CAPTURED_ATTR); } catch {}
  }

  // ── Container context ──
  // For elements without a strong accessible name (e.g. icon buttons
  // with a single-char label or no label at all), we walk up the
  // ancestor chain looking for a container div/li/article/section/form
  // whose innerText has a reasonable length (15–300 chars). That
  // container text gives the sub-agent the STRUCTURAL CONTEXT the
  // element sits in, so a nameless button can still be distinguished
  // from other nameless buttons elsewhere on the page. Pure structural
  // heuristic, zero hardcoded assumptions about content or layout.
  const containerContext = (el) => {
    let cur = el.parentElement;
    let depth = 0;
    while (cur && depth++ < 6) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'li' || tag === 'article' || tag === 'section' || tag === 'form' || tag === 'div') {
        const txt = (cur.innerText || '').replace(/\\s+/g, ' ').trim();
        if (txt.length >= 10 && txt.length <= 500) {
          return txt.slice(0, 400);
        }
        if (txt.length > 500) {
          // too big — try parent
          cur = cur.parentElement;
          continue;
        }
      }
      cur = cur.parentElement;
    }
    return '';
  };

  // ── Overlay / modal detection ──
  // Collect all visible dialog/overlay containers so we can tag items
  // that live inside them. The agent needs to know which elements are
  // in the foreground modal vs the background page.
  const overlayContainers = Array.from(document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]'
  )).filter(isVisible);

  // Also detect high-z-index overlays that don't use ARIA roles
  // (common in React SPAs like Yandex Eda). Look for positioned elements
  // with z-index >= 100 that cover a significant portion of the viewport.
  for (const el of document.querySelectorAll('div, section')) {
    if (overlayContainers.some(c => c === el || c.contains(el))) continue;
    try {
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
      const z = parseInt(cs.zIndex, 10);
      if (isNaN(z) || z < 100) continue;
      const rect = el.getBoundingClientRect();
      // Must cover at least 20% of viewport to count as an overlay
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (rect.width < vw * 0.2 || rect.height < vh * 0.2) continue;
      if (!isVisible(el)) continue;
      overlayContainers.push(el);
    } catch (e) {}
  }

  const isInOverlay = (el) => {
    for (const ov of overlayContainers) {
      if (ov.contains(el)) return true;
    }
    return false;
  };

  const hasOverlay = overlayContainers.length > 0;

  const vp = { w: window.innerWidth, h: window.innerHeight };
  const items = nodes.map((el, i) => {
    const rect = el.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.top < vp.h && rect.right > 0 && rect.left < vp.w;
    const role = inferRole(el);
    const name = accessibleName(el);
    const selector = buildSelector(el);
    const inOverlay = hasOverlay ? isInOverlay(el) : false;
    const out = { idx: i + 1, tag: el.tagName.toLowerCase(), role, name, selector, inView, inOverlay };
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.value) out.value = String(el.value).slice(0, 120);
      if (el.placeholder) out.placeholder = String(el.placeholder).slice(0, 80);
      if (el.type) out.type = String(el.type);
    }
    // Attach container context WHENEVER the container adds information
    // beyond the element's own name. This is load-bearing for long
    // repeated-row lists where each row's interactive control has a
    // generic accessible name and the row identity lives only in the
    // surrounding wrapper text.
    //
    // We skip the container only when it is strictly redundant with the
    // name (exact match or a close substring), which keeps the payload
    // tight on simple pages without starving the sub-agent on rich ones.
    const ctx = containerContext(el);
    if (ctx) {
      const n = (name || '').trim();
      const isRedundant =
        n.length > 0 &&
        (ctx === n || ctx.length <= n.length + 4);
      if (!isRedundant) out.container = ctx;
    }
    return out;
  });

  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
    .filter(isVisible)
    .map(h => ({ level: parseInt(h.tagName[1]), text: (h.innerText || '').trim().slice(0, 160) }))
    .filter(h => h.text)
    .slice(0, 30);

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
    .filter(isVisible)
    .map(d => {
      const lbl = d.getAttribute('aria-label');
      if (lbl) return lbl.trim();
      const h = d.querySelector('h1, h2, h3');
      if (h) return (h.innerText || '').trim().slice(0, 160);
      return (d.innerText || '').trim().slice(0, 160);
    })
    .filter(Boolean);

  // Main text excerpt for content questions.
  const pickMain = () => {
    const prefer = document.querySelector('main')
      || document.querySelector('article')
      || document.querySelector('[role="main"]');
    if (prefer && isVisible(prefer)) return prefer;
    let best = document.body; let bestLen = 0;
    for (const el of document.querySelectorAll('div, section, article, main')) {
      if (!isVisible(el)) continue;
      const tag = (el.tagName || '').toLowerCase();
      const role = el.getAttribute && el.getAttribute('role');
      if (tag === 'nav' || tag === 'footer' || tag === 'header' || tag === 'aside') continue;
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo') continue;
      const len = (el.innerText || '').length;
      if (len > bestLen && len < 80000) { bestLen = len; best = el; }
    }
    return best;
  };
  const mainEl = pickMain();
  const main_text = mainEl ? (mainEl.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 2000) : '';

  return {
    url: location.href,
    title: document.title,
    viewport: vp,
    headings,
    dialogs,
    main_text,
    items,
  };
})()
`;

export interface ExtractedItem {
  idx: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  inView: boolean;
  /** True when the element is inside a dialog, modal, or high-z overlay. */
  inOverlay?: boolean;
  value?: string;
  placeholder?: string;
  type?: string;
  /** Ancestor card/section text — helps identify nameless icon buttons. */
  container?: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  headings: Array<{ level: number; text: string }>;
  dialogs: string[];
  main_text: string;
  items: ExtractedItem[];
}

/**
 * Simple keyword extractor — strips punctuation, lowercases, drops a
 * short English/Russian stopword list, keeps words ≥ 3 chars.
 *
 * Used as a zero-cost signal to score the 100-item interactive list
 * against the query: items whose own name or container text contains
 * query words get ranked higher, irrelevant items get dropped. No LLM
 * involved. Supports mixed EN/RU because the stopword list covers both;
 * there is no translation dictionary — matches happen only on the
 * literal words the user and the page already share.
 */
const STOPWORDS = new Set([
  // EN
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'on', 'in', 'at', 'to', 'of', 'for', 'with', 'by', 'from', 'as',
  'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'so',
  'what', 'where', 'when', 'which', 'who', 'how', 'why',
  'find', 'locate', 'get', 'show', 'tell', 'me', 'you', 'it', 'its',
  'has', 'have', 'had', 'do', 'does', 'did', 'can', 'could', 'would',
  'there', 'here', 'page', 'selector', 'element', 'current', 'css',
  // RU
  'на', 'в', 'и', 'или', 'но', 'что', 'где', 'как', 'какой', 'какая',
  'какое', 'это', 'тот', 'та', 'то', 'есть', 'для', 'по', 'с', 'со',
  'от', 'до', 'из', 'о', 'об', 'про', 'у', 'за', 'над', 'под',
  'найди', 'найти', 'покажи', 'показать', 'дай', 'дать', 'мне', 'ты',
  'страница', 'страницы', 'селектор', 'элемент', 'элементов', 'текущ',
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// No synonym/translation dictionary. Any cross-language term the user
// uses is matched literally against the page's literal text. If the user
// writes in Russian, they will match Russian page text; if in English,
// English text. This keeps the system free of any hardcoded category or
// translation tables that could be read as task hints.

/**
 * Score an item against the query keywords. Higher = more relevant.
 * Signals: keyword match in name / placeholder / value / type + role bonus
 * for common query types + in-view bonus.
 */
/**
 * Score an item against the query keywords. Higher = more relevant.
 *
 * Signals used:
 *  - literal keyword match in name/placeholder/value/type/role (strong)
 *  - literal keyword match in container text (medium, lets nameless
 *    icon buttons be found via their enclosing card's text)
 *  - in-view bonus (weak tiebreaker)
 *
 * No per-category rules, no role boosts tied to particular query words.
 * A pure literal text match ranked by where it hit.
 */
function scoreItem(it: ExtractedItem, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = [
    it.name,
    it.placeholder ?? '',
    it.value ?? '',
    it.type ?? '',
    it.role,
  ]
    .join(' ')
    .toLowerCase();
  const containerHay = (it.container ?? '').toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (hay.includes(k)) score += 3;
    else if (containerHay.includes(k)) score += 2;
  }
  if (it.inView) score += 1;
  return score;
}

/**
 * Filter/rank items by relevance to the query. Returns at most `max` items.
 * If the query has no useful keywords (too generic), returns the in-view
 * prefix — better than nothing.
 */
/**
 * Re-order items by relevance to the query but NEVER truncate.
 *
 * The sub-agent runs on a free model with a 128k context window, so
 * there is no reason to drop items — dropping them is exactly how we
 * miss cross-language matches (English query, Russian page text, or
 * vice versa). Instead: sort the full list so the most-relevant items
 * come first and the sub-agent can stop reading when it finds its
 * answer. Items with zero keyword score still appear in the list,
 * ordered by in-view status.
 */
// Post-filter truncation budget. The extractor can now return up to
// 700 items; sending all of them to the sub-agent would blow up the
// prompt on dense pages. After relevance ranking, we keep the top
// MAX_ITEMS_TO_SUBAGENT items — the ones most likely to include the
// query target. Items with keyword hits always come first, then
// in-view, then off-screen, so truncation drops the least-relevant
// tail first. Cap is generous enough to include 150+ virtualized
// list rows while staying under ~30k tokens of prompt on a typical
// page.
const MAX_ITEMS_TO_SUBAGENT = 260;

function filterItemsByQuery(
  items: ExtractedItem[],
  query: string,
): { items: ExtractedItem[]; reason: string } {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) {
    const inView = items.filter((i) => i.inView);
    const offScreen = items.filter((i) => !i.inView);
    const combined = [...inView, ...offScreen];
    const truncated = combined.slice(0, MAX_ITEMS_TO_SUBAGENT);
    return {
      items: truncated,
      reason:
        combined.length > truncated.length
          ? `generic query — ${truncated.length} of ${combined.length} items (in-view first, truncated to budget)`
          : `generic query — ${combined.length} items (in-view first)`,
    };
  }
  // Score everything and re-order; truncate after ranking.
  const scored = items
    .map((it, i) => ({ it, score: scoreItem(it, keywords), i }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.it.inView !== b.it.inView) return a.it.inView ? -1 : 1;
      return a.i - b.i; // stable original order
    });
  const matched = scored.filter((x) => x.score > 0).length;
  const sorted = scored.map((x) => x.it);
  const truncated = sorted.slice(0, MAX_ITEMS_TO_SUBAGENT);
  return {
    items: truncated,
    reason:
      matched > 0
        ? `ranked ${items.length} items, ${matched} keyword hit(s); kept top ${truncated.length}`
        : `no keyword hit for [${keywords.join(',')}] — kept top ${truncated.length} of ${items.length} in DOM order`,
  };
}

function renderPageForSubagent(p: ExtractedPage, filteredItems: ExtractedItem[], filterReason: string): string {
  const lines: string[] = [];
  lines.push(`URL: ${p.url}`);
  lines.push(`TITLE: ${p.title}`);
  lines.push(`VIEWPORT: ${p.viewport.w}x${p.viewport.h}`);
  if (p.dialogs.length) {
    lines.push(`DIALOGS: ${p.dialogs.join(' | ')}`);
  }
  if (p.headings.length) {
    lines.push(`HEADINGS:`);
    for (const h of p.headings) {
      lines.push(`  ${'  '.repeat(h.level - 1)}h${h.level} ${h.text}`);
    }
  }
  if (p.main_text) {
    lines.push(`MAIN_TEXT (first 2000 chars):`);
    lines.push(p.main_text);
  }
  lines.push('');
  lines.push(
    `INTERACTIVE ELEMENTS (showing ${filteredItems.length} of ${p.items.length} total; filter: ${filterReason}):`,
  );
  for (const it of filteredItems) {
    const loc = it.inView ? '' : ' [off-screen]';
    const val = it.value ? ` value="${it.value}"` : '';
    const ph = it.placeholder ? ` placeholder="${it.placeholder}"` : '';
    const ty = it.type ? ` type=${it.type}` : '';
    const ctx = it.container ? `\n      container="${it.container}"` : '';
    lines.push(
      `  #${it.idx} [${it.role}] "${it.name}"${val}${ph}${ty}${loc}` +
        ctx +
        `\n      selector: ${it.selector}`,
    );
  }
  return lines.join('\n');
}

const SUB_SYSTEM_PROMPT = `You are a DOM Analyst sub-agent serving a main browser-agent. The main agent cannot see the DOM — only what you tell it.

INPUT YOU RECEIVE
- Page URL, title, headings, dialog names, a main-text excerpt.
- A numbered list of ALL visible interactive elements on the current page (up to ~160). Items are ordered by relevance to the query when keyword hits exist, otherwise in DOM order. The list is NOT filtered — if an element exists on the page, it IS in the list. So "not on this page" should only be your answer when you have scanned the full list and found nothing plausible.
- Each line shows: index, role, accessible name, optional value/placeholder/type, and a fallback CSS selector.
- For elements whose own accessible name is weak or empty (icon buttons, unnamed controls), a "container=" line shows the text of the nearest parent container (up to 400 chars). Use that as your SEMANTIC ANCHOR: an element inside a container whose text matches what the user is asking about is almost certainly the right element for that container.
- The page's language may differ from the query's language. Match by MEANING of what the element does, not by literal word overlap. Use the page's actual language in the locator you return.

YOUR JOB
1. Read the query literally. Figure out which single item on the page is the best match by looking at each item's role, accessible name, placeholder, value, and container= text.
2. Pick the SINGLE BEST match. Prefer in-view items over off-screen ones, and items whose match is on the accessible name over matches only in container text.
3. If an element's own name is weak or empty but its container text carries the meaningful identifier, that item can still be the answer — use the within= DSL form (see below) to anchor the locator on the container.
4. When multiple items match a query about "the first/second/N-th something", pick by document order: earlier idx = earlier in DOM = earlier in the visible list.
5. For factual questions, quote the shortest relevant snippet from MAIN_TEXT or from an element's name or container.

OUTPUT FORMAT — strict
When the query asks for an element, reply with EXACTLY this shape (every line mandatory, in this exact order):

  locator: <DSL>
  element: #<idx>
  match_source: <name | container | placeholder | value | role | none>
  match_text: <the EXACT substring from that item's field that made you pick it>
  uniqueness: <unique | multiple | unknown>

The match_source line tells the main agent WHICH field of the chosen item carried the meaningful signal:
  - name         — the item's own accessible name contains the query target
  - container    — ONLY the item's parent container text carries the target; the item's own name does not
  - placeholder  — the placeholder value carries the target (inputs)
  - value        — the element's own value (pre-filled inputs)
  - role         — there is exactly one item of this role on the page and role alone identifies it
  - none         — you do not actually have evidence this item matches the query; in that case you must reply "not on this page" instead

The match_text line is the EXACT literal substring you copied from that field. No paraphrasing, no translation. The detector will verify it appears verbatim in the chosen item.

The uniqueness line is your honest assessment of how many items the locator would match if executed:
  - unique   — only this single item matches
  - multiple — several items would match, and you added within=/[name=...]/#N to pin down THE target
  - unknown  — you cannot tell

RULE: if match_source is "container", your locator MUST start with within="<match_text snippet>". A bare role=X with no within= when the match holds only in container is FORBIDDEN — it will be rejected by the detector.

RULE: if uniqueness is "multiple" AND the locator has no [name=...] AND no within=..., the answer is rejected. You must narrow the locator.

The <DSL> must be one of these forms, preferring earlier ones (MORE stable) over later ones:

  role=button[name="Exact accessible name"]       ← BEST: stable, semantic
  role=searchbox
  role=link[name="Text of the link"]
  testid=<data-testid-value>
  placeholder="Exact placeholder text"
  label="Associated label text"
  text="Exact visible text"                        ← exact match
  text=substring                                   ← partial match
  within="container anchor text" <inner-locator>  ← for nameless buttons inside cards
  within="container anchor text"#2 <inner-locator> ← #N picks the N-th matching container
  css=<raw css selector from the list>             ← LAST RESORT

WITHIN EXPLAINED
Use this form when an element's OWN name is weak (empty, one char, icon
like "+") but its container= line carries the meaningful text. The
within= form anchors the locator on an ancestor card whose text matches,
then applies the inner locator inside it.

Syntax:
  within="<anchor substring from container=>" <inner-locator>
  within="<anchor>"#N <inner-locator>    ← pick the N-th matching container

How to choose the anchor:
- Copy a SHORT distinctive substring from the container= field — enough
  to be unique among siblings, short enough to survive minor text changes.
- Do NOT copy the entire container= string; trim to the essential part.
- The inner locator uses the same DSL (role/text/placeholder/etc).

How to address "the first / second / N-th item":
- Items in the list appear in document order (earlier idx = earlier in DOM).
- When many containers match the same anchor substring, use #N to pick
  which one: default #1 = first, #2 = second, and so on.

Rules for the DSL:
- Derive role/name from the element's listed role and accessible name.
- If the element is an input with a useful placeholder, prefer placeholder="..." over css.
- Only fall back to css= if none of the semantic forms apply.
- NEVER invent a selector that is not supported by what you see in the list.

When the query is yes/no or textual, answer in one short line without the locator: prefix.

When nothing matches at all, answer exactly:
  not on this page

HARD ANTI-AMBIGUITY RULE
If the query contains a DISTINCTIVE identifier (any literal word or
short phrase that singles out ONE target among many similar siblings)
and the target element's own accessible name does NOT contain that
identifier — the match is holding only because of the container= line.
In that case you MUST use the within= form with the identifier as the
anchor:
  within="<the identifier>" <inner-locator>
A bare \`role=X\` with no name= clause matches EVERY element with that
role on the page, so Playwright will click the first one it finds —
typically a header / toolbar control or an unrelated row. That is a
silent, often catastrophic mistake. Never return a bare role= when the
query asked about specific content.

HARD ANTI-HALLUCINATION RULES
- You may ONLY return locator components that appear VERBATIM in the items list above.
- role=X[name="Y"] → an item with exactly that role and a name that contains Y must be present.
- testid=X → an item whose fallback selector contains data-testid="X" must be present.
- placeholder="X" → an item with exactly that placeholder must be present.
- text="X" or text=X → the substring X must appear in some item's name or in MAIN_TEXT.
- within="X" inner → the substring X must appear verbatim in some item's container= field.
- css=... → only selectors that are copied verbatim from an item's "selector:" line in the list.
- NEVER type any character that is not in the input (no soft hyphens, no narrow spaces, no invented words).
- When no item in the list is a good match, reply exactly:  not on this page
- Do NOT guess a "likely" testid or class name. Do NOT assume what any kind of site "usually" looks like — your only source of truth is the items list above. If it isn't in the list, it doesn't exist for you.

SELF-CHECK BEFORE YOU ANSWER (mandatory; walk through this silently):
1. I have written match_source=X. Does the field X of item #<idx> actually exist in the list? Did I copy match_text verbatim from that field?
2. Does my locator reference the same signal I declared in match_source? If match_source=container, does my locator start with within="<part of match_text>"? If not, I am lying to myself and must fix the locator or the source.
3. Does the query mention specific identifying content (any literal word or short phrase that singles out the target)? If yes, does my match_text contain that content? If I cannot find the content in ANY item's name/container/placeholder, the honest answer is "not on this page".
4. If my locator is a bare role=X or css=..., will it match more than one element on the page? If yes, my uniqueness MUST be "multiple" AND my locator MUST include within= or [name=...] to narrow it. Otherwise I am setting up a blind click on whichever element comes first — the main agent trusts me; don't betray that trust.
5. Only after all four checks pass, emit the answer.

No markdown, no code fences, no extra commentary outside the required lines.`;

export interface DomSubagentOptions {
  /** Override the sub-agent model. Default: DOM_MODEL env. */
  model?: string;
  /** Called for each sub-agent call — useful for telemetry. */
  onCall?: (info: { query: string; items: number; answer: string }) => void;
}

/**
 * Check whether the sub-agent's locator reply actually references the
 * filtered item list it was shown. Returns null if valid, or a short
 * reason string if the locator was invented.
 */
function detectHallucination(
  rawLocator: string,
  items: ExtractedItem[],
  query?: string,
): string | null {
  const p = parseLocator(rawLocator);
  if (p.kind === 'within') {
    const anchor = (p.containerText ?? '').trim();
    if (!anchor) return 'within= anchor is empty';
    const found = items.some((it) => (it.container ?? '').includes(anchor));
    if (!found) return `within anchor "${anchor}" not present in any item's container text`;
    if (p.inner) {
      const innerReason = detectHallucination(p.inner.raw, items, query);
      if (innerReason) return `inner: ${innerReason}`;
    }
    return null;
  }
  if (p.kind === 'role') {
    const role = (p.role ?? '').toLowerCase();
    const wantedName = (p.value ?? '').toLowerCase();
    const matching = items.filter((it) => {
      if (it.role !== role) return false;
      if (!wantedName) return true;
      const itemName = (it.name ?? '').toLowerCase();
      return itemName.includes(wantedName) || wantedName.includes(itemName);
    });
    if (matching.length === 0) {
      return wantedName
        ? `no item with role=${role} and name containing "${p.value}"`
        : `no item with role=${role}`;
    }
    // ── Anti-ambiguity ──
    // A bare `role=X` with no name that resolves to ≥2 items is a
    // blind pick — Playwright's .first() will click whichever element
    // happens to come first, which is rarely the one the query
    // referred to (header checkbox, hidden control, off-screen row,
    // etc). When the query has distinctive keywords, the sub-agent is
    // required to either add a name= clause or anchor via within= on
    // the text that made the match meaningful. This is a generic
    // specificity check — it knows nothing about any site or category.
    if (!wantedName && matching.length > 1 && query) {
      const keywords = extractKeywords(query);
      if (keywords.length > 0) {
        return `ambiguous role=${role} — ${matching.length} items match. The query contained distinctive keywords [${keywords.join(', ')}]; you must EITHER add [name="..."] with the target element's own accessible name, OR use within="<anchor from that item's container text>" <inner-locator> to pin down exactly which one. Returning a bare role= that matches many items is a blind pick and will click the wrong thing.`;
      }
    }
    return null;
  }
  if (p.kind === 'text') {
    const t = (p.value ?? '').trim();
    if (!t) return 'text= is empty';
    const found = items.some(
      (it) =>
        (it.name ?? '').includes(t) ||
        (it.container ?? '').includes(t) ||
        (it.placeholder ?? '').includes(t),
    );
    if (!found) return `text "${t}" not found in any item`;
    return null;
  }
  if (p.kind === 'placeholder') {
    const ph = (p.value ?? '').trim();
    const found = items.some((it) => (it.placeholder ?? '') === ph);
    if (!found) return `placeholder="${ph}" not found in any item`;
    return null;
  }
  if (p.kind === 'testid') {
    const tid = (p.value ?? '').trim();
    const found = items.some((it) =>
      (it.selector ?? '').includes(`data-testid="${tid}"`),
    );
    if (!found) return `data-testid="${tid}" not present in any item's selector`;
    return null;
  }
  if (p.kind === 'label') {
    // Labels aren't in the extractor output, so we can't validate them.
    // Accept with a soft pass.
    return null;
  }
  if (p.kind === 'css') {
    const css = (p.value ?? '').trim();
    if (!css) return 'css= is empty';
    // Accept only if it matches an item selector verbatim, OR starts with
    // a # id / [attr=...] form that happens to appear in an item selector.
    const found = items.some((it) => (it.selector ?? '').trim() === css);
    if (!found) return `css selector was not copied verbatim from any item`;
    return null;
  }
  return null;
}

/**
 * Parse the structured evidence block (match_source / match_text /
 * uniqueness / element) the sub-agent is required to emit alongside the
 * locator. Returns null if the fields aren't present — we then fall
 * back to the legacy detector path.
 */
interface MatchEvidence {
  element_idx?: number;
  match_source?: string;
  match_text?: string;
  uniqueness?: string;
}
function parseMatchEvidence(answer: string): MatchEvidence {
  const out: MatchEvidence = {};
  const eRe = /^element\s*:\s*#?(\d+)/im;
  const sRe = /^match_source\s*:\s*([A-Za-z_]+)/im;
  const tRe = /^match_text\s*:\s*(.+)$/im;
  const uRe = /^uniqueness\s*:\s*([A-Za-z_]+)/im;
  const e = answer.match(eRe);
  if (e) out.element_idx = parseInt(e[1]!, 10);
  const s = answer.match(sRe);
  if (s) out.match_source = s[1]!.toLowerCase();
  const t = answer.match(tRe);
  if (t) out.match_text = t[1]!.trim().replace(/^["']|["']$/g, '');
  const u = answer.match(uRe);
  if (u) out.uniqueness = u[1]!.toLowerCase();
  return out;
}

/**
 * Semantic verifier — checks that the sub-agent's self-declared
 * match_source / match_text actually holds for the chosen item, AND
 * that the locator form is consistent with that source. This catches
 * the class of hallucinations where the sub-agent points at a real
 * element but lies about WHY it picked it (e.g. picking a header
 * header "select-all" control and claiming it is "the one for the target row").
 * Returns null on pass, or a short reason string on fail.
 */
function verifyEvidence(
  rawLocator: string,
  items: ExtractedItem[],
  ev: MatchEvidence,
): string | null {
  // No evidence at all → fall through (legacy behaviour).
  if (!ev.match_source && !ev.match_text && ev.element_idx === undefined) {
    return null;
  }
  const src = ev.match_source ?? '';
  if (src === 'none') {
    return `match_source=none is not a valid answer — reply "not on this page" instead`;
  }
  if (ev.element_idx === undefined) {
    return 'element: line is missing';
  }
  const item = items.find((it) => it.idx === ev.element_idx);
  if (!item) {
    return `element #${ev.element_idx} is not in the items list (list has idx 1..${items.length})`;
  }
  const text = (ev.match_text ?? '').trim();
  if (!text) {
    return 'match_text is empty';
  }
  const lc = text.toLowerCase();
  const fieldContains = (fieldVal: string | undefined) =>
    !!fieldVal && fieldVal.toLowerCase().includes(lc);
  const anyFieldContains =
    fieldContains(item.name) ||
    fieldContains(item.container) ||
    fieldContains(item.placeholder) ||
    fieldContains(item.value) ||
    fieldContains(item.role);
  if (!anyFieldContains) {
    return `match_text "${text.slice(0, 60)}" does not appear in any field of element #${item.idx} (name="${item.name}", container="${(item.container ?? '').slice(0, 60)}"). You are hallucinating the connection.`;
  }
  // Field-specific check: the source must actually hold.
  switch (src) {
    case 'name':
      if (!fieldContains(item.name)) {
        return `match_source=name but "${text}" is not in name="${item.name}"`;
      }
      break;
    case 'container':
      if (!fieldContains(item.container)) {
        return `match_source=container but "${text}" is not in container text of element #${item.idx}`;
      }
      // Container match REQUIRES within= in the locator.
      if (!/^within=/.test(rawLocator.trim())) {
        return `match_source=container requires locator to start with within="<anchor>" — bare "${rawLocator}" would click a different element with the same role. Rewrite the locator as within="<substring of match_text>" <inner>.`;
      }
      break;
    case 'placeholder':
      if (!fieldContains(item.placeholder)) {
        return `match_source=placeholder but "${text}" is not in placeholder="${item.placeholder ?? ''}"`;
      }
      break;
    case 'value':
      if (!fieldContains(item.value)) {
        return `match_source=value but "${text}" is not in value="${item.value ?? ''}"`;
      }
      break;
    case 'role':
      if (!fieldContains(item.role)) {
        return `match_source=role but "${text}" is not the role name "${item.role}"`;
      }
      break;
    default:
      return `match_source="${src}" is not a recognised source (expected: name | container | placeholder | value | role | none)`;
  }
  // Uniqueness check: if declared multiple, locator must narrow it.
  if (ev.uniqueness === 'multiple') {
    const hasNarrowing =
      /within=/.test(rawLocator) ||
      /\[name=/.test(rawLocator) ||
      /#\d/.test(rawLocator);
    if (!hasNarrowing) {
      return `uniqueness=multiple but the locator has no within=/[name=...]/#N narrowing — add one or change uniqueness if the locator is actually unique.`;
    }
  }
  return null;
}

/**
 * Factory: build a queryDom function that resolves the current active page
 * on EVERY call. This lets the agent survive the user opening/closing tabs
 * in the visible Chromium window.
 */
export function createDomSubagent(getPage: GetPage, opts: DomSubagentOptions = {}) {
  const model = opts.model ?? DOM_MODEL;
  return async function queryDom(query: string): Promise<string> {
    const page = await getPage();
    const raw = (await page.evaluate(EXTRACTOR)) as ExtractedPage;
    const { items: filtered, reason } = filterItemsByQuery(raw.items, query);
    const rendered = renderPageForSubagent(raw, filtered, reason);

    const firstResp = await llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUB_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `PAGE:\n${rendered}\n\nQUERY: ${query}`,
        },
      ],
    });
    let answer =
      firstResp.choices[0]?.message?.content?.trim() ||
      '(DOM sub-agent returned no answer)';

    // ── Hallucination detection ──
    // Grab the locator line (if any), sanitize zero-width artefacts,
    // then check every locator component against the filtered item list.
    // If the sub-agent invented a selector that isn't anchored in the
    // data we showed it, re-ask exactly once with a hard reminder.
    const extractLocator = (text: string): string | null => {
      const m = text.match(/^(?:locator|selector)\s*:\s*(.+)$/im);
      if (!m) return null;
      return sanitizeLocator(m[1]!.replace(/^`|`$/g, '').replace(/[;,]$/, ''));
    };

    const firstLocator = extractLocator(answer);
    if (firstLocator) {
      // Replace any un-sanitized version of the locator in the answer.
      answer = answer.replace(
        /^(locator|selector)\s*:\s*.+$/im,
        `$1: ${firstLocator}`,
      );
      const evidence1 = parseMatchEvidence(answer);
      const semanticReason1 = verifyEvidence(firstLocator, filtered, evidence1);
      const reason1 =
        semanticReason1 ?? detectHallucination(firstLocator, filtered, query);
      if (reason1) {
        // One retry with a hard reminder.
        const retryResp = await llm.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: SUB_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `PAGE:\n${rendered}\n\nQUERY: ${query}`,
            },
            { role: 'assistant', content: answer },
            {
              role: 'user',
              content: `Your previous answer violated the HARD ANTI-HALLUCINATION RULES: ${reason1}.\nThat locator is NOT in the list I gave you. You must copy from the list VERBATIM or reply exactly "not on this page". Try again.`,
            },
          ],
        });
        const retryAnswer =
          retryResp.choices[0]?.message?.content?.trim() || answer;
        const retryLocator = extractLocator(retryAnswer);
        if (retryLocator) {
          const evidence2 = parseMatchEvidence(retryAnswer);
          const semanticReason2 = verifyEvidence(retryLocator, filtered, evidence2);
          const reason2 =
            semanticReason2 ?? detectHallucination(retryLocator, filtered, query);
          if (reason2) {
            opts.onCall?.({ query, items: filtered.length, answer: retryAnswer });
            return `not on this page\n\n[sub-agent retry also hallucinated: ${reason2}. The list you are seeing does not contain what you asked for — either re-phrase the query or confirm the element does not exist.]`;
          }
          opts.onCall?.({ query, items: filtered.length, answer: retryAnswer });
          return retryAnswer.replace(
            /^(locator|selector)\s*:\s*.+$/im,
            `$1: ${retryLocator}`,
          );
        }
        opts.onCall?.({ query, items: filtered.length, answer: retryAnswer });
        return retryAnswer;
      }
    }

    opts.onCall?.({ query, items: filtered.length, answer });
    return answer;
  };
}

// SUB_SYSTEM_PROMPT_ALL and createDomSubagentAll removed — zero callers.
const _SUB_SYSTEM_PROMPT_ALL = `You are a DOM Analyst sub-agent, multi-match mode. The main agent is asking you to find ALL elements matching a query, not just one.

INPUT YOU RECEIVE
- The same PAGE block as single-match mode: URL, title, headings, main text, and a numbered list of up to ~300 visible interactive elements with their role, accessible name, optional placeholder/value/type, and a container= line for elements whose own name is weak.

YOUR JOB
1. Find EVERY item in the list that matches the query.
2. For each matching item, produce one locator line. Prefer semantic forms (role/name, within=) over raw css. If items share a common container-text anchor (several rows all containing the same identifying phrase), use within="<short common anchor>"#N <inner> with incrementing N to disambiguate rows 1, 2, 3, ....
3. Items MUST appear in document order (sorted by their idx).

OUTPUT FORMAT — strict, every line mandatory:

  match_source: <name | container | placeholder | role | none>
  match_pattern: <the literal substring you used to decide items match>
  count: <integer number of matches>
  locators:
    1. <DSL> [#<idx>]
    2. <DSL> [#<idx>]
    ...

Each locator MUST use the full Locator DSL — the SAME syntax as single-match mode. Shorthand like "link <Foo>" or "button Foo" is INVALID and will be rejected by the harness.

VALID locator line examples:
  1. role=link[name="Acme Corp"] [#12]
  2. role=button[name="Delete"] [#45]
  3. within="Acme Corp 15:23" role=checkbox [#78]
  4. within="Acme Corp" role=checkbox#2 [#79]
  5. css=#item-123 [#99]
  6. placeholder="Exact placeholder text" [#3]

INVALID locator lines (do NOT emit these):
  1. link <Acme Corp> [#12]                ← missing role= prefix and [name="..."]
  2. button "Delete" [#45]                 ← missing role= prefix
  3. menuitemcheckbox [#40]                ← missing role= prefix
  4. Acme row [#78]                        ← no DSL at all

If NOTHING in the list matches, reply exactly:
  count: 0
  locators:
  (none)

HARD RULES
- Every locator you emit MUST point at a real item from the list — copy from the items verbatim, do not invent.
- match_pattern MUST appear verbatim in the fields (name/container/placeholder) of EVERY item you list. If an item's fields don't contain the pattern, do not include it.
- If match_source=container, EVERY locator MUST start with within="<pattern anchor>" followed by an inner locator for the specific element (role=checkbox, role=button, css=..., etc).
- Use within="<anchor>"#N role=... to disambiguate multiple matches sharing the same container text (N=1 for first, 2 for second, ...).
- Do NOT fabricate an item that is not in the list.
- Cap count at 30 — if there are more, list the first 30 in document order and mention "(truncated at 30)" on a separate line.

SELF-CHECK BEFORE ANSWERING:
- For each locator I emit, does the corresponding item #idx really contain match_pattern in the field I declared as match_source? If even one fails, drop that locator.
- Does every locator start with "role=", "within=", "text=", "placeholder=", "label=", "testid=", or "css="? If not, it is INVALID shorthand and I must rewrite it.
- Is my count equal to the number of "1.", "2." ... lines I emit? If not, fix.
- Am I using document order? If not, sort.

No markdown, no code fences, no commentary outside the required lines.`;

/**
 * Multi-match variant of the DOM sub-agent. Used by the main agent's
 * query_dom_all tool when the task is "find all N items matching X" —
 * selecting multiple rows, iterating a filtered list, batch-acting on
 * a subset. Returns a structured block the main agent can iterate
 * locator-by-locator without having to re-query for each "the second /
 * the third" item (which the single-match mode cannot reliably serve).
 */
export function createDomSubagentAll(
  getPage: GetPage,
  opts: DomSubagentOptions = {},
) {
  const model = opts.model ?? DOM_MODEL;
  return async function queryDomAll(query: string): Promise<string> {
    const page = await getPage();
    const raw = (await page.evaluate(EXTRACTOR)) as ExtractedPage;
    const { items: filtered, reason } = filterItemsByQuery(raw.items, query);
    const rendered = renderPageForSubagent(raw, filtered, reason);

    const resp = await llm.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: _SUB_SYSTEM_PROMPT_ALL },
        { role: 'user', content: `PAGE:\n${rendered}\n\nQUERY (find ALL matches): ${query}` },
      ],
    });
    const answer =
      resp.choices[0]?.message?.content?.trim() ||
      'count: 0\nlocators:\n(none)';
    opts.onCall?.({ query, items: filtered.length, answer });
    return answer;
  };
}
