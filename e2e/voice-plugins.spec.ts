/** Chromium capture + original DSH composer, with explicit HAPI/provider wire fixtures. */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { startOfficialEnvironment, type OfficialEnvironment } from './official-runtime.ts';

test.use({ permissions: ['microphone'], launchOptions: {
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
} });
async function admit(page: Page, environment: OfficialEnvironment) {
    await page.addInitScript(() => {
        const streams: MediaStream[] = []; Object.assign(window, { __hapiVoiceStreams: streams });
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); streams.push(stream); return stream; };
    });
    await page.goto(environment.launchUrl);
    await expect(page.locator('[data-hapi-workspace]')).toBeVisible();
    const notice = page.getByRole('dialog', { name: 'Preview Notice', exact: true });
    if (await notice.isVisible()) await notice.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex alpha' }).click();
    const pane = page.getByRole('region', { name: 'Pane: Native Codex alpha', exact: true });
    await expect(pane.getByRole('button', { name: 'Voice and dictation', exact: true })).toBeVisible(); return pane;
}
async function voice(page: Page, pane: Locator) {
    await pane.getByRole('button', { name: 'Voice and dictation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Voice and dictation', exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function stoppedTracks(page: Page) {
    await expect.poll(() => page.evaluate(() => {
        const streams = (window as unknown as { __hapiVoiceStreams: MediaStream[] }).__hapiVoiceStreams;
        return streams.length > 0 && streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
    })).toBe(true);
}

test.describe('HAPI voice through public DSH composer and shared microphone ownership', () => {
    let environment: OfficialEnvironment;
    test.beforeAll(async () => { environment = await startOfficialEnvironment(true); });
    test.afterAll(async () => { await environment?.close(); });

    test('standard dictation preserves the official draft and credential updates keep keys off browser storage', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const pane = await admit(page, environment), baseSends = environment.hapi.sent.length;
        const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await composer.fill('Existing draft text. ');
        const dialog = await voice(page, pane);
        await dialog.getByRole('button', { name: 'Dictation', exact: true }).click();
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('combobox', { name: 'Transcription provider', exact: true }).selectOption('openai');
        await dialog.getByRole('combobox', { name: 'Transcription mode', exact: true }).selectOption('standard');
        // Password inputs have no implicit textbox role.
        const password = dialog.getByLabel('OpenAI API key', { exact: true });
        await password.fill('fixture-browser-key-one');
        const form = dialog.locator('form').filter({ has: page.getByLabel('OpenAI API key', { exact: true }) });
        const updates = environment.hapi.voice.credentialsUpdates.length;
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => environment.hapi.voice.credentialsUpdates.length).toBe(updates + 1);
        await expect(password).toHaveValue('');
        expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('fixture-browser-key-one')))).toBe(false);
        environment.hapi.voice.failNextCredentialReply = true;
        await password.fill('fixture-browser-key-two'); await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog.getByText('The update was not confirmed. It has not been retried. Refresh the original status before deciding on a new update.', { exact: true })).toBeVisible();
        expect(environment.hapi.voice.credentialsUpdates).toHaveLength(updates + 2); await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Refresh credential status', exact: true }).click();
        await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        const uploads = environment.hapi.voice.transcriptions.length;
        await dialog.getByRole('button', { name: 'Start dictation', exact: true }).click();
        await expect(dialog.getByRole('status').filter({ hasText: /^Listening/ })).toBeVisible();
        await page.waitForTimeout(350); // Capture real Chromium MediaRecorder audio frames.
        await dialog.getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
        await expect.poll(() => environment.hapi.voice.transcriptions.length).toBe(uploads + 1);
        await expect(dialog.getByText('Transcript inserted into this draft. Review it before sending.', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Close voice', exact: true }).click();
        await expect(composer).toContainText('Existing draft text.'); await expect(composer).toContainText('Fixture voice transcript into the original draft');
        const audio = environment.hapi.voice.transcriptions.at(-1)!; expect(audio.bytes.length).toBeGreaterThan(100); expect(audio.mimeType).toContain('audio/'); expect(audio.provider).toBe('openai');
        expect(environment.hapi.sent).toHaveLength(baseSends); await stoppedTracks(page); expect(errors).toEqual([]);
        await page.screenshot({ path: `${info.outputDir}/official-composer-dictation.png`, fullPage: true });
    });

    test('live assistants use original source tools, explicit approvals, real call IDs and shared microphone ownership', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const alpha = await admit(page, environment);
        await page.getByRole('button', { name: 'Split left / right', exact: true }).click();
        await page.locator('.hapi-session-open').filter({ hasText: 'Native Codex beta' }).click();
        const beta = page.getByRole('region', { name: 'Pane: Native Codex beta', exact: true });
        environment.hapi.requestApproval('native-alpha', 'voice-permission-alpha');
        let dialog = await voice(page, alpha);
        await dialog.getByRole('button', { name: 'Voice assistant', exact: true }).click();
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('combobox', { name: 'Conversation backend', exact: true }).selectOption('gemini-live');
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('button', { name: 'Start voice call', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Mute microphone', exact: true })).toBeEnabled();
        const gemini = environment.hapi.voice.connections.at(-1)!; expect(gemini.backend).toBe('gemini-live');
        await expect.poll(() => JSON.stringify(environment.hapi.voice.frames.filter(row => row.connectionId === gemini.id))).toContain('voice-permission-alpha');
        const sourceFrames = () => JSON.stringify(environment.hapi.voice.frames.filter(row => row.connectionId === gemini.id));
        expect(sourceFrames()).toContain('native-alpha'); expect(sourceFrames()).not.toContain('native-beta');
        const baseApprovals = environment.hapi.approvals.length;
        environment.hapi.voice.sendTool('gemini-live', 'processPermissionRequest', { decision: 'allow' }, 'gemini-permission-1');
        await expect.poll(() => environment.hapi.approvals.length).toBe(baseApprovals + 1);
        expect(environment.hapi.approvals.at(-1)).toMatchObject({ sessionId: 'native-alpha', requestId: 'voice-permission-alpha' });
        environment.hapi.settleApproval('native-alpha', 'voice-permission-alpha');
        const baseSends = environment.hapi.sent.length;
        environment.hapi.voice.sendTool('gemini-live', 'messageCodingAgent', { message: 'Voice-owned coding request' }, 'gemini-tool-1');
        await expect.poll(() => environment.hapi.sent.length).toBe(baseSends + 1);
        environment.hapi.voice.sendTool('gemini-live', 'messageCodingAgent', { message: 'Voice-owned coding request' }, 'gemini-tool-1');
        await expect.poll(() => environment.hapi.voice.frames.filter(row => row.connectionId === gemini.id && 'toolResponse' in row.value).length).toBe(3);
        expect(environment.hapi.sent).toHaveLength(baseSends + 1);
        environment.hapi.voice.sendTool('gemini-live', 'messageCodingAgent', { message: 'Voice-owned coding request' }, 'gemini-tool-2');
        await expect.poll(() => environment.hapi.sent.length).toBe(baseSends + 2);
        expect(environment.hapi.sent.slice(baseSends).every(row => row.sessionId === 'native-alpha')).toBe(true);
        environment.hapi.voice.caption('gemini-live', 'Fixture voice caption in the official workspace');
        await expect(dialog.getByText('Fixture voice caption in the official workspace', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Minimize voice and continue', exact: true }).click();
        dialog = await voice(page, beta);
        await expect(dialog.getByText('A different pane currently owns the microphone.', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Start voice call', exact: true })).toBeDisabled();
        expect(environment.hapi.voice.connections.filter(row => !row.closed)).toHaveLength(1);
        await dialog.getByRole('button', { name: 'Stop the other voice activity', exact: true }).click();
        await expect.poll(() => gemini.closed).toBe(true); await stoppedTracks(page);
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('combobox', { name: 'Conversation backend', exact: true }).selectOption('qwen-realtime');
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('button', { name: 'Start voice call', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Mute microphone', exact: true })).toBeEnabled();
        const qwen = environment.hapi.voice.connections.at(-1)!; expect(qwen.backend).toBe('qwen-realtime');
        await expect.poll(() => JSON.stringify(environment.hapi.voice.frames.filter(row => row.connectionId === qwen.id))).toContain('native-beta');
        const beforeBeta = environment.hapi.sent.length;
        environment.hapi.voice.sendTool('qwen-realtime', 'messageCodingAgent', { message: 'Qwen fixture source request' }, 'qwen-tool-1');
        await expect.poll(() => environment.hapi.sent.length).toBe(beforeBeta + 1); expect(environment.hapi.sent.at(-1)?.sessionId).toBe('native-beta');
        await dialog.getByRole('button', { name: 'Minimize voice and continue', exact: true }).click();
        await beta.locator('.hapi-pane-header').getByRole('button', { name: 'Close pane', exact: true }).click();
        await expect.poll(() => qwen.closed).toBe(true); await stoppedTracks(page);
        await page.locator('.hapi-session-open').filter({ hasText: 'DSH remote conversation' }).click();
        const remote = page.getByRole('region', { name: 'Pane: DSH remote conversation', exact: true });
        dialog = await voice(page, remote);
        await dialog.getByRole('button', { name: 'Start voice call', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Mute microphone', exact: true })).toBeEnabled();
        const remoteVoice = environment.hapi.voice.connections.at(-1)!;
        await expect.poll(() => JSON.stringify(environment.hapi.voice.frames.filter(row => row.connectionId === remoteVoice.id))).toContain('Remote DSH seed prompt');
        expect(JSON.stringify(environment.hapi.voice.frames.filter(row => row.connectionId === remoteVoice.id))).not.toContain('native-alpha');
        const originalNativeSends = environment.hapi.sent.length;
        environment.hapi.voice.sendTool('qwen-realtime', 'messageCodingAgent', { message: 'Voice request for the remote DSH' }, 'remote-dsh-voice-tool');
        await dialog.getByRole('button', { name: 'Minimize voice and continue', exact: true }).click();
        await expect(remote.getByText('Voice request for the remote DSH', { exact: true })).toBeVisible();
        expect(environment.hapi.sent).toHaveLength(originalNativeSends);
        dialog = await voice(page, remote); await dialog.getByRole('button', { name: 'Close voice', exact: true }).click();
        await expect.poll(() => remoteVoice.closed).toBe(true); await stoppedTracks(page);
        await page.screenshot({ path: `${info.outputDir}/official-voice-source-tools.png`, fullPage: true }); expect(errors).toEqual([]);
    });

    test('browser-local live dictation retains a conflicting draft and never uploads audio to a provider', async ({ page }, info) => {
        // Model the browser's experimental on-device API, never a cloud recognizer.
        await page.addInitScript(() => {
            const facts = { probes: 0, starts: 0, aborts: 0, local: false }; Object.assign(window, { __hapiSpeechFixture: facts });
            class LocalRecognition extends EventTarget {
                static available(options: { processLocally: boolean }) { facts.probes++; if (!options.processLocally) throw new Error('Fixture rejects cloud recognition'); return Promise.resolve('available'); }
                continuous = false; interimResults = false; lang = ''; processLocally = false;
                onresult: ((event: { results: Array<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
                onerror: ((event: Event) => void) | null = null; onend: (() => void) | null = null;
                start() { facts.starts++; facts.local = this.processLocally; setTimeout(() => this.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'On-device fixture transcript' } }] }), 10); }
                stop() { this.onend?.(); } abort() { facts.aborts++; }
            }
            Object.defineProperty(LocalRecognition.prototype, 'processLocally', { configurable: true, writable: true, value: false });
            Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: LocalRecognition });
            Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'Linux', mobile: false } });
        });
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const pane = await admit(page, environment), beforeAudio = environment.hapi.voice.transcriptions.length, beforeSends = environment.hapi.sent.length;
        const composer = pane.getByRole('textbox', { name: 'Message or run a task, / commands, @ files or sessions', exact: true });
        await composer.fill('Original draft before recording.'); let dialog = await voice(page, pane);
        await dialog.getByRole('button', { name: 'Dictation', exact: true }).click();
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('combobox', { name: 'Transcription provider', exact: true }).selectOption('browser-local');
        expect(await page.evaluate(() => (window as unknown as { __hapiSpeechFixture: { probes: number } }).__hapiSpeechFixture.probes)).toBe(0);
        await dialog.getByRole('button', { name: 'Voice settings', exact: true }).click();
        await dialog.getByRole('button', { name: 'Start dictation', exact: true }).click();
        await expect(dialog.getByText('On-device fixture transcript', { exact: true })).toBeVisible();
        await dialog.getByRole('button', { name: 'Minimize voice and continue', exact: true }).click();
        await composer.fill('Changed draft while listening.'); dialog = await voice(page, pane);
        await dialog.getByRole('button', { name: 'Stop and transcribe', exact: true }).click();
        await expect(dialog.getByRole('textbox', { name: 'Retained transcript', exact: true })).toHaveValue('On-device fixture transcript');
        await expect(composer).toHaveText('Changed draft while listening.');
        await dialog.getByRole('button', { name: 'Insert into current draft', exact: true }).click();
        await dialog.getByRole('button', { name: 'Close voice', exact: true }).click();
        await expect(composer).toContainText('Changed draft while listening.'); await expect(composer).toContainText('On-device fixture transcript');
        const facts = await page.evaluate(() => (window as unknown as { __hapiSpeechFixture: { probes: number; starts: number; local: boolean; aborts: number } }).__hapiSpeechFixture);
        expect(facts).toMatchObject({ probes: 1, starts: 1, local: true }); expect(facts.aborts).toBeGreaterThan(0);
        expect(environment.hapi.voice.transcriptions).toHaveLength(beforeAudio); expect(environment.hapi.sent).toHaveLength(beforeSends); expect(errors).toEqual([]);
        await page.screenshot({ path: `${info.outputDir}/official-local-dictation-conflict.png`, fullPage: true });
    });
});
