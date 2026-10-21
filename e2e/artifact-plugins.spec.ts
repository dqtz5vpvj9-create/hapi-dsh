import { readFile } from 'node:fs/promises';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';
import type { LegacyDocumentRef, LegacyWorkspaceSnapshot } from '../src/legacy-workspace-types.ts';

// Real binary fixture assets, independently readable by the unchanged official
// image/PDF plugins. Office conversion itself remains an explicit wire fixture.
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=', 'base64');
function pdf(text: string): Buffer {
    const stream = `BT /F1 18 Tf 32 120 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    ];
    let body = '%PDF-1.4\n'; const offsets = [0];
    for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
    const start = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return Buffer.from(body);
}
const artifact = (artifactId: string, fileName: string, mimeType: string): LegacyDocumentRef => ({ kind: 'artifact', artifactId, fileName, mimeType });
const pane = (id: string, sourceSessionId: string, document: LegacyDocumentRef) => ({ type: 'pane' as const, id, resource: { kind: 'document' as const, sessionId: sourceSessionId, document } });
const window = (id: string, name: string, sourceSessionId: string, document: LegacyDocumentRef): LegacyWorkspaceSnapshot['workspaces'][number] => ({
    id, name, autoName: false, root: pane(`${id}-pane`, sourceSessionId, document),
});
async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl);
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    await notice.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function imageLoaded(image: Locator): Promise<void> {
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

test.describe('original HAPI documents in official DSH plugin panes', () => {
    let environment: OfficialEnvironment;
    test.beforeEach(async () => { environment = await startOfficialEnvironment(); });
    test.afterEach(async () => { await environment?.close(); });

    test('legacy session-file and opaque Markdown restore with source-scoped images and durable official viewer navigation', async ({ page }, info) => {
        const failures: string[] = [], requests: string[] = [];
        page.on('pageerror', error => failures.push(error.message));
        page.on('request', request => requests.push(request.url()));
        const filePath = '/workspace/alpha/docs/readme.md';
        const alphaImage = '/workspace/alpha/images/source.png', betaImage = '/workspace/beta/source.png';
        const opaqueId = 'codex-artifact:thread-beta/report/markdown';
        environment.hapi.workbench.directories.get('native-alpha')!.set('/workspace/alpha/docs', 1);
        environment.hapi.workbench.directories.get('native-alpha')!.set('/workspace/alpha/images', 1);
        environment.hapi.workbench.updateFile('native-alpha', filePath, '# Alpha source document\n\n![Relative alpha image](../images/source.png)\n\n![Absolute alpha image](/workspace/alpha/images/source.png)\n', 'text/markdown');
        environment.hapi.workbench.updateFile('native-alpha', alphaImage, pixel, 'image/png');
        environment.hapi.workbench.updateFile('native-beta', betaImage, pixel, 'image/png');
        environment.hapi.artifacts.set('native-beta', opaqueId, { fileName: 'source-report.md', mimeType: 'text/markdown', bytes: Buffer.from('# Beta opaque source report\n\n![Beta source image](/workspace/beta/source.png)\n\n![No guessed artifact directory](unowned-relative.png)\n') });
        environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 8, workspaces: [{ id: 'source-documents', name: 'Original documents', autoName: false,
            root: { type: 'split', id: 'source-documents-split', axis: 'horizontal', weights: [1, 1], children: [
                pane('source-file-pane', 'native-alpha', artifact(`session-file:${Buffer.from(filePath).toString('base64url')}`, 'readme.md', 'text/markdown')),
                pane('source-artifact-pane', 'native-beta', artifact(opaqueId, 'source-report.md', 'text/markdown')),
            ] } }] };
        const sourceFile = page.locator('[data-pane-id="source-file-pane"]');
        const sourceArtifact = page.locator('[data-pane-id="source-artifact-pane"]');
        try {
            await admit(page, environment);
            await expect(sourceFile.getByRole('heading', { name: 'Alpha source document', exact: true })).toBeVisible();
            await expect(sourceArtifact.getByRole('heading', { name: 'Beta opaque source report', exact: true })).toBeVisible();
            await imageLoaded(sourceFile.getByRole('img', { name: 'Relative alpha image', exact: true }));
            await imageLoaded(sourceFile.getByRole('img', { name: 'Absolute alpha image', exact: true }));
            await imageLoaded(sourceArtifact.getByRole('img', { name: 'Beta source image', exact: true }));
            await expect(sourceArtifact.getByRole('img', { name: 'No guessed artifact directory', exact: true })).toHaveCount(0);
            expect(requests.some(value => value.includes('unowned-relative.png'))).toBe(false);
            expect(environment.hapi.artifacts.requests.filter(value => value.route.startsWith('artifacts/')).every(value => value.sessionId === 'native-beta' && value.artifactId === opaqueId)).toBe(true);
            const images = environment.hapi.workbench.fileRequests.filter(value => value.path.endsWith('.png'));
            expect(images).toEqual(expect.arrayContaining([
                expect.objectContaining({ sessionId: 'native-alpha', machineId: 'machine-alpha', path: alphaImage }),
                expect.objectContaining({ sessionId: 'native-beta', machineId: 'machine-beta', path: betaImage }),
            ]));
            const media = requests.map(value => new URL(value)).filter(value => value.pathname === '/hapi-dsh/workbench/document');
            expect(media.length).toBeGreaterThanOrEqual(3);
            const addresses = media.map(value => JSON.parse(value.searchParams.get('request')!) as { source: { sourceSessionId: string; sourceHubId: string; machineId?: string }; document: { path: string } });
            // Legacy references may omit machineId; the server resolves and
            // verifies the real machine from that source session (logs above).
            expect(addresses.every(value => value.source.sourceHubId === 'e2e-native-hub' && (value.source.sourceSessionId === 'native-alpha'
                ? (!value.source.machineId || value.source.machineId === 'machine-alpha') && value.document.path.startsWith('/workspace/alpha/')
                : value.source.sourceSessionId === 'native-beta' && (!value.source.machineId || value.source.machineId === 'machine-beta') && value.document.path.startsWith('/workspace/beta/')))).toBe(true);
            // No image is sent to the original serving-Host /fs/file/media route.
            expect(requests.some(value => { const url = new URL(value); return /\/fs\/|\/file\/media|\/files\/media/.test(url.pathname); })).toBe(false);
            const viewer = sourceArtifact.getByRole('combobox', { name: 'Document viewer', exact: true });
            await viewer.selectOption('text');
            await expect(sourceArtifact.locator('[data-textpreview-plain]')).toContainText('# Beta opaque source report');
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
            await page.reload();
            await expect(sourceFile.getByRole('heading', { name: 'Alpha source document', exact: true })).toBeVisible();
            await expect(viewer).toHaveValue('text');
            await expect(sourceArtifact.locator('[data-textpreview-plain]')).toContainText('# Beta opaque source report');
            await imageLoaded(sourceFile.getByRole('img', { name: 'Relative alpha image', exact: true }));
            const saved = await environment.rpc<{ state: { windows: Array<{ root: { children: Array<{ resource: { sourceSessionId: string; document: LegacyDocumentRef; target?: { contentId?: string; params?: { viewer?: string } } } }> } }> } }>('hapi/workspaceGet');
            const preserved = saved.state.windows[0]!.root.children[1]!.resource;
            expect(preserved.sourceSessionId).toBe('native-beta');
            expect(preserved.document).toEqual(artifact(opaqueId, 'source-report.md', 'text/markdown'));
            await page.screenshot({ path: `${info.outputDir}/official-source-markdown.png`, fullPage: true });
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
            await expect(page.locator('iframe')).toHaveCount(0);
            expect(failures).toEqual([]);
        } finally {
            await info.attach('source-document-reads', { body: JSON.stringify({ artifacts: environment.hapi.artifacts.requests, files: environment.hapi.workbench.fileRequests, failures }, null, 2), contentType: 'application/json' });
        }
    });

    test('opaque PDF, image, code and static HTML use official bodies while Office previews preserve original downloads', async ({ page }, info) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const originalOffice = Buffer.from('Explicit original Office document bytes: conversion is supplied fixture output.');
        const values = [
            { id: 'pdf', label: 'Original PDF', source: 'native-alpha', fileName: 'source.pdf', mimeType: 'application/pdf', bytes: pdf('PDF from source alpha') },
            { id: 'office', label: 'Office preview', source: 'native-beta', fileName: 'source.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: originalOffice, preview: pdf('Converted source beta fixture') },
            { id: 'image', label: 'Source image', source: 'native-beta', fileName: 'source.png', mimeType: 'image/png', bytes: pixel },
            { id: 'code', label: 'Source code', source: 'native-alpha', fileName: 'source.ts', mimeType: 'text/plain', bytes: Buffer.from('export const fromOriginalSource = "machine-alpha";\n') },
            { id: 'html', label: 'Source HTML', source: 'native-alpha', fileName: 'source.html', mimeType: 'text/html', bytes: Buffer.from('<!doctype html><h1>Static original artifact</h1><script>document.body.dataset.executed="yes"</script>') },
        ];
        environment.hapi.legacyWorkspaces = { schemaVersion: 2, revision: 9, workspaces: values.map(value => {
            const id = `codex-artifact:real-source/${value.id}`;
            environment.hapi.artifacts.set(value.source, id, value);
            return window(`artifact-${value.id}`, value.label, value.source, artifact(id, value.fileName, value.mimeType));
        }) };
        const select = async (id: string, label: string): Promise<Locator> => {
            await page.locator('.hapi-window-tabs').getByRole('tab').filter({ has: page.locator(`.hapi-window-label`, { hasText: values.find(value => value.id === id)!.fileName }) }).click();
            const result = page.locator(`[data-pane-id="artifact-${id}-pane"]`);
            await expect(result).toBeVisible(); return result;
        };
        try {
            await admit(page, environment);
            const pdfPane = await select('pdf', 'Original PDF');
            await expect(pdfPane.locator('[data-pdf-page="1"] canvas')).toBeVisible();
            await expect.poll(() => pdfPane.locator('[data-pdf-page="1"] canvas').evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
            await expect(pdfPane.locator('[data-pdf-text]')).toContainText('PDF from source alpha');
            const office = await select('office', 'Office preview');
            await expect(office.locator('[data-pdf-text]')).toContainText('Converted source beta fixture');
            await expect(office.getByText('PDF produced by the original HAPI document conversion service. Download keeps the original file.', { exact: true })).toBeVisible();
            const downloadPromise = page.waitForEvent('download');
            await office.getByRole('button', { name: 'Download original', exact: true }).click();
            const download = await downloadPromise;
            expect(download.suggestedFilename()).toBe('source.docx');
            expect(await readFile((await download.path())!)).toEqual(originalOffice);
            expect(environment.hapi.artifacts.requests.filter(value => value.route === 'document-preview')).toEqual([
                expect.objectContaining({ sessionId: 'native-beta', machineId: 'machine-beta', artifactId: 'codex-artifact:real-source/office', method: 'POST' }),
            ]);
            const image = await select('image', 'Source image');
            await imageLoaded(image.getByRole('img', { name: 'source.png', exact: true }));
            await image.getByRole('button', { name: 'Open original image', exact: true }).click();
            await expect(page.getByRole('dialog', { name: 'Source image', exact: true })).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog', { name: 'Source image', exact: true })).toHaveCount(0);
            const code = await select('code', 'Source code');
            await expect(code.locator('.hapi-artifact-code')).toContainText('export const fromOriginalSource = "machine-alpha";');
            const html = await select('html', 'Source HTML');
            const frame = html.locator('iframe[data-html-preview]');
            await expect(frame).toHaveAttribute('sandbox', '');
            await expect(frame.contentFrame().getByRole('heading', { name: 'Static original artifact', exact: true })).toBeVisible();
            await expect(frame.contentFrame().locator('body')).not.toHaveAttribute('data-executed', 'yes');
            await page.screenshot({ path: `${info.outputDir}/official-source-artifact.png`, fullPage: true });
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
            // Only the official sandboxed HTML content frame exists; no Host app frame.
            await expect(page.locator('iframe:not([data-html-preview])')).toHaveCount(0);
            expect(errors).toEqual([]);
        } finally {
            await info.attach('artifact-source-requests', { body: JSON.stringify({ requests: environment.hapi.artifacts.requests, errors }, null, 2), contentType: 'application/json' });
        }
    });
});
