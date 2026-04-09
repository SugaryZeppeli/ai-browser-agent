import type { BrowserContext } from 'playwright';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { llm, MODEL, TOOL_CHOICE } from '../llm.js';
import { dispatch, TOOL_SCHEMAS } from '../tools/index.js';
import type { ToolContext } from '../tools/index.js';
import { makeGetPage } from '../tools/types.js';
import { buildMiniTree, extractVisibleKeys } from '../tools/observe.js';
import { createDomSubagent } from './dom-subagent.js';
import { createSafetyState, type SafetyState } from './safety.js';
import {
  snapshot as pageSnapshot,
  renderDelta,
  isMutatingTool,
  isPageStateChangingTool,
  type PageSnapshot,
} from './observer.js';
import { SYSTEM_PROMPT, REFLECTION_NUDGE, STUCK_NUDGE } from './prompts.js';
import {
  decayScreenshots,
  capToolContent,
  estimateTokens,
} from './context.js';
import {
  HARD_TOKEN_CAP,
  COMPACTION_THRESHOLD,
  MAX_TOOL_CONTENT_CHARS,
  MAX_OBSERVE_CONTENT_CHARS,
  MAX_STEPS as DEFAULT_MAX_STEPS,
  REFLECT_EVERY as DEFAULT_REFLECT,
  STUCK_THRESHOLD as DEFAULT_STUCK,
  LLM_RETRY_BACKOFFS,
  COMPACTION_KEEP_ROUNDS,
  OBS_HASH_LEN,
} from '../config.js';
import { compactHistoryIfNeeded } from './summariser.js';

/**
 * The v2 agent loop — Evaluator-Optimizer + Sub-agent + Security.
 *
 * Each turn:
 *   1. Decay old screenshots, estimate tokens.
 *   2. Optionally inject a reflection nudge (periodic or stuck emergency).
 *   3. Call the LLM with the conversation + tool schemas, tool_choice=required.
 *   4. Execute every tool call the LLM produced.
 *   5. Push each tool result back as a `tool` message; if a take_screenshot
 *      produced a PNG, also push a follow-up `user` message with the image
 *      as an `image_url` content part so vision-capable models can see it.
 *   6. Handle control signals: finish → return; ask_user / confirm_action →
 *      block the loop on opts.onAskUser and feed the answer back in.
 *
 * The security layer sits BEHIND click_element / type_text — destructive
 * actions get blocked with a BLOCKED message until the agent calls
 * confirm_action and the user approves.
 */

export interface AgentConfig {
  maxSteps?: number;
  reflectEvery?: number;
  stuckThreshold?: number;
  model?: string;
  /** Override the DOM sub-agent model. */
  domModel?: string;
}

const DEFAULTS = {
  maxSteps: DEFAULT_MAX_STEPS,
  reflectEvery: DEFAULT_REFLECT,
  stuckThreshold: DEFAULT_STUCK,
};

export type AgentEvent =
  | { type: 'goal'; goal: string }
  | { type: 'step'; step: number; tokens: number; decayed: number }
  | { type: 'thinking'; text: string }
  | { type: 'action'; tool: string; args: unknown }
  | { type: 'observation'; ok: boolean; summary: string }
  | { type: 'reflection'; kind: 'periodic' | 'stuck' }
  | { type: 'ask_user'; question: string }
  | { type: 'respond'; text: string }
  | {
      type: 'plan';
      success_condition: string;
      subgoals: string[];
      verification_strategy: string;
      risks?: string[];
    }
  | {
      type: 'verify';
      target: string;
      evidence: string;
      verdict: 'pass' | 'fail' | 'partial';
      notes?: string;
    }
  | { type: 'safety_block'; reason: string }
  | { type: 'safety_approved'; intent: string }
  | { type: 'safety_declined'; intent: string }
  | { type: 'dom_query'; query: string; items: number; answer: string }
  | { type: 'compaction'; summarisedMessages: number; tokensBefore: number; tokensAfter: number }
  | { type: 'finish'; success: boolean; summary: string }
  | { type: 'error'; error: string }
  | { type: 'max_steps' }
  | { type: 'budget_exceeded'; tokens: number };

export interface AgentResult {
  status: 'finished' | 'asked_user' | 'max_steps' | 'error' | 'budget_exceeded';
  success?: boolean;
  summary?: string;
  question?: string;
  error?: string;
  steps: number;
  safetyStats?: ReturnType<SafetyState['stats']>;
  /**
   * Conversation history EXCLUDING the system prompt, returned so the
   * caller (typically the REPL) can thread it back into the next turn
   * and give the agent cross-turn memory of what it previously saw,
   * reported, and decided. The system prompt is re-prepended by runAgent
   * on every call, so it should never appear in this array.
   */
  history: ChatCompletionMessageParam[];
}

export interface RunOptions {
  /** Live browser context. The loop dynamically picks the active tab. */
  context: BrowserContext;
  goal: string;
  config?: AgentConfig;
  onEvent?: (e: AgentEvent) => void;
  /** Called when the agent uses ask_user or confirm_action. */
  onAskUser?: (q: string) => Promise<string>;
  /**
   * Prior conversation messages from an earlier runAgent call in the
   * same session, EXCLUDING the system prompt. When provided, the new
   * `goal` is appended as a fresh user message to this history so the
   * agent can reference what happened in previous turns. Leave undefined
   * for a brand-new conversation.
   */
  history?: ChatCompletionMessageParam[];
}

/* ─────────────── helpers ─────────────── */

function observationHash(text: string): string {
  // Normalise whitespace and take a short prefix — same action at the same
  // URL producing the same short text is what we care about.
  return text.replace(/\s+/g, ' ').trim().slice(0, OBS_HASH_LEN);
}

function isConfirmAffirmative(s: string): boolean {
  return /^(?:\s*)(y|yes|yep|yeah|ok|okay|approve|approved|confirm|sure|go|proceed|да|ок|конечно|подтверждаю|давай|жми|продолжай)\b/i.test(
    s.trim(),
  );
}

/* ─────────────── main loop ─────────────── */

export async function runAgent(opts: RunOptions): Promise<AgentResult> {
  const cfg = { ...DEFAULTS, ...opts.config };
  const model = opts.config?.model ?? MODEL;
  const log = opts.onEvent ?? (() => {});
  log({ type: 'goal', goal: opts.goal });

  // ── Wire sub-agent + safety into the tool context ──
  const safety = createSafetyState();
  const getPage = makeGetPage(opts.context);
  const queryDom = createDomSubagent(getPage, {
    model: opts.config?.domModel,
    onCall: ({ query, items, answer }) =>
      log({ type: 'dom_query', query, items, answer: answer.slice(0, 200) }),
  });
  const ctx: ToolContext = {
    context: opts.context,
    getPage,
    queryDom,
    safety,
  };

  // Build the working message list: system prompt (always first),
  // followed by any prior conversation history from earlier turns in
  // the same REPL session, followed by the new goal as a user message.
  // We only prepend "GOAL: ..." when there is no prior history — on
  // continuing turns the user's text is just the next conversational
  // turn, not a brand-new goal.
  const isContinuation = !!opts.history && opts.history.length > 0;
  // Detect multi-step goals (numbered lists, bullet points) and format
  // them so the model cannot mistake a partial completion for "done".
  const hasSteps = /(?:^|\n)\s*\d+[\.\)]\s/m.test(opts.goal);
  let goalText: string;
  if (isContinuation) {
    goalText = opts.goal;
  } else if (hasSteps) {
    goalText =
      `GOAL (MULTI-STEP — you MUST complete ALL steps before calling finish):\n\n` +
      `${opts.goal}\n\n` +
      `Complete every numbered step above. Do NOT finish after just the first step. Begin.`;
  } else {
    goalText = `GOAL: ${opts.goal}\n\nBegin.`;
  }
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(opts.history ?? []),
    { role: 'user', content: goalText },
  ];

  // Helper: extract the non-system slice for returning as updated history.
  const extractHistory = (): ChatCompletionMessageParam[] =>
    messages.filter((m, i) => i > 0);

  const recentObs: string[] = [];
  let stuckNudges = 0;
  let step = 0;

  // ── Plan-Act-Verify state ──
  //   planCreated: true once create_plan ran successfully for THIS goal.
  //     Required before any mutating tool call. Resets every runAgent
  //     call (each new user goal needs its own plan).
  //   lastVerifyPass: true when the most recent verify had verdict="pass".
  //   mutatedAfterVerify: true if any mutating tool ran after the last
  //     pass verify, invalidating it (page state changed since then).
  //   hasQueriedSinceLastScroll: true iff the most recent DOM
  //     observation was a query_dom / query_dom_all (not a stale
  //     screenshot). Gatekeeps scroll_page so the agent cannot chain
  //     scroll-scroll-scroll without actually reading what became
  //     visible — the #1 failure mode on virtualized / lazy-loaded
  //     lists. Reset to false on navigate_to_url (new page needs to
  //     be observed fresh) and on each successful scroll_page (must
  //     re-query before the next scroll).
  // Gatekeeping: finish(success=true) requires planCreated AND
  //   lastVerifyPass AND !mutatedAfterVerify.
  let planCreated = false;
  let lastVerifyPass = false;
  let mutatedAfterVerify = false;
  let hasQueriedSinceLastScroll = false;
  // ── Gate D state ──
  // After a successful navigate_to_url, the agent MUST call observe()
  // before its first acting tool on the new page (click / type /
  // scroll_page). This is the structural defence against the F1
  // failure mode "main agent invents locators": the only role+name
  // strings the agent has are whatever observe() prints, so without a
  // recent observe() it has nothing legitimate to pass as `target`.
  // Reset to true on every successful navigate_to_url (and at run
  // start, since the initial page is also "fresh"). Cleared by any
  // successful observe() call.
  let needsObserveAfterNavigate = true;
  // ── Drift detector ──
  // Slow-drift loops (where the agent makes the same call with the
  // same arg shape over and over, never advancing) are not always
  // caught by the observation-hash stuck detector — the page DOES
  // mutate slightly between calls, so each tool result hash differs.
  // The drift detector hashes (toolName + first 100 chars of args)
  // over a rolling window. If the same hash appears 4+ times in the
  // last 6 calls, inject a drift nudge. If 5+, force terminate.
  const recentToolHashes: string[] = [];
  let driftNudges = 0;

  while (step < cfg.maxSteps) {
    step++;

    const decayed = decayScreenshots(messages);
    let tokens = estimateTokens(messages);
    log({ type: 'step', step, tokens, decayed });

    // ── Budget-triggered compaction ──
    // When the running context approaches the soft threshold, invoke the
    // summariser sub-agent to collapse old history into a [MEMORY] block.
    // Costs one LLM call but typically halves the next turn's context.
    if (tokens > COMPACTION_THRESHOLD) {
      try {
        const result = await compactHistoryIfNeeded(messages, {
          keepRecentRounds: 4,
          model: opts.config?.domModel ?? model,
        });
        if (result) {
          const after = estimateTokens(messages);
          log({
            type: 'compaction',
            summarisedMessages: result.summarised,
            tokensBefore: tokens,
            tokensAfter: after,
          });
          tokens = after;
        }
      } catch (e) {
        // Compaction failure must not kill the run — just log and continue.
        log({
          type: 'error',
          error: `compaction failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // Hard budget cap — bail out before the provider does.
    if (tokens > HARD_TOKEN_CAP) {
      log({ type: 'budget_exceeded', tokens });
      return {
        status: 'budget_exceeded',
        steps: step,
        safetyStats: safety.stats(),
        history: extractHistory(),
      };
    }

    // ── Stuck detector ──
    if (recentObs.length >= cfg.stuckThreshold) {
      const tail = recentObs.slice(-cfg.stuckThreshold);
      if (tail.every((h) => h === tail[0])) {
        stuckNudges++;
        log({ type: 'reflection', kind: 'stuck' });
        if (stuckNudges >= 2) {
          log({
            type: 'finish',
            success: false,
            summary:
              'Agent stuck: observations repeated across multiple nudges. Terminating.',
          });
          return {
            status: 'finished',
            success: false,
            summary:
              'Stuck: no progress across multiple nudges. Manual inspection required.',
            steps: step,
            safetyStats: safety.stats(),
            history: extractHistory(),
          };
        }
        messages.push({ role: 'user', content: STUCK_NUDGE });
        recentObs.length = 0;
      }
    }

    // ── Periodic reflection ──
    if (cfg.reflectEvery > 0 && step > 1 && step % cfg.reflectEvery === 0) {
      log({ type: 'reflection', kind: 'periodic' });
      messages.push({ role: 'user', content: REFLECTION_NUDGE });
    }

    // ── LLM call with retry on 429/5xx ──
    let resp;
    let lastErr: unknown;
    const backoffs = LLM_RETRY_BACKOFFS;
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        resp = await llm.chat.completions.create({
          model,
          messages,
          tools: TOOL_SCHEMAS as any,
          tool_choice: TOOL_CHOICE,
        });
        lastErr = undefined;
        break;
      } catch (e: unknown) {
        lastErr = e;
        const status = (e as any)?.status as number | undefined;
        const retriable =
          status === 429 || (typeof status === 'number' && status >= 500);
        if (!retriable || attempt === backoffs.length) break;
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
    }
    if (!resp) {
      const error =
        lastErr instanceof Error
          ? lastErr.message
          : String(lastErr ?? 'unknown LLM error');
      log({ type: 'error', error });
      return {
        status: 'error',
        error,
        steps: step,
        safetyStats: safety.stats(),
        history: extractHistory(),
      };
    }

    const msg = resp.choices[0]?.message;
    if (!msg) {
      const error = 'no choice in LLM response';
      log({ type: 'error', error });
      return {
        status: 'error',
        error,
        steps: step,
        safetyStats: safety.stats(),
        history: extractHistory(),
      };
    }

    if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
      log({ type: 'thinking', text: msg.content });
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      messages.push(msg as any);
      // With tool_choice=auto the model may reason without tools once.
      // Give it one free pass; on the second consecutive text-only turn,
      // nudge harder.
      const prevRole = messages.length >= 2 ? (messages[messages.length - 2] as any)?.role : '';
      const nudge = prevRole === 'user' && (messages[messages.length - 2] as any)?.content?.includes('call a tool')
        ? 'You still have not called a tool. Call observe() if unsure, or finish() if done.'
        : 'You did not call a tool. Call a tool to make progress — observe() to see the page, click/type to act, or finish() to end.';
      messages.push({ role: 'user', content: nudge });
      continue;
    }

    messages.push(msg as any);

    let terminal: AgentResult | null = null;
    let mutatedThisTurn = false;

    for (const tc of toolCalls) {
      if (tc.type !== 'function') continue;

      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      log({ type: 'action', tool: tc.function.name, args: parsedArgs });

      const isMutating = isMutatingTool(tc.function.name);
      const isStateChanging = isPageStateChangingTool(tc.function.name);
      const isFinish = tc.function.name === 'finish';
      const isScroll = tc.function.name === 'scroll_page';

      // ── Gate A removed ──
      // Plan gate was adding overhead without proportional value.
      // The model decides whether to plan. create_plan is still available
      // and the prompt recommends it for complex tasks.

      // ── Gatekeeper C: scroll requires observation between calls ──
      // scroll_page without a preceding query_dom / query_dom_all is
      // a wasted step: scrolling only helps if you then read what
      // became visible. Chains of scroll-without-query are the #1
      // failure mode on virtualized lists — the agent keeps scrolling
      // because it feels like progress, but never actually inspects
      // the new rows. This hard block forces observe-then-act.
      //
      // Reset: query_dom / query_dom_all → allowed; successful
      // scroll_page → blocked again until another query.
      if (isScroll && !hasQueriedSinceLastScroll) {
        const nudge =
          'BLOCKED (observe-before-scroll gate): scroll_page requires a preceding observe() call, so you actually read what is currently visible before scrolling past it. Chains of scroll calls without an observe in between reveal nothing useful. If your goal targets a subset of items, first check whether the page has its own search / filter / sort affordance in the accessibility tree and use that before manual scrolling — it is almost always faster and more reliable than walking through thousands of rows.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: nudge,
        } as any);
        log({ type: 'observation', ok: false, summary: nudge });
        continue;
      }

      // ── Gatekeeper D: observe-before-first-action-after-navigate ──
      // After a fresh page load, the agent must call observe() at
      // least once before any acting tool. The grounded action layer
      // (click / type) only accepts role+name pairs that came out of
      // a recent observe() tree — without one, the agent would be
      // composing targets from imagination, which is the F1 failure
      // mode this rewrite exists to eliminate. scroll_page is also
      // gated because scrolling without first reading the page is the
      // same blind motion. observe() itself is what clears the gate.
      const needsObserveActing =
        tc.function.name === 'click' ||
        tc.function.name === 'type' ||
        tc.function.name === 'click_element' ||
        tc.function.name === 'type_text' ||
        tc.function.name === 'press_key' ||
        tc.function.name === 'scroll_page';
      if (needsObserveActing && needsObserveAfterNavigate) {
        const nudge =
          'BLOCKED (observe-before-action gate): you have not called observe() since the page last loaded or navigated. The grounded action layer only accepts role+name targets that come from a recent observe() tree — call observe() first to read what is actually on the page, then pick a target line from the tree and retry.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: nudge,
        } as any);
        log({ type: 'observation', ok: false, summary: nudge });
        continue;
      }

      // ── Gate E: one mutation per turn ──
      // The model can batch read-only tools (observe, wait) freely, but
      // only ONE page-mutating action (click / type / navigate / press_key /
      // scroll) per LLM turn. After a mutation, the state delta shows what
      // changed. The model needs a NEW LLM call to read that delta and
      // decide its next action — otherwise it pre-commits to N clicks in
      // one shot without intermediate feedback, leading to over-action
      // (e.g. selecting ALL items when the user asked for "not all").
      if (isMutating && mutatedThisTurn) {
        const nudge =
          'BLOCKED (one-action-per-turn): you already performed a page-mutating action this turn. ' +
          'Read the [STATE DELTA] from your previous action to see what changed, then decide your next step.';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: nudge,
        } as any);
        log({ type: 'observation', ok: false, summary: nudge.slice(0, 100) });
        continue;
      }

      // ── Observer: snapshot BEFORE page-state-changing tools ──
      // We snapshot around any tool that can move DOM state (clicks,
      // typing, navigation, scrolling) to keep the overhead minimal
      // on read-only loops. The delta is computed after the call and
      // appended to the tool result so the LLM gets an unambiguous
      // description of what actually changed, independent of its own
      // screenshot interpretation.
      let before: PageSnapshot | null = null;
      let tabCountBefore = 0;
      if (isStateChanging) {
        try {
          tabCountBefore = ctx.context.pages().length;
          before = await pageSnapshot(await ctx.getPage());
        } catch {
          before = null;
        }
      }

      const result = await dispatch(ctx, tc.function.name, parsedArgs);

      // ── Plan-Act-Verify state updates ──
      if (result.control === 'create_plan' && result.plan) {
        planCreated = true;
        lastVerifyPass = false;
        mutatedAfterVerify = false;
        log({ type: 'plan', ...result.plan });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Plan accepted. success_condition: "${result.plan.success_condition}". Subgoals: ${result.plan.subgoals.length}. Now act. Before finish(success=true), call verify with target="goal" and verdict="pass".`,
        } as any);
        continue;
      }
      if (result.control === 'verify' && result.verification) {
        log({ type: 'verify', ...result.verification });
        if (result.verification.verdict === 'pass') {
          lastVerifyPass = true;
          mutatedAfterVerify = false;
        } else {
          lastVerifyPass = false;
        }
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Verify recorded: target="${result.verification.target}", verdict=${result.verification.verdict}. ${
            result.verification.verdict === 'pass'
              ? 'You may now call finish(success=true) — but ONLY if no further mutation happens before finish.'
              : result.verification.verdict === 'partial'
                ? 'Progress noted. Keep working on the remaining portion.'
                : 'Fail noted. Diagnose what went wrong and recover.'
          }`,
        } as any);
        continue;
      }

      // Any successful mutation after a pass verify invalidates it.
      // Also flag that we mutated this turn — Gate E blocks further
      // mutations until the next LLM call.
      if (isMutating && result.ok) {
        if (lastVerifyPass) mutatedAfterVerify = true;
        mutatedThisTurn = true;
      }

      // ── scroll / observe alternation tracking ──
      if (
        tc.function.name === 'observe' ||
        tc.function.name === 'query_dom' ||
        tc.function.name === 'query_dom_all'
      ) {
        // observe() is the canonical perception primitive in the
        // grounded-vision rewrite — calling it satisfies BOTH the
        // observe-before-scroll gate (Gate C) and the
        // observe-before-action-after-navigate gate (Gate D). We
        // also count legacy query_dom / query_dom_all calls (still
        // dispatchable as internal fallback or via the safety
        // regression path) so mixed traces don't false-block.
        // Provider errors during observation still count toward the
        // gates: the discipline exists to stop the agent from
        // SKIPPING observation, not to punish it for transient
        // infrastructure failures.
        hasQueriedSinceLastScroll = true;
        if (result.ok) needsObserveAfterNavigate = false;
      } else if (result.ok && tc.function.name === 'scroll_page') {
        hasQueriedSinceLastScroll = false;
      } else if (result.ok && tc.function.name === 'navigate_to_url') {
        // Fresh page — force observation before the first scroll AND
        // before the first acting tool. Also invalidate the cached
        // observe a11y-key set so the agent cannot pass click/type
        // targets resolved against the OLD page after navigating.
        hasQueriedSinceLastScroll = false;
        needsObserveAfterNavigate = true;
        ctx.lastObserveVisibleKeys = undefined;
        ctx.lastObserveText = undefined;
      }

      // ── Drift detector ──
      // Hash this tool call by name + first 100 chars of args. Push
      // onto a rolling window of the last 6 calls. If the most recent
      // 4 hashes are identical, the agent is stuck in an
      // identical-action loop (e.g. click X → observe → click X →
      // observe → ...). One nudge is allowed; on the second hit we
      // terminate honestly.
      // Drift detector — only track mutating actions. Read-only tools
      // (observe, wait, verify, respond) are normal loop behaviour,
      // not drift signals.
      const driftExclude = new Set(['observe', 'wait', 'verify', 'respond', 'create_plan']);
      if (!driftExclude.has(tc.function.name)) {
        const driftHash =
          tc.function.name + ':' + (tc.function.arguments || '').slice(0, 100);
        recentToolHashes.push(driftHash);
      }
      if (recentToolHashes.length > 8) recentToolHashes.shift();
      if (recentToolHashes.length >= 4) {
        const tail = recentToolHashes.slice(-4);
        if (tail.every((h) => h === tail[0])) {
          driftNudges++;
          log({ type: 'reflection', kind: 'stuck' });
          if (driftNudges >= 2) {
            log({
              type: 'finish',
              success: false,
              summary:
                'Agent terminated: drift detected — same tool call repeated 4+ times across 6 steps without progress.',
            });
            return {
              status: 'finished',
              success: false,
              summary:
                'Drift loop: identical tool/args repeated. Manual inspection required.',
              steps: step,
              safetyStats: safety.stats(),
              history: extractHistory(),
            };
          }
          messages.push({
            role: 'user',
            content:
              '[DRIFT NUDGE] You have made the same tool call with the same arguments 4+ times in a row. This is a wasted loop — the page is not responding the way you expect. STOP repeating. Take observe() with a focused query to find a different role/name/control, OR re-read your plan and choose a structurally different approach. If you genuinely cannot proceed, call ask_user or finish(success=false).',
          });
          recentToolHashes.length = 0;
        }
      }

      // ── Observer: snapshot AFTER and compute delta ──
      if (isStateChanging && before) {
        try {
          const tabCountAfter = ctx.context.pages().length;
          const after = await pageSnapshot(await ctx.getPage());
          let deltaText = renderDelta(before, after);
          // Detect new tab opened by the action
          if (tabCountAfter > tabCountBefore) {
            const activePage = await ctx.getPage();
            deltaText += `\n- New tab opened (${tabCountAfter} tabs total, active: ${activePage.url()})`;
          }
          if (deltaText) {
            result.text = result.text + '\n\n' + deltaText;
          }
          // Cache the post-mutation ariaSnapshot so the next observe()
          // can skip the redundant CDP call (~50-200ms savings).
          if (after.rawAriaYaml && after.url) {
            ctx.cachedAriaYaml = { url: after.url, yaml: after.rawAriaYaml };
            const activePage = await ctx.getPage();
            const { text: miniTree, refMap } = buildMiniTree(activePage, after.rawAriaYaml);
            if (miniTree) {
              result.text = result.text + '\n\n' + miniTree;
              const treeLines = after.rawAriaYaml.split('\n');
              ctx.lastObserveVisibleKeys = extractVisibleKeys(treeLines);
              ctx.refMap = refMap;
              needsObserveAfterNavigate = false;
              hasQueriedSinceLastScroll = true;
            }
          }
        } catch {
          /* Observer failure must never break the loop. */
        }
      }

      // ── control: finish ──
      if (result.control === 'finish') {
        log({
          type: 'finish',
          success: result.success ?? false,
          summary: result.summary ?? '',
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.text,
        } as any);
        terminal = {
          status: 'finished',
          success: result.success,
          summary: result.summary,
          steps: step,
          safetyStats: safety.stats(),
          history: extractHistory(),
        };
        break;
      }

      // ── control: respond ──
      // Non-blocking narrative channel: deliver the message to the REPL,
      // ack it in the tool result, and let the loop continue. The agent
      // can emit multiple respond calls across a run as it shares
      // findings or proposals without pausing to wait on a user answer.
      if (result.control === 'respond') {
        const message = result.message ?? '';
        log({ type: 'respond', text: message });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            'Message delivered to user. The run continues — keep working toward the goal. If you need a user reply, call ask_user separately; if the task is complete, call finish.',
        } as any);
        continue;
      }

      // ── control: ask_user ──
      if (result.control === 'ask_user') {
        const question = result.question ?? '';
        log({ type: 'ask_user', question });
        if (!opts.onAskUser) {
          terminal = {
            status: 'asked_user',
            question,
            steps: step,
            safetyStats: safety.stats(),
            history: extractHistory(),
          };
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'ask_user blocked: no user interface connected',
          } as any);
          break;
        }
        const answer = await opts.onAskUser(question);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `User answered: ${answer}`,
        } as any);
        continue;
      }

      // ── control: confirm_action ──
      if (result.control === 'confirm_action') {
        const intent = result.intent ?? '';
        const target = result.target ? ` (target: ${result.target})` : '';
        const prompt = `[CONFIRM REQUIRED] Agent wants to: ${intent}${target}\nReply "yes" to approve, anything else to deny.`;
        log({ type: 'ask_user', question: prompt });
        if (!opts.onAskUser) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'confirm_action blocked: no user interface connected',
          } as any);
          terminal = {
            status: 'asked_user',
            question: prompt,
            steps: step,
            safetyStats: safety.stats(),
            history: extractHistory(),
          };
          break;
        }
        const answer = await opts.onAskUser(prompt);
        if (isConfirmAffirmative(answer)) {
          safety.approve(intent);
          log({ type: 'safety_approved', intent });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `User APPROVED: "${intent}". You may now perform the previously blocked action EXACTLY ONCE. Retry it.`,
          } as any);
        } else {
          log({ type: 'safety_declined', intent });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `User DECLINED: "${intent}". User said: "${answer}". Do NOT perform that action. Choose a different approach or call finish.`,
          } as any);
        }
        continue;
      }

      // ── Normal tool result ──
      const cap = tc.function.name === 'observe' ? MAX_OBSERVE_CONTENT_CHARS : MAX_TOOL_CONTENT_CHARS;
      const text = capToolContent(result.text, cap);
      const head = text.split('\n')[0]?.slice(0, 200) ?? '';
      log({ type: 'observation', ok: result.ok, summary: head });

      // Detect safety block for telemetry.
      if (!result.ok && /^BLOCKED \(safety\)/.test(result.text)) {
        log({ type: 'safety_block', reason: result.text });
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: text,
      } as any);

      // Attach screenshot (if any) as a follow-up user message so vision
      // models can actually see it.
      if (result.image_base64) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `(screenshot from take_screenshot — tool_call_id=${tc.id})`,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${result.image_base64}`,
              },
            },
          ],
        } as any);
      }

      recentObs.push(observationHash(text));
      if (recentObs.length > 20) recentObs.shift();
    }

    if (terminal) return terminal;
  }

  log({ type: 'max_steps' });
  return {
    status: 'max_steps',
    steps: step,
    safetyStats: safety.stats(),
    history: extractHistory(),
  };
}
