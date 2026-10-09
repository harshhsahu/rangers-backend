import type { Request, Response } from 'express';

const CHATBOT_PATH = /^\/agents\/chatbot\/[\w-]+(\?versionId=[\w-]+)?$/;

/**
 * Web app manifest. `start` lets the chatbot page install the app so it launches straight into
 * that chatbot; anything that isn't a chatbot path falls back to "/". `id` stays fixed so every
 * chatbot is the same installed app.
 */
// Chrome sends the page's own URL as Referer when it fetches a same-origin manifest, so the route
// can work out the chatbot being viewed even if the page never rewrote the manifest link.
function refererPath(req: Request): string {
  try {
    const referer = new URL(req.get('referer') || '');
    const versionId = referer.searchParams.get('versionId');
    return `${referer.pathname}${versionId ? `?versionId=${versionId}` : ''}`;
  } catch {
    return '';
  }
}

export function getManifest(req: Request, res: Response) {
  const requested = typeof req.query.start === 'string' ? req.query.start : undefined;
  const startUrl = [requested, refererPath(req)].find((path) => path && CHATBOT_PATH.test(path)) || '/';

  res
    .set('Content-Type', 'application/manifest+json')
    .set('Cache-Control', 'no-store')
    .json({
      name: 'Rangers Agent Chat',
      short_name: 'Rangers Chat',
      description: 'Chat with your Rangers agent',
      id: '/',
      start_url: startUrl,
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#1c1714',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ],
    });
}
