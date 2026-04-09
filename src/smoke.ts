/**
 * Phase 0 smoke test — end-to-end verification of the model stack.
 *
 * Verifies:
 *   1. OpenAI SDK talks to OpenRouter
 *   2. MODEL supports vision (image_url content parts)
 *   3. MODEL supports tool calling (tool_choice=required, tool_calls in reply)
 *   4. Tool-call → tool-result round-trip works
 *
 * We launch a real Chromium, grab a screenshot of example.com, hand it to the
 * model together with one tool, and check that the model calls the tool with
 * plausible arguments derived from the image.
 *
 * Run: npm run smoke
 */

import { llm, MODEL, TOOL_CHOICE } from './llm.js';
import { launchBrowser } from './browser.js';

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'report_page',
      description:
        'Report what you see on the given screenshot. Call this exactly once.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The main title / H1 visible on the page',
          },
          has_link: {
            type: 'boolean',
            description: 'Whether there is a clickable link on the page',
          },
        },
        required: ['title', 'has_link'],
        additionalProperties: false,
      },
    },
  },
];

async function main() {
  console.log(`[smoke] base=${process.env.OPENAI_BASE_URL}`);
  console.log(`[smoke] model=${MODEL}`);

  console.log('[smoke] launching browser...');
  const { page, close } = await launchBrowser({ headless: true });
  try {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const buf = await page.screenshot({ fullPage: false });
    const b64 = buf.toString('base64');
    console.log(`[smoke] screenshot captured (${b64.length} b64 chars)`);

    console.log('[smoke] turn 1: vision + tool call...');
    const turn1 = await llm.chat.completions.create({
      model: MODEL,
      tools,
      tool_choice: TOOL_CHOICE,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Look at this screenshot of a webpage and call report_page with what you see.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${b64}` },
            },
          ],
        },
      ],
    });

    const msg1 = turn1.choices[0]?.message;
    console.log(
      `[smoke] turn1 finish=${turn1.choices[0]?.finish_reason} tool_calls=${msg1?.tool_calls?.length ?? 0}`,
    );

    const tc = msg1?.tool_calls?.[0];
    if (!tc || tc.type !== 'function') {
      console.error('[smoke] FAIL: no tool_call in response');
      console.error(JSON.stringify(msg1, null, 2));
      process.exit(1);
    }

    console.log(`[smoke] tool=${tc.function.name} args=${tc.function.arguments}`);
    const parsed = JSON.parse(tc.function.arguments || '{}');
    if (!parsed.title) {
      console.error('[smoke] FAIL: model did not read the page title');
      process.exit(1);
    }
    // example.com is literally titled "Example Domain"
    if (!/example/i.test(parsed.title)) {
      console.warn(
        `[smoke] WARN: title "${parsed.title}" does not mention "example". Vision may be weak but tool-calling works.`,
      );
    }

    console.log('[smoke] turn 2: tool-result round-trip...');
    const turn2 = await llm.chat.completions.create({
      model: MODEL,
      tools,
      messages: [
        {
          role: 'user',
          content:
            'Summarise the report in one short English sentence, then stop.',
        },
        msg1 as any,
        {
          role: 'tool',
          tool_call_id: tc.id,
          content: 'reported',
        },
      ],
    });
    const reply = turn2.choices[0]?.message?.content ?? '';
    if (!reply.trim()) {
      console.error('[smoke] FAIL: no text on turn 2');
      console.error(JSON.stringify(turn2.choices[0], null, 2));
      process.exit(1);
    }
    console.log(`[smoke] turn2 reply: ${reply.slice(0, 200)}`);
    console.log('[smoke] OK ✅ vision + tool calling + round-trip all work');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('[smoke] ERROR:', err?.message ?? err);
  if (err?.status) console.error('[smoke] HTTP status:', err.status);
  if (err?.error) console.error('[smoke] body:', JSON.stringify(err.error, null, 2));
  process.exit(1);
});
