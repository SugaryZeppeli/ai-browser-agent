/**
 * Centralised configuration constants.
 *
 * Every tunable value that was previously a magic number lives here.
 * Grouped by subsystem. Values inside the EXTRACTOR string (browser-side
 * JS executed via page.evaluate) cannot be imported and stay inline —
 * they are noted in the EXTRACTOR section below for reference only.
 */

/* ─── Timeouts (ms) ─── */

/** Playwright page.waitForLoadState timeout in settle(). */
export const SETTLE_TIMEOUT = 2_000;
/** Post-settle buffer for navigate (hydration / SPA transitions). */
export const SETTLE_BUFFER_MS = 50;
/** Shorter buffer for click/type — must be enough for SPA animations
 *  (dropdown open, modal expand, textarea reveal). 100ms covers most
 *  React/Vue transitions while staying fast. */
export const SETTLE_BUFFER_FAST_MS = 100;
/** navigate_to_url page load timeout. */
export const NAVIGATE_TIMEOUT = 30_000;
/** click() / type() actionability timeout per candidate. */
export const ACTION_TIMEOUT = 4_000;
/**
 * JS evaluate fallback timeout. Longer than ACTION_TIMEOUT because after
 * SPA mutations (add-to-cart, modal open) elements may re-render with a
 * network roundtrip — the target node only appears in the DOM after 2-6s.
 * The Playwright .click() fails fast (ACTION_TIMEOUT), then the JS
 * fallback gets this more patient window. 10s covers typical SPA
 * transitions without the old 30s default that froze the agent.
 */
export const JS_FALLBACK_TIMEOUT = 10_000;
/** Legacy click_element / type_text fill timeout. */
export const LEGACY_ACTION_TIMEOUT = 5_000;
/** Delay before screenshot in legacy take_screenshot. */
export const SCREENSHOT_SETTLE_MS = 80;
/** Delay after scroll_page before returning. */
export const SCROLL_SETTLE_MS = 80;
/** login-helper page load timeout. */
export const LOGIN_PAGE_TIMEOUT = 30_000;

/* ─── LLM retry ─── */

/** Backoff delays for 429 / 5xx retries in the main loop. */
export const LLM_RETRY_BACKOFFS = [2_000, 5_000, 12_000];

/* ─── Token & context budget ─── */

/** Estimated tokens per image in the conversation. */
export const IMAGE_TOKEN_ESTIMATE = 1_000;
/** Max chars per tool result before truncation (non-observe tools). */
export const MAX_TOOL_CONTENT_CHARS = 5_000;
/** Max chars for observe() results — perception needs the full tree. */
export const MAX_OBSERVE_CONTENT_CHARS = 15_000;
/**
 * Absolute token cap — run terminates if exceeded.
 * Override via TOKEN_CAP env for large-context models (e.g. 2M Grok).
 * Default 200k is safe for most vision+tool models on OpenRouter.
 */
export const HARD_TOKEN_CAP = parseInt(process.env.TOKEN_CAP ?? '200000', 10);
/**
 * Threshold that triggers the summariser sub-agent.
 * Override via COMPACT_AT env. Set to 0 to disable compaction entirely.
 */
export const COMPACTION_THRESHOLD = parseInt(process.env.COMPACT_AT ?? '40000', 10);
/** How many recent screenshot images to keep (older → text placeholder). */
export const KEEP_LAST_SCREENSHOTS = 1;

/* ─── Agent loop defaults ─── */

/** Max steps per runAgent call. */
export const MAX_STEPS = 50;
/** Inject a reflection nudge every N steps. */
export const REFLECT_EVERY = 12;
/** How many identical observations before stuck detector fires. */
export const STUCK_THRESHOLD = 5;
/** How many recent tool rounds to keep during compaction. */
export const COMPACTION_KEEP_ROUNDS = 4;

/* ─── Observe / tree rendering ─── */

/** Default item cap when no query is supplied. */
export const MAX_TREE_ITEMS_DEFAULT = 150;
/** Item cap when a query filter is active. */
export const MAX_TREE_ITEMS_QUERY = 40;
/** Absolute upper bound on tree items. */
export const MAX_TREE_ITEMS_HARD_CAP = 300;

/* ─── Truncation lengths (chars) ─── */

/** Accessible name / heading / item name cap. */
export const NAME_TRUNCATE = 80;
/** Container context cap in observe tree. */
export const CONTAINER_TRUNCATE = 80;
/** Generic short-text truncation (tool results, summaries). */
export const TRUNC_DEFAULT = 200;
/** REPL pretty-print truncation for long summaries. */
export const REPL_TRUNC = 240;
/** Observation hash prefix length for stuck detector. */
export const OBS_HASH_LEN = 160;
/** Observer main-text snapshot cap. */
export const MAIN_TEXT_SNAP_CAP = 4_000;
/** Observer DOM walk element cap. */
export const DOM_WALK_CAP = 2_000;

/* ─── Grounded click/type ─── */

/** Minimum length of the `because` field. */
export const MIN_BECAUSE_LEN = 10;
/** Max candidates to auto-try on click/type timeout. */
export const MAX_CLICK_FALLTHROUGH = 4;

/* ─── Observer delta ─── */

/** Scroll jump threshold (px) to report in state delta. */
export const SCROLL_JUMP_THRESHOLD_PX = 100;

/* ─── Video / viewport ─── */

/** Fallback viewport for headless / video recording. */
export const FALLBACK_VIEWPORT = { width: 1920, height: 1080 };

/* ─── Captcha detection ─── */

/** URL patterns indicating a human-only challenge (captcha / bot-check). */
export const CAPTCHA_PATTERNS = [
  /showcaptcha/i,
  /\/captcha(\/|\?|$)/i,
  /challenges?\.cloudflare/i,
  /hcaptcha\.com/i,
  /\brecaptcha\b/i,
  /\bturnstile\b/i,
  /bot[_-]?check/i,
  /anti[_-]?robot/i,
];
export function looksLikeCaptcha(url: string): boolean {
  return CAPTCHA_PATTERNS.some((re) => re.test(url));
}

/* ─── Screen recorder ─── */

/** Default FPS for ffmpeg screen recording. */
export const SCREEN_RECORD_FPS = 15;

/*
 * ─── EXTRACTOR (browser-side, NOT importable) ───
 *
 * The following values live inside the EXTRACTOR template string in
 * dom-subagent.ts and are evaluated in the browser via page.evaluate().
 * They CANNOT be imported from this module. Listed here for reference:
 *
 *   700  — max interactive elements from querySelectorAll
 *   250  — max cursor:pointer additions
 *   900  — total node cap (interactive + pointer)
 *   100  — min z-index for overlay detection
 *   0.2  — min viewport fraction for overlay detection
 *   160  — accessible name truncation
 *   120  — href max length
 *   80   — placeholder truncation
 *   400  — container text cap
 *   10/500 — container text min/max for relevance
 *   2000 — main_text excerpt length
 */
