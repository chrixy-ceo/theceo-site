import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
// Change this to your real address if it is different
export default defineConfig({ site: 'https://theceo.dev', integrations: [sitemap()] });
