/** Production React dictation and coordinator; SpeechRecognition and official InputActions are boundary fixtures. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type {} from '@testing-library/jest-dom/vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputActions, InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VoiceComposer } from '../src/client/source-voice/composer.tsx'
import { installSourceVoice } from '../src/client/source-voice/index.tsx'
import { installComposerAutosave } from '../src/client/composer-autosave-seat.tsx'
import { loadVoiceComposer } from '../src/client/client-chunks.ts'
import { getBrowserLocalSpeechSupport, type LocalSpeechRecognitionEvent } from '../src/client/source-voice/browser-local.ts'
import { createWorkspaceVoiceCoordinator } from '../src/client/workspace-ui.ts'
import { createWorkspaceUiPreferences } from '../src/client/ui-preferences.ts'
import { WorkspaceApplicationIdentity } from '../src/client/application-identity.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { accountComposerDraftKey, readComposerRecoveries, writeComposerRecoveries, dictationRecoveryIsVisible, type RecoveredComposerDraft } from '../src/client/composer-autosave.ts'

// The official lazy-module transport is a boundary; both installed components are production code.
vi.mock('../src/client/client-chunks.ts', () => ({ loadVoiceComposer: vi.fn(() => import('../src/client/source-voice/composer.tsx')) }))

type Composer = Parameters<typeof VoiceComposer>[0]['composer']
function mount(options: { mobile?: boolean; platform?: string; signal?: AbortSignal; availability?: Promise<string>; retained?: boolean; accountId?: string; initialDraft?: string; pane?: boolean; source?: boolean; installed?: boolean; recoveries?: RecoveredComposerDraft[] } = {}) {
    const instances: Local[] = []
    class Local extends EventTarget {
        static available = vi.fn(() => options.availability ?? Promise.resolve('available'))
        continuous = false; interimResults = false; processLocally = false; lang = ''
        onresult: ((event: LocalSpeechRecognitionEvent) => void) | null = null
        onerror: ((event: Event & { error?: string }) => void) | null = null
        onend: (() => void) | null = null
        start = vi.fn(() => { expect(this.processLocally).toBe(true) })
        stop = vi.fn(() => this.onend?.())
        abort = vi.fn()
        constructor() { super(); instances.push(this) }
    }
    Object.defineProperty(Local.prototype, 'processLocally', { configurable: true, writable: true, value: false })
    vi.stubGlobal('SpeechRecognition', Local)
    vi.stubGlobal('navigator', { language: 'en-US', userAgentData: { mobile: options.mobile ?? false, platform: options.platform ?? 'Linux' } })
    const coordinator = createWorkspaceVoiceCoordinator(), owner = coordinator.createScope()
    const application = new WorkspaceApplicationIdentity(); application.set({ accountId: options.accountId ?? 'voice-account', origin: 'https://voice.invalid' }, 'voice-device')
    const ui = { voice: owner.voice, preferences: createWorkspaceUiPreferences(localStorage), application }
    const input = createSnapshotStore<InputState>({ draft: options.initialDraft ?? '', draftRev: 0, phase: 'plain', occurrences: [], attachmentIds: [], queue: [] })
    const session = { getSnapshot: () => ({ removed: false }), subscribe: () => () => {} }
    const binding = { sessionId: options.source ? 'hhpi:machine:source:codex:voice-session' : 'voice-session', session } as unknown as SessionBinding
    const canonical = options.retained ? { ...binding, viewId: 'other-view' } : binding
    const paneState = createSnapshotStore({ visible: true })
    const navigation = options.pane ? { hostId: 'source-host', paneId: 'dictation-pane', state: paneState, registerCloseGuard: vi.fn(() => () => {}) } : undefined
    const sourceAccess = new AbortController(), sourceCatalog = createSnapshotStore({})
    const authority = { list: sourceCatalog, captureWorkspaceAccess: () => ({ scope: 'original-source', signal: sourceAccess.signal, assertCurrent: () => sourceAccess.signal.throwIfAborted() }) }
    const official = { state: input, setDraft: vi.fn(), insertReference: vi.fn(), beginCommand: vi.fn(), notify: vi.fn(), focus: vi.fn() }
    const registrations = new Map<string, ComponentType<Composer>>()
    const ctx = { get: (key: string) => key === 'hapiWorkspacePane' ? navigation : key === 'hhpiSessions' && options.source ? authority : undefined,
        hapiWorkspaceUi: ui, locale: { getSnapshot: () => ({ active: 'en' }) },
        conversation: { input: { for: () => official } }, sessions: { binding: () => canonical, ownsBinding: (value: SessionBinding) => value === binding },
        slots: { inject: (_name: string, callback: () => () => void) => callback(), register: (slot: { id: string }, component: ComponentType<Composer>) => {
            registrations.set(slot.id, component); return () => { registrations.delete(slot.id) }
        } },
        inject: (_names: string[], callback: (owner: Context) => () => void) => ({ dispose: callback(ctx) }),
    } as unknown as Context
    const span = { captured: 'original selection and revision' } as unknown as TokenSpan
    const actions = { captureInsertion: vi.fn(() => span), insertText: vi.fn((text: string) => { const before = input.getSnapshot(); input.set({ ...before, draft: before.draft + text, draftRev: before.draftRev + 1 }); return true }), persistDraft: vi.fn(),
        setDraft: vi.fn(), submit: vi.fn(), removeAttachment: vi.fn(), addAttachments: vi.fn(), pruneAttachments: vi.fn() }
    const composer = { inputActions: actions as unknown as InputActions, sessionId: binding.sessionId, sessionBinding: binding,
        useInput: (selector: (state: InputState) => unknown) => selector(input.getSnapshot()) } as Composer
    if (options.recoveries) writeComposerRecoveries(localStorage, accountComposerDraftKey(application.getSnapshot()!.scope, navigation?.hostId ?? 'local', binding.sessionId), options.recoveries)
    let dispose = () => {}
    let content = <VoiceComposer ctx={ctx} binding={binding} composer={composer} ui={ui} language="en" initialOpen signal={options.signal ?? application.getSnapshot()!.signal}/>
    if (options.installed) {
        const stopAutosave = installComposerAutosave(ctx, application), stopVoice = installSourceVoice(ctx, 'en')
        const Dock = registrations.get('hapi.composer-autosave')!, Voice = registrations.get('hapi-dsh/voice')!
        content = <><Voice {...composer}/><Dock {...composer}/></>
        dispose = () => { stopVoice(); stopAutosave() }
    }
    const rendered = render(content), unmount = () => { rendered.unmount(); dispose() }
    return { ...rendered, unmount, Local, instances, actions, span, coordinator, owner, ui, ctx, binding, composer, input, paneState, sourceAccess }
}
const transcript = (recognition: { onresult: ((event: LocalSpeechRecognitionEvent) => void) | null }, text: string) => {
    const event = Object.assign(new Event('result'), { results: [{ isFinal: true, 0: { transcript: text } }] }) as unknown as LocalSpeechRecognitionEvent
    act(() => recognition.onresult?.(event))
}

// jsdom has no top-layer dialog geometry; only its public open/close boundary is supplied.
function dialogs() {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
}
describe('browser-local source dictation', () => {
    it('keeps retained words at the installed lazy dictation entry after closing and remounting, with a fallback only when that entry is unavailable', async () => {
        dialogs()
        const drafts: RecoveredComposerDraft[] = [
            { text: 'Original retained dictation', references: [], retention: { kind: 'dictation', id: 'same-transcript' } },
            { text: 'Unrelated ordinary draft', references: [] },
        ]
        const app = mount({ installed: true, initialDraft: 'Current input', recoveries: drafts })
        const loader = vi.mocked(loadVoiceComposer)
        expect(loader).not.toHaveBeenCalled()
        const recovery = screen.getByText('Recover another unsent draft').closest('details')!
        expect(within(recovery).getByText('Unrelated ordinary draft')).toBeInTheDocument()
        expect(within(recovery).queryByText('Original retained dictation')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Local dictation' })).toHaveTextContent('Transcript ready')
        fireEvent.click(screen.getByRole('button', { name: 'Local dictation' }))
        expect(await screen.findByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Original retained dictation')
        fireEvent.click(screen.getByRole('button', { name: 'Close dictation' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(within(recovery).queryByText('Original retained dictation')).not.toBeInTheDocument()
        app.unmount(); await app.coordinator.dispose()

        // A fresh installed wrapper has not loaded the inner voice chunk yet.
        const remount = mount({ installed: true, initialDraft: 'Current input' })
        expect(screen.getByRole('button', { name: 'Local dictation' })).toHaveTextContent('Transcript ready')
        expect(screen.queryByText('Original retained dictation')).not.toBeInTheDocument()
        loader.mockRejectedValueOnce(new Error('Chunk unavailable'))
        fireEvent.click(screen.getByRole('button', { name: 'Local dictation' }))
        // A failed lazy entry must leave the original generic recovery reachable.
        expect(await screen.findByText('Original retained dictation')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Local dictation' }))
        expect(await screen.findByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Original retained dictation')
        expect(within(screen.getByText('Recover another unsent draft').closest('details')!).queryByText('Original retained dictation')).not.toBeInTheDocument()
        expect(remount.actions.insertText).not.toHaveBeenCalled()
        expect(remount.actions.submit).not.toHaveBeenCalled()
        remount.unmount(); await remount.coordinator.dispose()

        const unavailable = mount({ installed: true, mobile: true, initialDraft: 'Current input' })
        expect(screen.queryByRole('button', { name: 'Local dictation' })).not.toBeInTheDocument()
        expect(screen.getByText('Original retained dictation')).toBeInTheDocument()
        expect(unavailable.actions.insertText).not.toHaveBeenCalled()
        unavailable.unmount(); await unavailable.coordinator.dispose()
    })
    it('inserts into the captured official selection, persists the draft and never sends or replaces attachments', async () => {
        dialogs(); const app = mount()
        expect(app.Local.available).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        expect(app.Local.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true })
        transcript(app.instances[0]!, 'Local words')
        fireEvent.click(screen.getByRole('button', { name: 'Stop and insert' }))
        await waitFor(() => expect(app.actions.insertText).toHaveBeenCalledWith('Local words', app.span))
        expect(app.actions.persistDraft).toHaveBeenCalledTimes(1)
        for (const action of ['submit', 'setDraft', 'addAttachments', 'removeAttachment', 'pruneAttachments'] as const) expect(app.actions[action]).not.toHaveBeenCalled()
        expect(app.ui.voice.getSnapshot()).toBeNull()
        expect(app.instances[0]!.abort).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(2))
        const late = app.instances[1]!.onresult
        app.unmount()
        expect(app.instances[1]!.abort).toHaveBeenCalledTimes(1)
        transcript({ onresult: late }, 'Detached pane words')
        expect(app.actions.insertText).toHaveBeenCalledTimes(1)
        expect(app.ui.voice.getSnapshot()).toBeNull()
        await app.coordinator.dispose()
    })
    it('retains a transcript when the draft changes and requires explicit insertion into the new selection', async () => {
        dialogs(); const app = mount()
        app.actions.insertText.mockReturnValueOnce(false)
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Retained words')
        fireEvent.click(screen.getByRole('button', { name: 'Stop and insert' }))
        expect(await screen.findByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Retained words')
        expect(app.actions.persistDraft).not.toHaveBeenCalled()
        const next = { captured: 'new selection and revision' } as unknown as TokenSpan
        app.actions.captureInsertion.mockReturnValue(next)
        fireEvent.click(screen.getByRole('button', { name: 'Insert into this draft' }))
        expect(app.actions.insertText).toHaveBeenLastCalledWith('Retained words', next)
        expect(app.actions.persistDraft).toHaveBeenCalledTimes(1)
        expect(app.actions.submit).not.toHaveBeenCalled()
        app.unmount(); await app.coordinator.dispose()
    })
    it.each(['error', 'unexpected-end'] as const)('retains displayed words after %s without inserting or submitting automatically', async failure => {
        dialogs(); const app = mount()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words already displayed')
        act(() => {
            if (failure === 'error') app.instances[0]!.onerror?.(Object.assign(new Event('error'), { error: 'native-private-code' }))
            else app.instances[0]!.onend?.()
        })
        expect(screen.getByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Words already displayed')
        expect(app.actions.insertText).not.toHaveBeenCalled()
        expect(app.actions.submit).not.toHaveBeenCalled()
        expect(screen.queryByText(/native-private-code/)).not.toBeInTheDocument()
        const restart = screen.getByRole('button', { name: 'Start dictation' })
        expect(restart).toBeDisabled()
        fireEvent.click(restart)
        expect(app.instances).toHaveLength(1)
        expect(screen.getByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Words already displayed')
        fireEvent.click(screen.getByRole('button', { name: 'Insert into this draft' }))
        expect(app.actions.insertText).toHaveBeenCalledWith('Words already displayed', app.span)
        expect(app.actions.persistDraft).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
        app.unmount(); await app.coordinator.dispose()
    })
    it('keeps explicit cancellation as a discard and accepts only the original retained input owner', async () => {
        dialogs(); const app = mount({ retained: true })
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Explicitly cancelled words')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
        expect(screen.queryByRole('region', { name: 'Uninserted transcript' })).not.toBeInTheDocument()
        expect(app.actions.insertText).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(2))
        transcript(app.instances[1]!, 'Original retained input')
        const replacementActions = { ...app.actions, insertText: vi.fn(() => true), persistDraft: vi.fn() }
        app.rerender(<VoiceComposer ctx={app.ctx} binding={app.binding} composer={{ ...app.composer, inputActions: replacementActions as unknown as InputActions }} ui={app.ui} language="en" initialOpen/>)
        fireEvent.click(screen.getByRole('button', { name: 'Stop and insert' }))
        await waitFor(() => expect(app.actions.insertText).toHaveBeenCalledWith('Original retained input', app.span))
        expect(replacementActions.insertText).not.toHaveBeenCalled()
        expect(app.actions.submit).not.toHaveBeenCalled()
        app.unmount(); await app.coordinator.dispose()
    })
    it.each(['pagehide', 'close-dialog', 'unmount'] as const)('keeps displayed words in the captured draft on %s without submitting', async reason => {
        dialogs(); const app = mount()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words before lifecycle interruption')
        if (reason === 'pagehide') fireEvent(window, new Event('pagehide'))
        else if (reason === 'close-dialog') fireEvent.click(screen.getByRole('button', { name: 'Close dictation' }))
        else app.unmount()
        expect(app.actions.insertText).toHaveBeenCalledWith('Words before lifecycle interruption', app.span)
        expect(app.actions.persistDraft).toHaveBeenCalledTimes(1)
        expect(app.actions.submit).not.toHaveBeenCalled()
        expect(app.ui.voice.getSnapshot()).toBeNull()
        expect(screen.queryByText('Local dictation stopped. Check microphone permission and the installed language pack.')).not.toBeInTheDocument()
        if (reason !== 'unmount') app.unmount()
        await app.coordinator.dispose()
    })
    it('keeps captured words when their original pane becomes hidden without moving focus or sending', async () => {
        dialogs(); const app = mount({ pane: true })
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words before changing panes')
        act(() => app.paneState.set({ visible: false }))
        expect(app.actions.insertText).toHaveBeenCalledWith('Words before changing panes', app.span)
        expect(app.actions.persistDraft).toHaveBeenCalledTimes(1)
        expect(app.actions.submit).not.toHaveBeenCalled()
        app.unmount(); await app.coordinator.dispose()
    })
    it('automatically returns a refused lifecycle insertion to the same dictation panel and removes only its own inserted copy', async () => {
        dialogs(); const app = mount({ initialDraft: 'New draft' })
        const key = accountComposerDraftKey(app.ui.application.getSnapshot()!.scope, 'local', app.binding.sessionId)
        writeComposerRecoveries(localStorage, key, [{ text: 'Unrelated original copy', references: [] }])
        app.actions.insertText.mockReturnValue(false)
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words whose original selection changed')
        fireEvent(window, new Event('pagehide'))
        expect(app.input.getSnapshot().draft).toBe('New draft')
        const retained = readComposerRecoveries(localStorage, key).find(copy => copy.retention)!
        expect(retained.text).toBe('Words whose original selection changed')
        expect(dictationRecoveryIsVisible(key, retained.retention!.id)).toBe(true)
        fireEvent.click(screen.getByRole('button', { name: 'Close dictation' }))
        expect(dictationRecoveryIsVisible(key, retained.retention!.id)).toBe(false)
        expect(readComposerRecoveries(localStorage, key)).toHaveLength(2)
        app.unmount(); await app.coordinator.dispose()
        const next = mount({ initialDraft: 'New draft' })
        expect(screen.getByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent(retained.text)
        expect(screen.getByRole('button', { name: 'Start dictation' })).toBeDisabled()
        expect(next.actions.insertText).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Insert into this draft' }))
        expect(next.input.getSnapshot().draft).toBe('New draft' + retained.text)
        expect(next.actions.submit).not.toHaveBeenCalled()
        expect(readComposerRecoveries(localStorage, key)).toEqual([{ text: 'Unrelated original copy', references: [] }])
        next.unmount(); await next.coordinator.dispose()
    })
    it.each([true, false])('keeps unmount words durable and avoids reinserting an already restored native draft (%s)', async alreadyRestored => {
        dialogs(); const app = mount()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words at view unmount')
        const key = accountComposerDraftKey(app.ui.application.getSnapshot()!.scope, 'local', app.binding.sessionId)
        app.unmount(); await app.coordinator.dispose()
        expect(readComposerRecoveries(localStorage, key)[0]?.retention?.insertedDraft).toBe('Words at view unmount')
        const next = mount({ initialDraft: alreadyRestored ? 'Words at view unmount' : '' })
        expect(next.actions.insertText).not.toHaveBeenCalled()
        if (alreadyRestored) {
            expect(readComposerRecoveries(localStorage, key)).toEqual([])
            expect(screen.queryByRole('region', { name: 'Uninserted transcript' })).not.toBeInTheDocument()
        } else expect(screen.getByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Words at view unmount')
        next.unmount(); await next.coordinator.dispose()
    })
    it('keeps account-aborted words only under the captured owner and restores them without exposing them to another account', async () => {
        dialogs(); const app = mount({ accountId: 'original-account' })
        const key = accountComposerDraftKey(app.ui.application.getSnapshot()!.scope, 'local', app.binding.sessionId)
        writeComposerRecoveries(localStorage, key, [{ text: 'Another saved draft', references: [] }])
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words belonging to the original account')
        act(() => app.ui.application.clear())
        expect(app.actions.insertText).not.toHaveBeenCalled()
        expect(readComposerRecoveries(localStorage, key).some(copy => copy.text === 'Words belonging to the original account')).toBe(true)
        app.unmount(); await app.coordinator.dispose()
        const other = mount({ accountId: 'other-account' })
        expect(screen.queryByText('Words belonging to the original account')).not.toBeInTheDocument()
        expect(other.actions.insertText).not.toHaveBeenCalled()
        other.unmount(); await other.coordinator.dispose()
        const original = mount({ accountId: 'original-account' })
        expect(screen.getByRole('region', { name: 'Uninserted transcript' })).toHaveTextContent('Words belonging to the original account')
        fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
        expect(readComposerRecoveries(localStorage, key)).toEqual([{ text: 'Another saved draft', references: [] }])
        expect(original.actions.insertText).not.toHaveBeenCalled()
        original.unmount(); await original.coordinator.dispose()
    })
    it('stops on original source revocation and keeps words under the captured source scope instead of editing a revoked input', async () => {
        dialogs(); const app = mount({ source: true })
        const scope = JSON.stringify([app.ui.application.getSnapshot()!.scope, 'original-source'])
        const key = accountComposerDraftKey(scope, 'local', app.binding.sessionId)
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        transcript(app.instances[0]!, 'Words at source revocation')
        act(() => app.sourceAccess.abort())
        expect(app.instances[0]!.abort).toHaveBeenCalledTimes(1)
        expect(app.actions.insertText).not.toHaveBeenCalled()
        expect(app.actions.submit).not.toHaveBeenCalled()
        expect(readComposerRecoveries(localStorage, key)[0]?.text).toBe('Words at source revocation')
        app.unmount(); await app.coordinator.dispose()
    })
    it('shares microphone ownership and cancels a pending native probe on pagehide without inserting a late result', async () => {
        dialogs(); const availability = Promise.withResolvers<string>(), app = mount({ availability: availability.promise })
        const other = app.coordinator.createScope()
        act(() => { other.voice.claim('other-pane', () => {}) })
        expect(screen.getByRole('button', { name: 'Start dictation' })).toBeDisabled()
        expect(app.Local.available).not.toHaveBeenCalled()
        act(() => other.voice.release('other-pane'))
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.Local.available).toHaveBeenCalledTimes(1))
        fireEvent(window, new Event('pagehide'))
        expect(app.ui.voice.getSnapshot()).toBeNull()
        await act(async () => availability.resolve('available'))
        expect(app.instances).toHaveLength(0)
        expect(app.actions.insertText).not.toHaveBeenCalled()
        app.unmount(); await app.coordinator.dispose()
    })
    it('aborts an active recognizer and ignores its captured late callback; internal native errors are not rendered', async () => {
        dialogs(); const abort = new AbortController(), app = mount({ signal: abort.signal })
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(1))
        const recognizer = app.instances[0]!, late = recognizer.onresult
        act(() => recognizer.onerror?.(Object.assign(new Event('error'), { error: 'native-internal-private-detail' })))
        expect(screen.queryByText(/native-internal-private-detail/)).not.toBeInTheDocument()
        expect(app.ui.voice.getSnapshot()).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
        await waitFor(() => expect(app.instances).toHaveLength(2))
        act(() => abort.abort())
        expect(app.instances[1]!.abort).toHaveBeenCalledTimes(1)
        transcript({ onresult: late }, 'Late words')
        expect(app.actions.insertText).not.toHaveBeenCalled()
        expect(app.ui.voice.getSnapshot()).toBeNull()
        app.unmount(); await app.coordinator.dispose()
    })
    it.each([{ mobile: true, platform: 'Android' }, { mobile: false, platform: 'Android' }, { mobile: false, platform: 'Unknown' }])(
        'does not call experimental native speech in an unsafe environment %j', options => {
            dialogs(); const app = mount(options)
            expect(getBrowserLocalSpeechSupport()).toBeNull()
            expect(screen.getByRole('button', { name: 'Start dictation' })).toBeDisabled()
            fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }))
            expect(app.Local.available).not.toHaveBeenCalled()
            expect(app.instances).toHaveLength(0)
            expect(screen.queryByText(/credential|server|backend|provider|voice assistant/i)).not.toBeInTheDocument()
            app.unmount()
        })
})
