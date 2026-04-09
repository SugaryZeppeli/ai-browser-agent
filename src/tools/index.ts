/**
 * Tool registry — grounded vision rewrite.
 *
 * Visible to the main agent (TOOL_SCHEMAS):
 *   observe → click / type / navigate_to_url / scroll_page / wait →
 *   create_plan / verify / confirm_action / respond / ask_user / finish
 *
 * Registered but hidden (dispatchable, not advertised):
 *   take_screenshot / click_element / type_text — kept for the
 *   safety regression test that bypasses the LLM and dispatches
 *   click_element directly to exercise the runtime safety guard.
 *
 * The DOM sub-agent (query_dom / query_dom_all) was demoted to a
 * pure INTERNAL helper in Phase 6: ctx.queryDom is wired by the loop
 * but no tool exposes it, and the grounded click/type cascade calls
 * it as a last-resort fallback when Playwright's semantic locators
 * cannot resolve a target.
 *
 * dispatch(ctx, name, args) routes to the handler — both visible
 * and hidden tools can be dispatched by name.
 */

import type { ToolContext, ToolResult } from './types.js';
import * as b from './browser-tools.js';
import { observe as observeHandler } from './observe.js';
import { click as clickHandler, type as typeHandler } from './grounded.js';

type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolSchema => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

interface ToolDef {
  name: string;
  schema: ToolSchema;
  handler: (ctx: ToolContext, args: any) => Promise<ToolResult>;
  /**
   * If true, the tool is dispatchable but NOT advertised to the agent.
   * Used to retire legacy tools (take_screenshot / query_dom /
   * query_dom_all / click_element / type_text) without ripping out
   * the handlers, so internal callers (cascade fallback, safety
   * regression test) keep working while the main agent only sees the
   * grounded triple observe / click / type.
   */
  hidden?: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'observe',
    schema: tool(
      'observe',
      'Look at the current page. Returns accessibility tree + screenshot. Pass query to filter by keyword — on complex pages the unfiltered tree may be truncated.',
      {
        query: {
          type: 'string',
          description:
            'Keyword filter. Returns top 30 items matching these words. Omit for full tree.',
        },
        max_items: {
          type: 'number',
          description:
            'Optional cap on items returned. Default 30 with query, 200 without. Hard upper bound 200.',
        },
        visual: {
          type: 'boolean',
          description:
            'Set false to skip screenshot (tree only). Use when you only need the tree, e.g. after a failed click retry.',
        },
      },
      [],
    ),
    handler: observeHandler,
  },
  {
    name: 'click',
    schema: tool(
      'click',
      'Click an element by its [ref] number from the tree. Auto-scrolls, auto-retries with JS click if covered.',
      {
        ref: {
          type: 'number',
          description:
            'Element ref number from the [TREE] output (e.g. 5 for "[5] button Submit"). PREFERRED over target.',
        },
        target: {
          type: 'string',
          description:
            'Fallback: "<role> <name>" from tree. Use ref instead when available.',
        },
        because: {
          type: 'string',
          description:
            'REQUIRED. Short justification (≥10 chars) for this click.',
        },
        nth: {
          type: 'number',
          description:
            'For target-based only: 1-based index for multiple matches.',
        },
      },
      [],
    ),
    handler: clickHandler,
  },
  {
    name: 'type',
    schema: tool(
      'type',
      'Type text into an input by its [ref] number. Set submit=true to press Enter after.',
      {
        ref: {
          type: 'number',
          description:
            'Element ref number from the [TREE]. PREFERRED over target.',
        },
        target: {
          type: 'string',
          description:
            'Fallback: "<role> <name>" from tree.',
        },
        text: {
          type: 'string',
          description: 'Text to type.',
        },
        because: {
          type: 'string',
          description:
            'REQUIRED. Short justification (≥10 chars).',
        },
        submit: {
          type: 'boolean',
          description: 'If true, press Enter after typing.',
        },
      },
      ['text'],
    ),
    handler: typeHandler,
  },
  {
    name: 'navigate_to_url',
    schema: tool(
      'navigate_to_url',
      'Open a URL in the browser tab. Waits for the page to load. Use this to start any task that requires a specific website.',
      {
        url: {
          type: 'string',
          description: 'Absolute URL, e.g. https://example.com/',
        },
      },
      ['url'],
    ),
    handler: b.navigate_to_url,
  },
  // take_screenshot removed — observe() provides screenshots natively.
  {
    name: 'wait',
    schema: tool(
      'wait',
      'Pause for N seconds to let the page settle (animations, XHR, SPA transitions). Max 15s.',
      {
        seconds: { type: 'number', description: 'Seconds to wait, 0–15' },
      },
      ['seconds'],
    ),
    handler: b.wait,
  },
  {
    name: 'press_key',
    schema: tool(
      'press_key',
      'Press a keyboard key or shortcut. Use Playwright key names: "Enter", "Escape", "Tab", "Delete", "ArrowDown". Combos: "Control+c", "Shift+Delete". WARNING: "Control+a" selects TEXT, not list items — use the select-all checkbox for lists.',
      {
        key: {
          type: 'string',
          description:
            'Playwright key descriptor. E.g. "Enter", "Escape", "Control+a".',
        },
        because: {
          type: 'string',
          description:
            'REQUIRED. Short justification (≥10 chars) linking this keypress to your current subgoal.',
        },
      },
      ['key', 'because'],
    ),
    handler: b.press_key,
  },
  {
    name: 'scroll_page',
    schema: tool(
      'scroll_page',
      'Scroll the page. Essential for virtualized lists where items below the viewport do not exist in the DOM yet — you must scroll to materialize them. direction="down"/"up" moves by viewport-height steps (multiply with amount). direction="top"/"bottom" jumps to either end. Use the pattern: scroll_page → observe() → scroll_page → observe() (repeat) to enumerate a full virtualized list.',
      {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'top', 'bottom'],
          description:
            'Scroll direction. down/up = by viewport-height steps. top/bottom = jump to either end.',
        },
        amount: {
          type: 'number',
          description:
            'Optional step count for down/up (default 1, max 10). Ignored for top/bottom.',
        },
      },
      [],
    ),
    handler: b.scroll_page,
  },
  {
    name: 'click_element',
    schema: tool(
      'click_element',
      'Click an element. The selector must come from query_dom — never invent one. Use the rich DSL: role=button[name="..."], role=searchbox, text="...", placeholder="...", label="...", testid=..., css=.... Prefer role/text/placeholder over css. ALWAYS also pass `intent` — a 2-6 word description of what you are clicking (e.g. "add first hot-dog to cart", "open search field"). If the click fails with a stale selector, the tool will transparently re-ask query_dom with that intent and retry once.',
      {
        selector: {
          type: 'string',
          description:
            'Locator DSL. One of: role=button[name="..."], role=link[name="..."], role=searchbox, text="exact", text=partial, placeholder="...", label="...", testid=..., css=..., or bare CSS as fallback.',
        },
        intent: {
          type: 'string',
          description:
            'Short 2-6 word natural-language description of what you are clicking, used for transparent selector recovery on failure.',
        },
      },
      ['selector'],
    ),
    handler: b.click_element,
    hidden: true,
  },
  // type_text removed — no callers in codebase. type() with ref is the primary path.
  {
    name: 'confirm_action',
    schema: tool(
      'confirm_action',
      'Ask the user to confirm a payment or financial action BEFORE performing it. Required before: paying, purchasing, buying, checkout. The user answers yes/no; if yes, retry the blocked action immediately.',
      {
        intent: {
          type: 'string',
          description:
            'One-sentence description of what you are about to do and why. E.g. "Delete the selected spam email", "Place the order for 1 BBQ burger — total 450 ₽".',
        },
        target: {
          type: 'string',
          description:
            'Optional: the element or object the action targets (button label, item name, etc).',
        },
      },
      ['intent'],
    ),
    handler: b.confirm_action,
  },
  {
    name: 'ask_user',
    schema: tool(
      'ask_user',
      'Ask the user a question and wait for their answer. Use for: clarifying ambiguous goals, offering choices between options, proposing an approach before executing, asking for credentials/preferences, or any situation where the user\'s input would lead to a better outcome. The loop pauses until they respond. For one-way updates that don\'t need a reply, use respond() instead.',
      { question: { type: 'string' } },
      ['question'],
    ),
    handler: b.ask_user,
  },
  {
    name: 'create_plan',
    schema: tool(
      'create_plan',
      'Optional: plan the task before acting. Only useful for complex multi-phase tasks (5+ steps). For simple tasks, skip and act directly.',
      {
        success_condition: {
          type: 'string',
          description:
            'ONE sentence describing the literal observable page state that proves the goal is done. Not a plan. Not a description of steps. Just "what the screen will show when this is complete".',
        },
        subgoals: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered list of short natural-language sub-goals you intend to achieve in order. Generic, in your own words. No templates. Minimum 1.',
        },
        verification_strategy: {
          type: 'string',
          description:
            'How you will verify success — what you expect to see on screen.',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: pitfalls you want to remember (e.g. "a bulk select-all control exists and must not be clicked", "the page has infinite scroll").',
        },
      },
      ['success_condition', 'subgoals', 'verification_strategy'],
    ),
    handler: b.create_plan,
  },
  {
    name: 'verify',
    schema: tool(
      'verify',
      'Optional: record progress on a sub-goal. Not required before finish. Use only when tracking complex multi-step progress is genuinely helpful.',
      {
        target: {
          type: 'string',
          description:
            'Which part of the plan this verification covers — quote a sub-goal text, or write "goal" for the whole task.',
        },
        evidence: {
          type: 'string',
          description:
            'What you OBSERVED on the page that supports the verdict — a title, a count, a visible element, a URL, a state delta you just saw. Be specific. Do not paraphrase the plan; report what you saw.',
        },
        verdict: {
          type: 'string',
          enum: ['pass', 'fail', 'partial'],
          description:
            'Honest self-assessment. pass = evidence fully proves the target; partial = some of it is done; fail = target is not reached.',
        },
        notes: {
          type: 'string',
          description: 'Optional short notes, especially on partial/fail.',
        },
      },
      ['target', 'evidence', 'verdict'],
    ),
    handler: b.verify,
  },
  {
    name: 'respond',
    schema: tool(
      'respond',
      'Send a message to the user without pausing the run. Use for: progress updates, sharing findings, reporting what you see on the page, proposing next steps, or any narrative that doesn\'t need a reply. The loop continues immediately. For questions that need an answer, use ask_user instead.',
      {
        text: {
          type: 'string',
          description:
            'The message to show the user. Natural language. Can be multi-line. Prefer specificity — concrete findings, counts, names you saw on the page.',
        },
      },
      ['text'],
    ),
    handler: b.respond,
  },
  {
    name: 'finish',
    schema: tool(
      'finish',
      'Signal that the task is complete. Set success=true if you achieved the goal, success=false if it is impossible or the user denied a required confirmation. Always provide an honest summary of what was done.',
      {
        summary: { type: 'string' },
        success: { type: 'boolean' },
      },
      ['summary', 'success'],
    ),
    handler: b.finish,
  },
];

export const TOOL_SCHEMAS = TOOLS.filter((t) => !t.hidden).map((t) => t.schema);
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Some reasoning-first models (e.g. gpt-oss harmony format) leak internal
 * channel markers into tool names. Strip anything after the first
 * non-identifier char.
 */
function canonicalizeName(name: string): string {
  const m = name.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
  return m ? m[0] : name;
}

export async function dispatch(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const canonical = canonicalizeName(name);
  const def = TOOL_BY_NAME.get(canonical);
  if (!def) {
    return {
      ok: false,
      text: `ERROR unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`,
    };
  }
  try {
    return await def.handler(ctx, args ?? {});
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `ERROR ${canonical}: ${msg}` };
  }
}

export type { ToolContext, ToolResult };
