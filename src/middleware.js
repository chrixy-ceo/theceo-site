import { loadContent } from './lib/content.js';

export async function onRequest(context, next) {
  try {
    await loadContent(context.locals.runtime?.env);
  } catch (e) {
    return new Response('<!doctype html><meta charset="utf-8"><title>Back soon</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#0d1117;color:#e6edf3"><p>We are updating the site. Please refresh in a moment.</p>', { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Retry-After': '30' } });
  }
  return next();
}
