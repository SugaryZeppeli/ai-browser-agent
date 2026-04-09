import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import {
  KEEP_LAST_SCREENSHOTS,
  IMAGE_TOKEN_ESTIMATE,
  MAX_TOOL_CONTENT_CHARS,
} from '../config.js';

/**
 * Context management v2.
 *
 * Strategy: "screenshot decay" — keep only the most recent N screenshots
 * live; strip older image_url parts and replace them with a one-line text
 * placeholder so the historical turn is still coherent but costs nothing.
 */

const SCREENSHOT_PLACEHOLDER_TAG = '[screenshot decayed]';

export function decayScreenshots(
  messages: ChatCompletionMessageParam[],
  keep = KEEP_LAST_SCREENSHOTS,
): number {
  const imageIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    if (m.content.some((p: any) => p && p.type === 'image_url')) {
      imageIdxs.push(i);
    }
  }
  if (imageIdxs.length <= keep) return 0;
  const toDecay = imageIdxs.slice(0, imageIdxs.length - keep);
  let decayed = 0;
  for (const idx of toDecay) {
    const m = messages[idx] as any;
    const kept: any[] = [];
    let hadImage = false;
    for (const part of m.content) {
      if (part && part.type === 'image_url') {
        hadImage = true;
        continue;
      }
      kept.push(part);
    }
    if (hadImage) decayed++;
    if (!kept.some((p) => p && p.type === 'text')) {
      kept.push({ type: 'text', text: SCREENSHOT_PLACEHOLDER_TAG });
    }
    m.content = kept;
  }
  return decayed;
}

export function capToolContent(content: string, max = MAX_TOOL_CONTENT_CHARS): string {
  if (content.length <= max) return content;
  return (
    content.slice(0, max) +
    `\n\n…[TRUNCATED ${content.length - max} chars]`
  );
}

export function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          chars += part.text.length;
        } else if (part.type === 'image_url') {
          images++;
        }
      }
    }
    const tcs = (m as any).tool_calls as
      | Array<{ type: string; function?: { name: string; arguments?: string } }>
      | undefined;
    if (tcs) {
      for (const tc of tcs) {
        if (tc.type === 'function' && tc.function) {
          chars += tc.function.name.length + (tc.function.arguments?.length ?? 0);
        }
      }
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE;
}
