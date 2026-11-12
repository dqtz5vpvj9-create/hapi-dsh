/** Production bridge and React seats; native attachment slot callbacks are explicit boundary fixtures. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useState, type ComponentType } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ComposerAttachment, ComposerAttachmentsProps, InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { installSourceComposerBridge } from '../../src/client/source-composer.tsx';

test('the mounted native attachment rail shows preparation, transfer, confirmation and recovery while retaining its exact callbacks', () => {
    const original = { component: (props: ComposerAttachmentsProps) => <div>{props.attachments.map(attachment => <span key={attachment.id}>
        {attachment.file.name}<button onClick={() => props.onRetryFile(attachment.id)}>Retry</button>
        <button onClick={() => props.onRemoveAttachment(attachment.id)}>Remove</button>
    </span>)}</div>, options: {} };
    let Seat!: ComponentType<ComposerAttachmentsProps>;
    const ctx = { slots: { entries: () => [original], subscribe: () => () => {},
        register: (_options: unknown, component: typeof Seat) => { Seat = component; return () => {}; } },
        reflect: { provide: () => () => {} }, locale: { getSnapshot: () => ({ active: 'en' }) } } as unknown as Context;
    const bridge = installSourceComposerBridge(ctx), file = new File(['original'], 'report.txt');
    const props = { sessionId: 'hhpi:machine:source:codex:thread', inputActions: {} as InputActions, canAcceptDrop: true,
        attachments: [{ id: 'original', kind: 'file', file }], uploads: { original: { status: 'uploading', loaded: 0 } },
        onAddFiles: vi.fn(), onRetryFile: vi.fn(), onRemoveAttachment: vi.fn() } as unknown as ComposerAttachmentsProps;
    const view = render(<Seat {...props}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing attachments');
    view.rerender(<Seat {...props} uploads={{ original: { status: 'uploading', loaded: 25, total: 100 } }}/>);
    expect(screen.getByRole('status')).toHaveTextContent('25%');
    view.rerender(<Seat {...props} uploads={{ original: { status: 'uploading', loaded: 100, total: 100 } }}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Finishing upload');
    expect(bridge.inspectSubmission(props.sessionId!, props.inputActions!, ['original' as ComposerAttachment['id']])).toBe('uploading');
    view.rerender(<Seat {...props} uploads={{ original: { status: 'error', message: 'Source disconnected' } }}/>);
    expect(screen.getByRole('status')).toHaveTextContent('Retry or remove');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(props.onRetryFile).toHaveBeenCalledExactlyOnceWith('original');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onRemoveAttachment).toHaveBeenCalledExactlyOnceWith('original');
    view.rerender(<Seat {...props} uploads={{ original: { status: 'ready', receiptId: 'receipt' as never } }}/>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('report.txt')).toBeVisible();
    expect(bridge.captureFiles(props.sessionId!, ['original'], props.inputActions!)[0]?.file).toBe(file);
    view.unmount(); bridge.dispose();
});

test('attachment restoration, capture and removal address the originating input when two Panes show one session', async () => {
    const original = { component: () => null, options: {} };
    let Seat!: ComponentType<ComposerAttachmentsProps>;
    const ctx = { slots: { entries: () => [original], subscribe: () => () => {},
        register: (_options: unknown, component: typeof Seat) => { Seat = component; return () => {}; } },
        reflect: { provide: () => () => {} }, locale: { getSnapshot: () => ({ active: 'en' }) } } as unknown as Context;
    const bridge = installSourceComposerBridge(ctx), sessionId = 'hhpi:machine:source:codex:thread' as SessionId;
    const leftFile = new File(['left'], 'note.txt'), rightFile = new File(['right'], 'note.txt');
    const create = (file: File): ComposerAttachmentsProps => ({ sessionId, inputActions: {} as InputActions, canAcceptDrop: true,
        attachments: [{ id: 'same-id', kind: 'file', file }], uploads: {}, onAddFiles: vi.fn(), onRemoveAttachment: vi.fn() } as unknown as ComposerAttachmentsProps);
    const left = create(leftFile), right = create(rightFile);
    const view = render(<><Seat {...left}/><Seat {...right}/></>);
    expect(bridge.captureFiles(sessionId, ['same-id'], right.inputActions)[0]?.file).toBe(rightFile);
    bridge.removeFiles(sessionId, [{ id: 'same-id', file: rightFile }], right.inputActions);
    expect(right.onRemoveAttachment).toHaveBeenCalledOnce(); expect(left.onRemoveAttachment).not.toHaveBeenCalled();
    const abort = new AbortController(); let restoration!: Promise<() => void>;
    act(() => { restoration = bridge.addFiles(sessionId, [new File(['restored'], 'restored.txt')], abort.signal, right.inputActions); });
    expect(right.onAddFiles).toHaveBeenCalledOnce(); expect(left.onAddFiles).not.toHaveBeenCalled();
    abort.abort(); await expect(restoration).rejects.toMatchObject({ name: 'AbortError' });
    view.unmount(); bridge.dispose();
});

test('upload checkpoint waits for the originating input commit and its durable save without borrowing another Pane', async () => {
    const original = { component: () => null, options: {} };
    let Seat!: ComponentType<ComposerAttachmentsProps>;
    const provided = new Map<string, unknown>();
    const ctx = { slots: { entries: () => [original], subscribe: () => () => {},
        register: (_options: unknown, component: typeof Seat) => { Seat = component; return () => {}; } },
        reflect: { provide(name: string, value: unknown) { provided.set(name, value); return () => { provided.delete(name); }; } },
        locale: { getSnapshot: () => ({ active: 'en' }) } } as unknown as Context;
    const bridge = installSourceComposerBridge(ctx), sessionId = 'hhpi:machine:source:codex:thread' as SessionId;
    expect(provided.get('sourceComposer')).toBe(bridge);
    const left = {} as InputActions, right = {} as InputActions, file = new File(['original'], 'note.txt');
    const save = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), signal = new AbortController();
    let upload!: Promise<void>, completed = false;
    const wrongSave = vi.fn(async () => {}), correctSave = vi.fn(async () => {
        expect(bridge.captureFiles(sessionId, ['added'], right)[0]?.file).toBe(file);
        entered.resolve(); await save.promise;
    });
    const stopLeft = bridge.registerUploadCheckpoint(left, wrongSave), stopRight = bridge.registerUploadCheckpoint(right, correctSave);
    function Input({ actions }: { actions: InputActions }) {
        const [attachments, setAttachments] = useState<ComposerAttachmentsProps['attachments']>([]);
        const props = { sessionId, inputActions: actions, canAcceptDrop: true, attachments, uploads: {}, onRemoveAttachment() {}, onAddFiles(files: readonly File[]) {
            upload = bridge.checkpointUpload(sessionId, files[0]!, signal.signal).then(() => { completed = true; });
            setAttachments([{ id: 'added' as ComposerAttachment['id'], kind: 'file', file: files[0]! }]);
        } } as unknown as ComposerAttachmentsProps;
        return <Seat {...props}/>;
    }
    const view = render(<><Input actions={left}/><Input actions={right}/></>);
    await act(async () => { fireEvent.change(view.container.querySelectorAll('input')[1]!, { target: { files: [file] } }); await entered.promise; });
    expect(completed).toBe(false); expect(correctSave).toHaveBeenCalledOnce(); expect(wrongSave).not.toHaveBeenCalled();
    save.resolve(); await act(async () => { await upload; }); expect(completed).toBe(true);
    stopLeft(); stopRight(); view.unmount(); bridge.dispose(); expect(provided.has('sourceComposer')).toBe(false);
});
