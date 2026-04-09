import { llm, MODEL } from '../llm.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { COMPACTION_KEEP_ROUNDS } from '../config.js';

/**
 * Memory Summariser sub-agent — budget-triggered only.
 *
 * This sub-agent exists PURELY to control token budget on long runs. It
 * does NOT run periodically — only when the main agent's context exceeds
 * a threshold (HARD_TOKEN_CAP * 0.4 by default). On trigger:
 *
 *   1. Take all tool-result messages older than the last KEEP_RECENT pairs.
 *   2. Compress them into a 3-6 line text summary of "what the agent
 *      tried, what worked, what failed, what's currently visible".
 *   3. Drop those old tool results from history (after first replacing
 *      their content with a short placeholder so tool_call_id matching
 *      still works — openai protocol requires tool messages for every
 *      assistant tool_call).
 *   4. Insert the summary as a [MEMORY] user message near the top.
 *
 * Net effect: on a 20-step run that was about to hit 30k+ tokens, this
 * collapses history back to ~10k and lets the agent continue. Called 0-2
 * times per run in practice. Cheaper than periodic summarisation.
 *
 * This is the second sub-agent in the architecture (first is DOM).
 * Two specialised sub-agents, each earning their token cost.
 */

const SYSTEM = `You are a Memory Summariser for an autonomous browser agent that is running low on token budget.

You receive a transcript of the agent's recent actions and tool results. Your job: compress the ENTIRE slice into a dense 3-6 line memory the agent can still use.

Format (exact):
  - Tried: <actions taken>
  - Worked: <what succeeded>
  - Failed: <what didn't>
  - Current state: <where agent is now, URL/title/visible key elements>
  - Known facts: <any values/selectors/prices/names that matter going forward>

Rules:
- Be terse. No fluff. No preamble. No trailing remarks.
- Drop repeated observations, keep only the final state for each thing.
- Preserve concrete selectors/text that the agent might reuse.
- Never invent information not present in the transcript.`;

export interface SummariserOptions {
  model?: string;
}

/**
 * Summarise a slice of messages. Returns plain text (5-6 lines max).
 */
export async function summariseSlice(
  slice: ChatCompletionMessageParam[],
  opts: SummariserOptions = {},
): Promise<string> {
  const model = opts.model ?? MODEL;
  const rendered = renderSliceAsText(slice);
  if (!rendered.trim()) return '';
  const resp = await llm.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Transcript slice to compress:\n\n${rendered}\n\nProduce the memory now.`,
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() ?? '';
}

function renderSliceAsText(slice: ChatCompletionMessageParam[]): string {
  const lines: string[] = [];
  for (const m of slice) {
    const role = (m as any).role;
    const c = (m as any).content;
    if (role === 'assistant') {
      const tcs = (m as any).tool_calls as Array<{
        function?: { name?: string; arguments?: string };
      }> | undefined;
      if (tcs && tcs.length > 0) {
        for (const tc of tcs) {
          lines.push(
            `→ ${tc.function?.name ?? '?'}(${(tc.function?.arguments ?? '').slice(0, 200)})`,
          );
        }
      }
      if (typeof c === 'string' && c.trim()) {
        lines.push(`[think] ${c.slice(0, 200)}`);
      }
    } else if (role === 'tool') {
      const text = typeof c === 'string' ? c : '';
      lines.push(`  = ${text.slice(0, 300)}`);
    } else if (role === 'user') {
      if (typeof c === 'string') {
        lines.push(`[nudge] ${c.slice(0, 160)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Core maintenance routine. Called from the loop when estimateTokens()
 * exceeds a threshold. Mutates `messages` in place:
 *   - keeps first 2 system+user messages (prompt + initial goal)
 *   - keeps or merges an existing [MEMORY] marker
 *   - summarises everything between the marker and the last KEEP_RECENT
 *     assistant+tool round-trips
 *   - replaces the summarised tool messages' content with a short
 *     placeholder so tool_call_id pairing stays valid
 *
 * Returns { summarisedMessages, summaryText, keptRecent }.
 */
export interface CompactionResult {
  summarised: number;
  summary: string;
}

export async function compactHistoryIfNeeded(
  messages: ChatCompletionMessageParam[],
  opts: { keepRecentRounds?: number; model?: string } = {},
): Promise<CompactionResult | null> {
  const keepRounds = opts.keepRecentRounds ?? COMPACTION_KEEP_ROUNDS;

  // Identify tool-producing message pairs from the tail, preserve the
  // last `keepRounds`. Everything before them is eligible for summary.
  // An assistant message with tool_calls followed by matching tool
  // messages counts as one "round".
  const roundEnds: number[] = []; // indices of assistant-with-tool_calls messages
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      roundEnds.push(i);
    }
  }
  if (roundEnds.length <= keepRounds) return null;

  const cutoff = roundEnds[roundEnds.length - keepRounds]!; // first index to KEEP

  // We compact from index 0..cutoff (exclusive of cutoff). But we MUST
  // keep the leading system message AND the CURRENT goal (the LAST user
  // message that starts with "GOAL:" or is the most recent user turn in
  // a multi-turn REPL). In multi-turn sessions the initial goal (turn 1)
  // is stale — what matters is the LATEST goal the agent is working on.
  let startSummarise = 0;
  // Skip leading system messages
  while (startSummarise < messages.length && (messages[startSummarise] as any).role === 'system') {
    startSummarise++;
  }
  // Skip the first user message (initial goal or continuation)
  if ((messages[startSummarise] as any)?.role === 'user') {
    startSummarise++;
  }
  // If there is already a [MEMORY] marker right after that, skip past it
  // (it will be overwritten with the merged memory).
  const hasExistingMemory =
    (messages[startSummarise] as any)?.role === 'user' &&
    typeof (messages[startSummarise] as any)?.content === 'string' &&
    ((messages[startSummarise] as any).content as string).startsWith('[MEMORY]');
  let existingMemoryText = '';
  if (hasExistingMemory) {
    existingMemoryText = ((messages[startSummarise] as any).content as string)
      .replace(/^\[MEMORY\]\s*/, '')
      .trim();
  }

  // Find the LATEST user goal message (the current task in multi-turn REPL).
  // This is critical: without it, after compaction the agent forgets what
  // it's currently working on and reverts to an earlier task.
  let latestGoalIdx = -1;
  for (let i = cutoff - 1; i >= startSummarise; i--) {
    const m = messages[i] as any;
    if (m.role === 'user' && typeof m.content === 'string' &&
        !m.content.startsWith('[') && // not a nudge/memory/reflection
        m.content.length > 5) {
      latestGoalIdx = i;
      break;
    }
  }

  if (cutoff <= startSummarise) return null;

  // Build the slice to summarise — exclude the latest goal message
  // (it will be preserved separately).
  const sliceStart = hasExistingMemory ? startSummarise + 1 : startSummarise;
  const slice = messages.slice(sliceStart, cutoff).filter((_, i) => {
    const absIdx = sliceStart + i;
    return absIdx !== latestGoalIdx; // don't summarise the current goal
  });
  if (slice.length === 0) return null;

  const newMemoryRaw = await summariseSlice(slice, { model: opts.model });
  const merged = existingMemoryText
    ? `${existingMemoryText}\n---\n${newMemoryRaw}`
    : newMemoryRaw;
  if (!merged.trim()) return null;

  // Rewrite history:
  //   [system...] [first goal] [MEMORY: merged] [latest goal if different] [kept tail from cutoff..end]
  const leading = messages.slice(0, startSummarise);
  const tail = messages.slice(cutoff);
  // Extract the latest goal message if it's in the compacted range
  const latestGoalMsg = latestGoalIdx >= startSummarise && latestGoalIdx < cutoff
    ? messages[latestGoalIdx]
    : null;

  messages.length = 0;
  messages.push(...leading);
  messages.push({
    role: 'user',
    content: `[MEMORY] The following is a compressed memory of earlier actions in this session:\n${merged}`,
  });
  // Re-inject the current goal so the agent knows what it's working on NOW
  if (latestGoalMsg) {
    messages.push(latestGoalMsg);
  }
  messages.push(...tail);

  return {
    summarised: slice.length,
    summary: merged,
  };
}
