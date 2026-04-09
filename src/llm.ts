import OpenAI from 'openai';
import 'dotenv/config';


export const llm = new OpenAI({
  defaultHeaders: {
    'HTTP-Referer': 'https://github.com/local/ai-browser-agent',
    'X-Title': 'ai-browser-agent',
  },
});


export const MODEL = process.env.MODEL ?? 'google/gemini-2.5-flash';

export const DOM_MODEL = process.env.DOM_MODEL ?? 'openai/gpt-oss-20b:free';

const rawToolChoice = process.env.TOOL_CHOICE;
if (rawToolChoice && rawToolChoice !== 'required' && rawToolChoice !== 'auto') {
  throw new Error(`TOOL_CHOICE must be 'required' or 'auto', got '${rawToolChoice}'`);
}
export const TOOL_CHOICE: 'required' | 'auto' =
  (rawToolChoice as 'required' | 'auto') || 'required';
