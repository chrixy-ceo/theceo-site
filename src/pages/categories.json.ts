// Category list used by the hourly news collector (worker/news.js).
import { cats } from '../lib/posts.js';
import { ops } from '../lib/ops.js';
export function GET() {
  const blog = cats.map((c) => c.name);
  const infobytes = [...new Set(ops.map((o) => o.category).filter(Boolean))];
  return new Response(JSON.stringify({ blog, infobytes, all: [...new Set([...blog, ...infobytes])] }), { headers: { 'Content-Type': 'application/json' } });
}
