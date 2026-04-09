import type { Page, Locator } from 'playwright';

/**
 * Rich locator DSL.
 *
 * The DOM sub-agent returns one of these forms; `resolveLocator` converts
 * it into a Playwright Locator. This gives the main agent access to
 * Playwright's semantic locators (getByRole / getByText / getByPlaceholder /
 * getByLabel / getByTestId) which are dramatically more resilient to
 * React re-renders and dynamic class names than bare CSS selectors.
 *
 * Supported forms:
 *
 *   role=button
 *   role=button[name="Добавить в корзину"]
 *   role=searchbox
 *   text="Exact button label"      (exact match)
 *   text=substring match           (partial)
 *   placeholder="Найти в Лавке"
 *   label="Email"
 *   testid=search-input
 *   css=.some-class > .inner       (explicit CSS)
 *   #id-or-raw-css-selector        (bare = CSS fallback)
 *
 * Preference order the sub-agent is instructed to follow (most stable
 * first):
 *   role  >  testid  >  label  >  placeholder  >  text  >  css
 *
 * Why this matters: on modern SPAs, raw CSS selectors built from
 * auto-generated class names or nth-of-type paths break after every
 * re-render. role / text / testid stay stable because they come from
 * accessibility semantics, not from implementation hashes.
 */

export type LocatorKind =
  | 'role'
  | 'text'
  | 'placeholder'
  | 'label'
  | 'testid'
  | 'css'
  | 'within';

export interface ParsedLocator {
  kind: LocatorKind;
  raw: string;
  /** Role name for kind=role. */
  role?: string;
  /** Name / accessible name for kind=role, or the value for other kinds. */
  value?: string;
  /** For kind=text: whether this was written as text="..." (exact) vs text=... (partial). */
  exact?: boolean;
  /** For kind=within: the container text to match. */
  containerText?: string;
  /** For kind=within: the inner locator expression (recursive). */
  inner?: ParsedLocator;
  /**
   * For kind=within: which of the matching containers to pick (1-based).
   * Used when "first/second/etc" product card is required. Default: 1.
   */
  nth?: number;
}

/**
 * Parse the DSL form. Never throws — falls back to bare CSS.
 */
export function parseLocator(expr: string): ParsedLocator {
  const trimmed = (expr ?? '').trim();
  if (!trimmed) return { kind: 'css', raw: '', value: '' };

  // within="<anchor text>"[#N] <inner-locator>
  // Finds an ancestor whose text matches the anchor, optionally picks
  // the N-th such ancestor (1-based, default 1), then resolves the
  // inner locator inside it. Lets nameless elements be identified by
  // the text of the container they live in.
  const withinMatch = trimmed.match(
    /^within=(?:"([^"]+)"|'([^']+)')(?:#(\d+))?\s+(.+)$/,
  );
  if (withinMatch) {
    const [, dq, sq, nthStr, innerExpr] = withinMatch;
    return {
      kind: 'within',
      raw: trimmed,
      containerText: (dq ?? sq ?? '').trim(),
      nth: nthStr ? Math.max(1, parseInt(nthStr, 10)) : 1,
      inner: parseLocator(innerExpr!),
    };
  }

  // role=button[name="X"]  or  role=button
  // Lenient: accept `role=button[name="X` (missing closing quote and
  // bracket) or `role=button[name="X"` (missing bracket) — LLMs
  // occasionally truncate. Closing quote and bracket are both optional
  // in this parser; we just take everything between opening quote and
  // the next `]` or end of string.
  const roleMatch = trimmed.match(
    /^role=([a-zA-Z]+)(?:\[name=(?:"([^"\]]*)"?\]?|'([^'\]]*)'?\]?|([^\]]+)\]?))?$/,
  );
  if (roleMatch) {
    const [, role, dq, sq, bare] = roleMatch;
    return {
      kind: 'role',
      raw: trimmed,
      role: role.toLowerCase(),
      value: dq ?? sq ?? bare ?? undefined,
    };
  }

  // text="exact"   or   text=partial
  const textMatch = trimmed.match(/^text=(?:"([^"]*)"|'([^']*)'|(.+))$/);
  if (textMatch) {
    const [, dq, sq, partial] = textMatch;
    const isExact = dq !== undefined || sq !== undefined;
    return {
      kind: 'text',
      raw: trimmed,
      value: (dq ?? sq ?? partial ?? '').trim(),
      exact: isExact,
    };
  }

  // placeholder="X"  —  tolerates unbalanced closing quote (LLMs
  // sometimes truncate the trailing quote, and we prefer a best-effort
  // parse over falling through to CSS and crashing Playwright with
  // "Unknown engine placeholder").
  const phMatch = trimmed.match(
    /^placeholder=(?:"([^"]*)"?|'([^']*)'?|(\S.*))$/,
  );
  if (phMatch) {
    return {
      kind: 'placeholder',
      raw: trimmed,
      value: (phMatch[1] ?? phMatch[2] ?? phMatch[3] ?? '').trim(),
    };
  }

  // label="X"  —  same leniency.
  const lblMatch = trimmed.match(
    /^label=(?:"([^"]*)"?|'([^']*)'?|(\S.*))$/,
  );
  if (lblMatch) {
    return {
      kind: 'label',
      raw: trimmed,
      value: (lblMatch[1] ?? lblMatch[2] ?? lblMatch[3] ?? '').trim(),
    };
  }

  // testid=X   or   testid="X"   or   data-testid=X
  const tidMatch = trimmed.match(
    /^(?:testid|data-testid)=(?:"([^"]*)"|'([^']*)'|(\S+))$/,
  );
  if (tidMatch) {
    return {
      kind: 'testid',
      raw: trimmed,
      value: tidMatch[1] ?? tidMatch[2] ?? tidMatch[3]!,
    };
  }

  // css=SEL
  const cssMatch = trimmed.match(/^css=(.+)$/s);
  if (cssMatch) {
    return { kind: 'css', raw: trimmed, value: cssMatch[1]!.trim() };
  }

  // bare → treat as CSS
  return { kind: 'css', raw: trimmed, value: trimmed };
}

/**
 * Resolve a parsed or raw selector expression to a Playwright Locator.
 *
 * Supports the nested `within=` form: finds ancestors whose text
 * matches an anchor substring, picks the N-th (default 1st), then
 * resolves the inner locator scoped to that ancestor. This is a pure
 * structural operator — it knows nothing about what the anchor text
 * means; the sub-agent decides which text to anchor on by reading the
 * live DOM.
 */
export function resolveLocator(page: Page, expr: string): Locator {
  const p = parseLocator(expr);
  return resolveParsed(page, p);
}

function resolveParsed(
  scope: Page | Locator,
  p: ParsedLocator,
): Locator {
  switch (p.kind) {
    case 'within': {
      if (!p.containerText || !p.inner) {
        return (scope as Page | Locator).locator(p.raw);
      }
      // Find all containers whose text contains the anchor string, then
      // scope to the nth one. We deliberately use a broad locator
      // ("*") + filter(hasText: ...) so any element type can be a card.
      const container = (scope as any)
        .locator('*')
        .filter({ hasText: p.containerText })
        .nth((p.nth ?? 1) - 1);
      return resolveParsed(container, p.inner);
    }
    case 'role':
      return p.value
        ? (scope as any).getByRole(p.role, { name: p.value })
        : (scope as any).getByRole(p.role);
    case 'text':
      return p.exact
        ? (scope as any).getByText(p.value ?? '', { exact: true })
        : (scope as any).getByText(p.value ?? '');
    case 'placeholder':
      return (scope as any).getByPlaceholder(p.value ?? '');
    case 'label':
      return (scope as any).getByLabel(p.value ?? '');
    case 'testid':
      return (scope as any).getByTestId(p.value ?? '');
    case 'css':
    default:
      return (scope as any).locator(p.value ?? '');
  }
}

/**
 * Safe kind/value extraction for telemetry / error messages.
 */
export function describeLocator(expr: string): string {
  const p = parseLocator(expr);
  if (p.kind === 'role') {
    return p.value ? `role=${p.role} "${p.value}"` : `role=${p.role}`;
  }
  return `${p.kind}="${p.value ?? ''}"`;
}
