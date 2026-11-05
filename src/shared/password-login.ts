import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostConnectionHandle, ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';

type Services = { connection: Pick<HostConnectionHandle, 'requestRejection' | 'authorizeIndex' | 'authenticatedUrl'>;
    webServer: Pick<WebServer, 'register' | 'renderIndex'> };

/** Password admission exchanges through Connection; it never creates a second credential. */
export async function mountPasswordLogin(services: Services, passwordFile: string,
    indexFile = join(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/index.html')): Promise<() => void> {
    const password = Buffer.from((await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, ''));
    if (!password.length || password.length > 4096) throw new Error('Login password file must contain 1–4096 UTF-8 bytes');
    const { connection, webServer } = services;
    let failures = 0, windowStart = Date.now();
    const reply = (res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff', ...headers }); res.end(body);
    };
    const page = (res: ServerResponse, status = 200, error = '', signedIn = false) => reply(res, status, loginPage(error, signedIn), {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    const exchange = (req: IncomingMessage, response: ConnectionIndexResponse) => {
        const tokenUrl = new URL(connection.authenticatedUrl('http://dsh.invalid/'));
        connection.authorizeIndex({ headers: req.headers, method: 'GET', url: `${tokenUrl.pathname}${tokenUrl.search}` }, response);
    };
    const dispose: Array<() => void> = [];
    const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => {
        dispose.push(webServer.register({ kind: 'exact', path, handler: async (req, res) => {
            // 403 means the existing Host/Origin fence rejected this authority.
            if (connection.requestRejection(req) === 403) { reply(res, 403); return; }
            await handler(req, res);
        } }));
    };
    try {
        for (const path of ['/', '/index.html']) register(path, async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') { reply(res, 405, '', { allow: 'GET, HEAD' }); return; }
            if (connection.requestRejection(req) === 401 && !new URL(req.url!, 'http://dsh.invalid').searchParams.has('token')) {
                if (req.method === 'HEAD') reply(res, 200); else page(res); return;
            }
            if (!connection.authorizeIndex(req, res)) return;
            const html = webServer.renderIndex(await readFile(indexFile, 'utf8'))
                .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./"><meta name="hhpi-password-login" content="enabled">`);
            reply(res, 200, req.method === 'HEAD' ? '' : html, { 'content-type': 'text/html; charset=utf-8' });
        });
        register('/login', async (req, res) => {
            if (req.method === 'GET') { page(res, 200, '', connection.requestRejection(req) === undefined); return; }
            if (req.method !== 'POST') { reply(res, 405, '', { allow: 'GET, POST' }); return; }
            // Require a browser same-origin form, including when proxied over local HTTP.
            if (!sameOrigin(req)) { reply(res, 403); return; }
            if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { reply(res, 415); return; }
            if (Date.now() - windowStart >= 60_000) { failures = 0; windowStart = Date.now(); }
            if (failures >= 30) { reply(res, 429, '尝试次数过多，请稍后重试。', { 'retry-after': '60' }); return; }
            let body = '';
            for await (const chunk of req) {
                body += String(chunk);
                if (Buffer.byteLength(body) > 8192) { reply(res, 413); return; }
            }
            const values = new URLSearchParams(body).getAll('password');
            const supplied = Buffer.from(values.length === 1 ? values[0]! : '');
            if (supplied.length !== password.length || !timingSafeEqual(supplied, password)) {
                failures++; page(res, 401, '密码不正确，请重试。'); return;
            }
            failures = 0;
            exchange(req, res);
        });
        register('/login/logout', (req, res) => {
            if (req.method !== 'POST') { reply(res, 405, '', { allow: 'POST' }); return; }
            if (!sameOrigin(req) || connection.requestRejection(req) !== undefined) { reply(res, 403); return; }
            // Obtain the official cookie's name and attributes without copying its private format.
            let cookie: string | undefined;
            exchange(req, { writeHead(_status, headers) { cookie = headers?.['set-cookie']; }, end() {} });
            if (!cookie) throw new Error('Connection did not issue a browser cookie');
            const expired = cookie.replace(/^([^=]+)=[^;]*/, '$1=').replace(/Max-Age=\d+/, 'Max-Age=0')
                .replace(/Expires=[^;]+/, 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
            reply(res, 303, '', { 'set-cookie': expired, location: '/login' });
        });
    } catch (error) { for (const remove of dispose) remove(); password.fill(0); throw error; }
    return () => { for (const remove of dispose) remove(); password.fill(0); };
}

function sameOrigin(req: IncomingMessage): boolean {
    try {
        const origin = new URL(String(req.headers.origin));
        return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
    } catch { return false; }
}

export function loginPage(error = '', signedIn = false): string {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · HHPI</title><style>
:root{color-scheme:light dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7f7f5;color:#262626}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px}.card{width:100%;max-width:380px}header{margin-bottom:34px}.mark{width:44px;height:44px;display:grid;place-items:center;background:#262626;color:#fff;border-radius:12px;font-weight:700;letter-spacing:-2px;margin-bottom:26px}h1{font-size:26px;letter-spacing:-.7px;margin:0 0 10px;font-weight:600}p{color:#777;font-size:14px;line-height:1.65;margin:0}label{display:block;font-size:13px;margin-bottom:9px}input{width:100%;height:48px;border:1px solid #d7d7d2;border-radius:9px;background:#fff;color:inherit;padding:0 14px;font:inherit;outline:none}input:focus{border-color:#555;box-shadow:0 0 0 3px #8882}button,.back{width:100%;min-height:46px;border:0;border-radius:9px;background:#262626;color:#fff;font:inherit;font-size:14px;cursor:pointer;margin-top:18px;text-align:center;display:block;padding:13px;text-decoration:none}button:hover,.back:hover{opacity:.88}.error{color:#bd3434;margin-top:12px}.foot{margin-top:28px;font-size:12px;color:#999}.secondary{background:transparent;color:inherit;border:1px solid #8885}@media(prefers-color-scheme:dark){:root{background:#181818;color:#ededeb}.mark,button,.back{background:#ededeb;color:#222}input{background:#232323;border-color:#444}.secondary{background:transparent;color:inherit}p{color:#aaa}.error{color:#ff9898}}
</style></head><body><main class="card" data-login-page><header><div class="mark" aria-hidden="true">hh</div><h1>${signedIn ? '已登录' : '登录工作区'}</h1><p>${signedIn ? '此浏览器已连接到你的工作区。' : '输入访问密码，继续使用你的 HHPI 工作区。'}</p></header>${signedIn ? '<a class="back" href="/">返回工作区</a><form method="post" action="/login/logout"><button class="secondary" type="submit">退出登录</button></form>' : `<form method="post" action="/login"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus maxlength="4096">${error ? '<p class="error" role="alert">密码不正确，请重试。</p>' : ''}<button type="submit">登录</button></form>`}<p class="foot">HHPI · 私人工作区</p></main></body></html>`;
}
