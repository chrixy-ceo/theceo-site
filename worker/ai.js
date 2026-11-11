// Workers AI with a daily budget, so the site stays inside Cloudflare's free allowance
// (10,000 "neurons" per day). Usage is counted per UTC day in D1. When the budget is nearly
// used, or Cloudflare reports it is used up (error 4006), AI calls pause until the next day.
import { store } from './store.js';

export const WRITER = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';   // writes the final post
export const SCREENER = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';  // cheap yes/no checks
export const EMBED = '@cf/baai/bge-base-en-v1.5';

// Neurons per million tokens (Cloudflare pricing page).
const RATES = {
  [WRITER]: [26668, 204805],
  [SCREENER]: [4119, 34868],
  [EMBED]: [6058, 0],
};
export const DAILY_BUDGET = 8500; // leave headroom under the 10,000 free neurons

const day = () => new Date().toISOString().slice(0, 10);
const keyFor = () => 'ai:usage:' + day();

export class AIBudgetError extends Error {}

export async function aiUsage(env) {
  return Number((await store(env).get(keyFor())) || 0);
}

export async function aiRun(env, model, input) {
  if (!env.AI) throw new AIBudgetError('Workers AI is not connected.');
  const used = await aiUsage(env);
  if (used >= DAILY_BUDGET) throw new AIBudgetError('Daily free AI budget used up. Writing resumes after midnight UTC.');
  let res;
  try {
    res = await env.AI.run(model, input);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/4006|neurons|daily free allocation/i.test(msg)) {
      await store(env).put(keyFor(), String(DAILY_BUDGET));
      throw new AIBudgetError('Daily free AI budget used up. Writing resumes after midnight UTC.');
    }
    throw e;
  }
  // Count what this call cost, from the token usage Cloudflare reports (or an estimate).
  const [rin, rout] = RATES[model] || [27000, 205000];
  const tin = res?.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(input).length / 4);
  const tout = res?.usage?.completion_tokens ?? Math.ceil((typeof res?.response === 'string' ? res.response : JSON.stringify(res?.response ?? '')).length / 4);
  const cost = (tin * rin + tout * rout) / 1e6;
  await store(env).put(keyFor(), String(Math.round((used + cost) * 10) / 10));
  return res;
}

// Workers AI returns the answer either as text or, in JSON mode, already parsed. Accept both.
export function parseAI(res) {
  const r = res?.response ?? res?.result?.response;
  if (r === undefined) throw new Error('AI returned no answer');
  if (r && typeof r === 'object' && !Array.isArray(r)) return r;
  const t = String(r ?? '').replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI answer was not JSON: ' + t.slice(0, 120));
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch { throw new Error('AI answer was cut off or malformed: ' + t.slice(0, 120)); }
}
