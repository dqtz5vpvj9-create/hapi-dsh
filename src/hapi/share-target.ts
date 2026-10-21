/** Product routes registered through the unchanged official WebServer. No shared bytes reach the Host. */
import type { FederationMount } from '../hub/federation.ts';

export function mountShareTarget({ webServer }: Pick<FederationMount, 'webServer'>): () => void {
    // The original static manifest is a fallback asset. A named plugin route
    // can supply the composed product's manifest without altering that asset.
    const manifest = JSON.stringify({ name: 'HAPI DSH Workspace', short_name: 'HAPI', start_url: './', scope: './', display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        share_target: { action: 'hapi-dsh/share', method: 'POST', enctype: 'multipart/form-data',
            params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] } } });
    const cleanups = [webServer.register({ kind: 'exact', path: '/manifest.webmanifest', handler(request, response) {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return; }
        response.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : manifest);
    } }), webServer.register({ kind: 'exact', path: '/share', handler(request, response) {
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return; }
        const query = new URL(request.url ?? '/share', 'http://share.invalid').searchParams;
        const id = query.get('id');
        const target = query.get('error') === 'ingest' ? './?hapiShareError=ingest' : `./?hapiShare=${encodeURIComponent(id && id.length <= 256 ? id : 'incoming')}`;
        // No fragment is set: browser redirects carry the original #text/url/
        // fileUrl to the root. Its content never enters an HTTP request line.
        response.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end();
    } }), webServer.register({ kind: 'exact', path: '/hapi-dsh/share', handler(request, response) {
        // A working browser worker intercepts the POST. Do not parse or store
        // private multipart content on the Host if that worker is absent.
        response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'connection': 'close' });
        response.end('Open the HAPI workspace and let its browser service worker activate, then share again. This request was not saved or sent to a conversation.');
    } })];
    return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
