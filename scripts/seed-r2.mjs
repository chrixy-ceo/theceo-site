// Copies every file in public/uploads into the R2 media bucket (skips ones already there),
// so the admin's media library shows all existing images.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const remote = !process.argv.includes('--local');
for (const f of readdirSync('public/uploads')) {
  const args = ['wrangler', 'r2', 'object', 'put', `theceo-media/${f}`, '--file', `public/uploads/${f}`, remote ? '--remote' : '--local'];
  try { execFileSync('npx', args, { stdio: 'ignore' }); console.log('uploaded', f); } catch { console.log('failed', f); }
}
