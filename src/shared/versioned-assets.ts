import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';

/** The pinned Web shell already versions its JS/CSS filenames. The official
 * fallback serves them without cache headers, causing a full download on each
 * navigation. Give just those public assets an ordinary immutable HTTP cache;
 * index authentication, mutable files and all RPC routes retain their owner. */
export async function mountVersionedAssets(webServer: Pick<WebServer, 'register'>,
    directory = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'assets')): Promise<() => void> {
    const files = (await readdir(directory)).filter(file => /^[\w-]+-[\w-]{8,}\.(?:js|css)$/.test(file));
    const dispose: Array<() => void> = [];
    try {
        for (const file of files) dispose.push(webServer.register({ kind: 'exact', path: `/assets/${file}`, handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return;
            }
            let body: Buffer;
            try { body = await readFile(join(directory, file)); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return;
            }
            res.writeHead(200, {
                'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
                'content-length': body.byteLength, 'cache-control': 'public, max-age=31536000, immutable',
            });
            res.end(req.method === 'HEAD' ? undefined : body);
        } }));
    } catch (error) { for (const remove of dispose) remove(); throw error; }
    return () => { for (const remove of dispose) remove(); };
}
