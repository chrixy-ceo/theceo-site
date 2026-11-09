import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// Server-rendered on Cloudflare Workers; all content comes from D1 at request time.
// (Sitemap is served live by src/pages/sitemap.xml.ts.)
export default defineConfig({
  site: 'https://theceo.dev',
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough', platformProxy: { enabled: true } }),
  trailingSlash: 'ignore',
});
