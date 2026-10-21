import { test, expect, type Locator, type Page } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

async function admit(page: Page, environment: OfficialEnvironment): Promise<void> {
    await page.goto(environment.launchUrl);
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function openTool(page: Page, pane: Locator, name: 'Project files' | 'Terminal'): Promise<Locator> {
    const ids = new Set(await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id'))));
    const menu = pane.locator('.hapi-pane-header > .hapi-pane-menu');
    await menu.locator('summary').click();
    await menu.getByRole('button', { name, exact: true }).click();
    await expect.poll(async () => (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).filter(id => !ids.has(id)).length).toBe(1);
    const id = (await page.locator('.hapi-pane').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-pane-id')))).find(id => !ids.has(id))!;
    return page.locator(`[data-pane-id="${id}"]`);
}
const closePane = async (pane: Locator): Promise<void> => { await pane.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click(); };

test.describe('official plugin views inside the unified HAPI workspace', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(); });
    test.afterAll(async () => { await environment?.close(); });

    test('official Files and Terminal retain machine identity, resource state, and PTYs across reload and pane close', async ({ page }, info) => {
        const errors: string[] = [], diagnostics: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') diagnostics.push(message.text()); });
        try {
            await admit(page, environment);
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
            const chat = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
            await expect(chat.getByText('Native history alpha in the official DSH Conversation.', { exact: true })).toBeVisible();
            const alphaFile = await openTool(page, chat, 'Project files');
            await expect(alphaFile.locator('[data-files-root]')).toHaveAttribute('data-files-root', '/workspace/alpha');
            await alphaFile.locator('[data-files-entry="file"]').getByRole('button', { name: 'source.txt', exact: true }).click();
            await expect(alphaFile.getByText('Source file from machine-alpha', { exact: true })).toBeVisible();
            await chat.locator('.hapi-pane-header').click();
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
            const betaChat = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
            await expect(betaChat.getByText('Native history beta in the official DSH Conversation.', { exact: true })).toBeVisible();
            const betaFile = await openTool(page, betaChat, 'Project files');
            await expect(betaFile.locator('[data-files-root]')).toHaveAttribute('data-files-root', '/workspace/beta');
            await betaFile.locator('[data-files-entry="file"]').getByRole('button', { name: 'source.txt', exact: true }).click();
            await expect(betaFile.getByText('Source file from machine-beta', { exact: true })).toBeVisible();
            await closePane(betaChat);
            await expect(page.locator('.hapi-pane')).toHaveCount(2);
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
            await page.reload();
            await expect(alphaFile.getByText('Source file from machine-alpha', { exact: true })).toBeVisible();
            await expect(betaFile.getByText('Source file from machine-beta', { exact: true })).toBeVisible();
            await expect(alphaFile.getByText('Source file from machine-beta', { exact: true })).toHaveCount(0);
            const reads = environment.hapi.workbench.fileRequests.filter(row => row.route === 'filesystem/download');
            expect(reads.some(row => row.sessionId === 'native-alpha' && row.path === '/workspace/alpha/source.txt')).toBe(true);
            expect(reads.some(row => row.sessionId === 'native-beta' && row.path === '/workspace/beta/source.txt')).toBe(true);
            expect(reads.every(row => row.path.startsWith(`/workspace/${row.sessionId.replace('native-', '')}/`))).toBe(true);

            const alphaTerminal = await openTool(page, alphaFile, 'Terminal');
            await expect(alphaTerminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await alphaTerminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('alpha-source-input\r');
            await expect.poll(() => environment.hapi.workbench.terminalInputs.filter(row => row.machineId === 'machine-alpha').map(row => row.data).join('')).toBe('alpha-source-input\r');
            await closePane(alphaFile);
            const betaTerminal = await openTool(page, betaFile, 'Terminal');
            await expect(betaTerminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await betaTerminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('beta-source-input\r');
            await expect.poll(() => environment.hapi.workbench.terminalInputs.filter(row => row.machineId === 'machine-beta').map(row => row.data).join('')).toBe('beta-source-input\r');
            await closePane(betaFile);
            const creations = environment.hapi.workbench.terminalCommands.filter(row => row.command.type === 'create');
            expect(creations).toHaveLength(2);
            expect(creations).toEqual(expect.arrayContaining([
                expect.objectContaining({ machineId: 'machine-alpha', command: expect.objectContaining({ cwd: '/workspace/alpha' }) }),
                expect.objectContaining({ machineId: 'machine-beta', command: expect.objectContaining({ cwd: '/workspace/beta' }) }),
            ]));
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible();
            await page.reload();
            await expect(alphaTerminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await expect(betaTerminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await alphaTerminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('after-reload\r');
            await expect.poll(() => environment.hapi.workbench.terminalInputs.filter(row => row.machineId === 'machine-alpha').map(row => row.data).join('')).toBe('alpha-source-input\rafter-reload\r');
            expect(environment.hapi.workbench.terminalCommands.filter(row => row.command.type === 'create')).toHaveLength(2);
            await page.screenshot({ path: `${info.outputDir}/official-source-terminals.png`, fullPage: true });
            await closePane(alphaTerminal);
            await closePane(betaTerminal);
            expect(environment.hapi.workbench.terminalCommands.filter(row => row.command.type === 'terminate')).toHaveLength(0);
            expect([...environment.hapi.workbench.terminals.values()].map(row => row.info.status)).toEqual(['running', 'running']);
            await expect(page.locator('.hapi-session-sidebar')).toHaveCount(1);
            await expect(page.locator('iframe')).toHaveCount(0);
            expect(errors).toEqual([]);
        } finally {
            if (diagnostics.length) await info.attach('plugin-browser-diagnostics', { body: diagnostics.join('\n').replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'), contentType: 'text/plain' });
            await info.attach('source-requests', { body: JSON.stringify({ files: environment.hapi.workbench.fileRequests, terminals: environment.hapi.workbench.terminalCommands }, null, 2), contentType: 'application/json' });
        }
    });

    test('source file actions extend official views with CAS editing, recovery, search, Git, management, and uploads', async ({ page }, info) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const root = '/workspace/alpha', file = `${root}/source.txt`;
        const source = environment.hapi.workbench;
        const bytes = (path: string) => source.files.get('native-alpha')?.get(path)?.bytes.toString();
        await admit(page, environment);
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
        const chat = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
        const pane = await openTool(page, chat, 'Project files');
        await pane.locator('[data-files-entry="file"]').getByRole('button', { name: 'source.txt', exact: true }).click();
        await expect(pane.getByText('Source file from machine-alpha', { exact: true })).toBeVisible();
        await closePane(chat);
        const dialog = page.getByRole('dialog', { name: 'Source file tools', exact: true });
        const contents = dialog.getByRole('textbox', { name: 'File contents', exact: true });
        const close = () => dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
        const edit = async () => {
            await pane.getByRole('button', { name: 'Edit source file', exact: true }).click();
            await expect(contents).toBeEditable();
        };
        const manage = async () => {
            await pane.getByRole('button', { name: 'Source file tools', exact: true }).click();
            await dialog.getByRole('navigation').getByRole('button', { name: 'Manage files', exact: true }).click();
        };
        const saves = () => source.fileWrites.filter(row => row.route === 'file' && row.sessionId === 'native-alpha');

        await edit(); await contents.fill('Saved by the official preview source action\n');
        await dialog.getByRole('button', { name: 'Save source file', exact: true }).click();
        await expect(dialog.getByText('Source confirmed the saved revision.', { exact: true })).toBeVisible();
        expect(bytes(file)).toBe('Saved by the official preview source action\n');
        await close();
        await expect(pane.getByText('Saved by the official preview source action', { exact: true })).toBeVisible();

        await edit(); await contents.fill('My draft survives another editor\n');
        source.updateFile('native-alpha', file, 'Written by another source editor\n');
        await dialog.getByRole('button', { name: 'Save source file', exact: true }).click();
        await expect(dialog.getByText('The source file changed after this editor read it', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Save source file', exact: true })).toBeDisabled();
        expect(saves()).toHaveLength(2); expect(bytes(file)).toBe('Written by another source editor\n');
        await dialog.getByRole('button', { name: 'Inspect current source', exact: true }).click();
        await expect(dialog.getByText('Written by another source editor', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Keep draft using this source revision', exact: true }).click();
        await dialog.getByRole('button', { name: 'Save source file', exact: true }).click();
        await expect.poll(() => bytes(file)).toBe('My draft survives another editor\n');
        await expect(dialog.getByText('Source confirmed the saved revision.', { exact: true })).toBeVisible();
        await close();

        await edit(); await contents.fill('Saved once despite a lost acknowledgement\n'); source.loseNextSaveAcknowledgement = true;
        await dialog.getByRole('button', { name: 'Save source file', exact: true }).click();
        await expect(dialog.getByText(/The source result is unconfirmed or changed/)).toBeVisible();
        expect(saves()).toHaveLength(4); expect(bytes(file)).toBe('Saved once despite a lost acknowledgement\n');
        page.once('dialog', confirm => { void confirm.accept(); });
        await page.reload(); await expect(pane).toBeVisible(); await edit();
        await expect(contents).toHaveValue('Saved once despite a lost acknowledgement\n');
        await expect(dialog.getByText(/The source result is unconfirmed or changed/)).toBeVisible();
        expect(saves()).toHaveLength(4);
        await dialog.getByRole('button', { name: 'Inspect current source', exact: true }).click();
        await expect(dialog.locator('.hapi-source-diff')).toHaveText(/Saved once despite a lost acknowledgement/);
        await dialog.getByRole('button', { name: 'Use current source contents', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Save source file', exact: true })).toBeDisabled();
        expect(saves()).toHaveLength(4); await close();

        await edit(); await contents.fill('Retained draft after a refused pane close'); await close();
        page.once('dialog', confirm => { void confirm.dismiss(); });
        await closePane(pane); await expect(pane).toBeVisible();
        await edit(); await expect(contents).toHaveValue('Retained draft after a refused pane close');
        page.once('dialog', confirm => { void confirm.accept(); });
        await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click(); await close();

        await manage(); await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('copy');
        await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click();
        await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Destination path', exact: true }).fill(`${root}/copy.txt`);
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog).toBeHidden(); expect(bytes(`${root}/copy.txt`)).toBe(bytes(file));

        await manage(); await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('rename');
        await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click();
        await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.txt');
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog).toBeHidden(); expect(bytes(`${root}/copy.txt`)).toBeUndefined(); expect(bytes(`${root}/renamed.txt`)).toBe(bytes(file));

        await manage(); await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('move');
        await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click();
        await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Destination path', exact: true }).fill(`${root}/src/moved.txt`);
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog).toBeHidden(); expect(bytes(`${root}/renamed.txt`)).toBeUndefined(); expect(bytes(`${root}/src/moved.txt`)).toBe(bytes(file));

        await manage(); await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('create-directory');
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('actions');
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog.getByRole('textbox', { name: 'Source path', exact: true })).toHaveValue(`${root}/src/actions`);
        await expect(dialog.getByRole('textbox', { name: 'Upload directory', exact: true })).toHaveValue(`${root}/src/actions`);
        await dialog.getByLabel('Upload files', { exact: true }).setInputFiles([
            { name: 'upload-a.txt', mimeType: 'text/plain', buffer: Buffer.from('Upload A source bytes\n') },
            { name: 'upload-b.txt', mimeType: 'text/plain', buffer: Buffer.from('Upload B source bytes\n') },
        ]);
        await expect.poll(() => bytes(`${root}/src/actions/upload-b.txt`)).toBe('Upload B source bytes\n');
        await expect(dialog.getByText('Source confirmed this operation.', { exact: true })).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('created.txt');
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog).toBeHidden(); expect(bytes(`${root}/src/actions/created.txt`)).toBe('');
        await edit(); await contents.fill('New file edited through its official preview\n');
        await dialog.getByRole('button', { name: 'Save source file', exact: true }).click();
        await expect(dialog.getByText('Source confirmed the saved revision.', { exact: true })).toBeVisible(); await close();
        await manage(); await dialog.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('delete');
        await dialog.getByRole('button', { name: 'Inspect target', exact: true }).click();
        await expect(dialog.getByText(/Inspected source revision:/)).toBeVisible();
        page.once('dialog', confirm => { void confirm.accept(); });
        await dialog.getByRole('button', { name: 'Apply source operation', exact: true }).click();
        await expect(dialog.getByText('Source confirmed this operation.', { exact: true })).toBeVisible();
        expect(bytes(`${root}/src/actions/created.txt`)).toBeUndefined();
        await dialog.getByRole('navigation').getByRole('button', { name: 'Find files', exact: true }).click();
        await dialog.getByRole('textbox', { name: 'Search file names', exact: true }).fill('source.txt');
        await dialog.getByRole('button', { name: 'source.txt', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(pane.getByText('Saved once despite a lost acknowledgement', { exact: true })).toBeVisible();
        await pane.getByRole('button', { name: 'Source file tools', exact: true }).click();
        await dialog.getByRole('navigation').getByRole('button', { name: 'Git changes', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'source.txt', exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'source.txt', exact: true }).click();
        await expect(dialog.locator('.hapi-source-diff')).toContainText('diff --git a/source.txt b/source.txt');
        await expect(dialog.locator('.hapi-source-diff')).toContainText('+Saved once despite a lost acknowledgement');
        await page.screenshot({ path: `${info.outputDir}/official-source-file-actions.png`, fullPage: true });
        await close();
        expect(source.fileWrites.every(row => row.sessionId === 'native-alpha' && row.machineId === 'machine-alpha')).toBe(true);
        expect(source.files.get('native-beta')!.get('/workspace/beta/source.txt')!.bytes.toString()).toBe('Source file from machine-beta\nWorkspace /workspace/beta\n');
        expect(errors).toEqual([]);
    });
    test('mobile terminal accessories reuse the official input owner and retain shared custom keys', async ({ browser }, info) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, locale: 'en-US' });
        const page = await context.newPage(), errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const source = environment.hapi.workbench;
        const createCount = () => source.terminalCommands.filter(row => row.command.type === 'create').length;
        const before = createCount();
        try {
            await admit(page, environment);
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
            const chat = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
            const terminal = await openTool(page, chat, 'Terminal');
            await expect(terminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await closePane(chat);
            const bar = terminal.locator('[data-testid="termbeam-touchbar"]');
            await expect(bar.getByRole('button', { name: 'Control', exact: true })).toBeEnabled();
            const allocated = [...source.terminals.values()].findLast(row => row.machineId === 'machine-alpha')!;
            const inputs = () => source.terminalInputs.filter(row => row.terminalId === allocated.info.terminalId).map(row => row.data);
            await page.setViewportSize({ width: 420, height: 860 });
            await bar.getByRole('button', { name: 'Control', exact: true }).tap();
            await terminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('cn');
            await expect.poll(inputs).toEqual(['\x03', 'n']);

            // Native pointer hold exercises the same repeat path used by touch.
            const up = bar.getByRole('button', { name: 'Arrow up', exact: true });
            await up.hover(); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
            await expect.poll(() => inputs().filter(value => value === '\x1b[A').length).toBeGreaterThanOrEqual(2);
            const heldInputs = inputs().length;
            await page.waitForTimeout(180); expect(inputs()).toHaveLength(heldInputs);

            const options = page.getByRole('dialog', { name: 'Keyboard options', exact: true });
            const menu = async () => {
                await bar.getByRole('button', { name: 'Show or hide keyboard', exact: true }).hover();
                await page.mouse.down(); await page.waitForTimeout(550); await page.mouse.up();
                await expect(options).toBeVisible();
            };
            await menu(); await options.getByRole('button', { name: 'Customize keys', exact: true }).click();
            const editor = page.getByRole('dialog', { name: 'Customize keys', exact: true });
            await editor.getByRole('combobox', { name: 'Key to edit', exact: true }).selectOption('');
            await editor.getByLabel('Label', { exact: true }).fill('Check machine');
            await editor.getByRole('combobox', { name: 'Action', exact: true }).selectOption('raw');
            await editor.getByRole('textbox', { name: 'Text to send', exact: true }).fill('printf source\\r');
            await editor.getByRole('button', { name: 'Add key', exact: true }).click();
            await editor.getByRole('combobox', { name: 'Placement', exact: true }).selectOption('0');
            await editor.getByRole('combobox', { name: 'Navigation layout', exact: true }).selectOption('inline');
            await editor.getByLabel('Uniform grid', { exact: true }).check();
            await editor.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
            await bar.getByRole('button', { name: 'Snippets', exact: true }).tap();
            await page.getByRole('dialog', { name: 'Snippets', exact: true }).getByRole('button', { name: 'Check machine', exact: true }).click();
            await expect.poll(() => inputs().at(-1)).toBe('printf source\r');

            await menu(); await options.getByRole('button', { name: 'Command', exact: true }).click();
            await terminal.getByRole('textbox', { name: 'Command input', exact: true }).fill('echo mobile');
            await terminal.getByRole('button', { name: 'Run command', exact: true }).click();
            await expect.poll(() => inputs().at(-1)).toBe('echo mobile\r');

            await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.origin });
            await page.evaluate(async () => { await navigator.clipboard.writeText('pasted one\npasted two'); });
            source.writeTerminalOutput('machine-alpha', allocated.info.terminalId, '\x1b[?2004h\r\nBracketed paste ready\r\n');
            await expect(terminal.locator('.xterm-rows')).toContainText('Bracketed paste ready');
            await menu(); await options.getByRole('button', { name: 'Paste', exact: true }).click();
            await expect.poll(() => inputs().at(-1)).toBe('\x1b[200~pasted one\rpasted two\x1b[201~');

            // The source fixture retains more history than the rendered viewport.
            // Copy must attach a read-only HAPI viewer, never claim DSH control.
            source.writeTerminalOutput('machine-alpha', allocated.info.terminalId,
                '\r\nretained output before current viewport\r\n' + Array.from({ length: 449 }, (_, index) => `copy retained line ${index + 2}`).join('\r\n'));
            await expect(terminal.locator('.xterm-rows')).toContainText('copy retained line 450');
            const beforeCopy = source.terminalCommands.length, copyLease = { controller: allocated.info.controllerId, version: allocated.info.controlVersion };
            const beforeCopyInputs = inputs().length;
            await menu(); await options.getByRole('button', { name: 'Copy', exact: true }).click();
            const copyDialog = page.getByRole('dialog', { name: 'Copy terminal text', exact: true });
            const copyText = copyDialog.getByLabel('Terminal text snapshot', { exact: true });
            await expect(copyText).toContainText('copy retained line 450');
            await expect(copyText).not.toContainText('retained output before current viewport');
            await expect(copyDialog.getByText('Read-only text snapshot from the original Runner. Your terminal keeps its existing input control.', { exact: true })).toBeVisible();
            while (await copyDialog.getByRole('button', { name: /^Load more/ }).count()) await copyDialog.getByRole('button', { name: /^Load more/ }).click();
            await expect(copyText).toContainText('retained output before current viewport');
            await copyDialog.getByRole('button', { name: 'Copy', exact: true }).click();
            await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('retained output before current viewport');
            await page.screenshot({ path: `${info.outputDir}/official-mobile-terminal-copy.png`, fullPage: true });
            await copyDialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
            expect(source.terminalCommands.slice(beforeCopy).filter(row => row.command.type === 'attach' && row.command.terminalId === allocated.info.terminalId)).toHaveLength(1);
            expect(source.terminalCommands.slice(beforeCopy).filter(row => ['claim', 'release', 'create', 'input', 'resize', 'terminate'].includes(row.command.type))).toHaveLength(0);
            expect({ controller: allocated.info.controllerId, version: allocated.info.controlVersion }).toEqual(copyLease);
            expect(inputs()).toHaveLength(beforeCopyInputs);
            await terminal.getByRole('textbox', { name: 'Terminal', exact: true }).pressSequentially('after-read\r');
            await expect.poll(() => inputs().slice(beforeCopyInputs).join('')).toBe('after-read\r');
            const beforeReload = inputs().length;
            await page.screenshot({ path: `${info.outputDir}/official-mobile-terminal.png`, fullPage: true });
            await expect(page.locator('.hapi-persistence-saved')).toBeVisible(); await page.reload();
            await expect(bar.getByRole('button', { name: 'Snippets', exact: true })).toBeEnabled();
            await bar.getByRole('button', { name: 'Snippets', exact: true }).tap();
            await expect(page.getByRole('dialog', { name: 'Snippets', exact: true }).getByRole('button', { name: 'Check machine', exact: true })).toBeVisible();
            await page.getByRole('dialog', { name: 'Snippets', exact: true }).locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
            expect(inputs()).toHaveLength(beforeReload); expect(createCount()).toBe(before + 1);

            await page.setViewportSize({ width: 1280, height: 900 });
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
            const betaChat = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
            const beta = await openTool(page, betaChat, 'Terminal');
            await expect(beta.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await beta.getByRole('button', { name: 'Snippets', exact: true }).click();
            await expect(page.getByRole('dialog', { name: 'Snippets', exact: true }).getByRole('button', { name: 'Check machine', exact: true })).toBeVisible();
            await page.getByRole('dialog', { name: 'Snippets', exact: true }).locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
            await closePane(beta); await closePane(betaChat);
            expect(source.terminalCommands.filter(row => row.command.type === 'terminate')).toHaveLength(0);
            expect(source.terminalInputs.filter(row => row.terminalId === allocated.info.terminalId).every(row => row.machineId === 'machine-alpha')).toBe(true);
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });

    test('trusted terminal touch gestures resize the official renderer and stop history inertia before TUI input', async ({ browser }, info) => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, locale: 'en-US' });
        await context.addInitScript(() => { localStorage.setItem('hapi-terminal-font-size', '9'); });
        const page = await context.newPage(), errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const source = environment.hapi.workbench;
        const creationsBefore = source.terminalCommands.filter(row => row.command.type === 'create').length;
        const terminationsBefore = source.terminalCommands.filter(row => row.command.type === 'terminate').length;
        try {
            await admit(page, environment);
            await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
            const chat = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
            const terminal = await openTool(page, chat, 'Terminal');
            await expect(terminal.locator('[data-sidebar-terminal] .xterm')).toBeVisible();
            await closePane(chat);
            await page.setViewportSize({ width: 420, height: 860 });
            const rows = terminal.locator('.xterm-rows'), screen = terminal.locator('.xterm-screen');
            await expect(rows).toHaveCSS('font-size', '9px');
            const allocated = [...source.terminals.values()].findLast(row => row.machineId === 'machine-alpha')!;
            const terminalId = allocated.info.terminalId;
            const inputs = () => source.terminalInputs.filter(row => row.terminalId === terminalId).map(row => row.data);
            const sourceGrid = { cols: allocated.info.cols, rows: allocated.info.rows };
            const cdp = await context.newCDPSession(page);
            const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Array<{ x: number; y: number; id: number }>) =>
                cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(point => ({ ...point, radiusX: 2, radiusY: 2, force: 1 })) });
            const center = async () => {
                const box = (await screen.boundingBox())!;
                return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 3) };
            };
            const finger = (point: { x: number; y: number }, dy = 0) => [{ id: 0, x: point.x, y: point.y + dy }];

            const pinch = await center();
            await touch('touchStart', [{ id: 0, x: pinch.x - 25, y: pinch.y }, { id: 1, x: pinch.x + 25, y: pinch.y }]);
            await touch('touchMove', [{ id: 0, x: pinch.x - 50, y: pinch.y }, { id: 1, x: pinch.x + 50, y: pinch.y }]);
            await touch('touchEnd', []);
            await expect(rows).toHaveCSS('font-size', '18px');
            await expect.poll(() => ({ cols: allocated.info.cols, rows: allocated.info.rows })).not.toEqual(sourceGrid);
            expect(await page.evaluate(() => localStorage.getItem('hapi-terminal-font-size'))).toBe('9');
            expect(inputs()).toEqual([]);

            // Source PTY output is an explicit fixture; touch dispatch, the
            // official xterm, render ACKs and the authenticated wire are real.
            source.writeTerminalOutput('machine-alpha', terminalId, '\r\n' + Array.from({ length: 600 }, (_, index) => `gesture retained line ${index + 1}`).join('\r\n'));
            await expect(rows).toContainText('gesture retained line 600');
            const firstVisible = async () => {
                const match = (await rows.innerText()).match(/gesture retained line (\d+)/);
                return match ? Number(match[1]) : 0;
            };
            const beforeDrag = await firstVisible(), point = await center();
            expect(beforeDrag).toBeGreaterThan(500);
            await touch('touchStart', finger(point));
            await page.waitForTimeout(20);
            await touch('touchMove', finger(point, 60));
            await page.waitForTimeout(20);
            await touch('touchMove', finger(point, 120));
            await expect.poll(firstVisible).toBeLessThan(beforeDrag);
            const heldAt = await firstVisible();
            await touch('touchEnd', []);
            await expect.poll(firstVisible, { intervals: [30, 50, 80] }).toBeLessThan(heldAt);
            expect(inputs()).toEqual([]);

            // A real mode transition arrives while momentum is active. The
            // unacknowledged frame and then the alternate screen both stop it.
            source.writeTerminalOutput('machine-alpha', terminalId, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[Hgesture TUI screen');
            await expect(rows).toContainText('gesture TUI screen');
            await page.waitForTimeout(200);
            expect(inputs()).toEqual([]);
            const tui = await center();
            await touch('touchStart', finger(tui));
            await page.waitForTimeout(20);
            await touch('touchMove', finger(tui, 80));
            await touch('touchEnd', []);
            await expect.poll(() => inputs().length).toBeGreaterThan(0);
            expect(inputs().every(data => /^(?:\x1b\[<(?:64|65);\d+;\d+M)+$/.test(data))).toBe(true);
            const afterDrag = inputs().length;
            await page.waitForTimeout(220);
            expect(inputs()).toHaveLength(afterDrag);

            // Main-buffer mouse reporting cannot be separated from viewport
            // scrolling through the original public body. It stays explicit
            // and does not silently forward a history gesture as program input.
            source.writeTerminalOutput('machine-alpha', terminalId, '\x1b[?1049l');
            await expect(terminal.locator('[data-hapi-terminal-touch-unavailable]')).toBeVisible();
            const blocked = await center();
            await touch('touchStart', finger(blocked));
            await touch('touchMove', finger(blocked, 80));
            await touch('touchEnd', []);
            await page.waitForTimeout(120);
            expect(inputs()).toHaveLength(afterDrag);
            source.writeTerminalOutput('machine-alpha', terminalId, '\x1b[?1000l');
            await expect(terminal.locator('[data-hapi-terminal-touch-unavailable]')).toHaveCount(0);
            await page.screenshot({ path: `${info.outputDir}/official-terminal-touch-gestures.png`, fullPage: true });
            const last = await center();
            await touch('touchStart', finger(last));
            await page.waitForTimeout(20);
            await touch('touchMove', finger(last, 80));
            await touch('touchEnd', []);
            // At 420px the desktop header is intentionally hidden; the
            // existing mobile pane bar owns the same close-view action.
            const mobileMenu = page.locator('.hapi-mobile-pane-bar .hapi-pane-menu');
            await mobileMenu.locator('summary').click();
            await mobileMenu.getByRole('button', { name: 'Close pane', exact: true }).click();
            await expect(terminal).toHaveCount(0);
            await page.waitForTimeout(120);
            expect(inputs()).toHaveLength(afterDrag);
            expect(source.terminalCommands.filter(row => row.command.type === 'create')).toHaveLength(creationsBefore + 1);
            expect(source.terminalCommands.filter(row => row.command.type === 'terminate')).toHaveLength(terminationsBefore);
            expect(allocated.info.status).toBe('running');
            expect(errors).toEqual([]);
        } finally { await context.close(); }
    });
});
