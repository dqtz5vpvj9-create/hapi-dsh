/** Production terminal accessories and React lifecycle; emulator DOM and public model are boundary fixtures. */
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { Context } from '@deepseek-ai/cordis';
import type { TerminalViewState } from '@deepseek-ai/dsh-api-terminal-controller/client';
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client';
import { composedTerminalBody, type TerminalBodyFace, type TerminalViewAccessories } from '../../src/client/source-terminal/view.tsx';
import type { TerminalTextSnapshot } from '../../src/client/source-terminal/snapshot.ts';
import type { TerminalPublicView } from '../../src/client/source-terminal/input.ts';
import { en } from '../../src/client/source-terminal/locales.ts';

const theme = { fontSizes: { terminal: 13 } } as ThemeSnapshot;
const locale = { active: 'en' };
// jsdom has no native modal implementation; only this DOM boundary is supplied.
beforeEach(() => {
  const prototype = HTMLDialogElement.prototype;
  const show = Object.getOwnPropertyDescriptor(prototype, 'showModal'), close = Object.getOwnPropertyDescriptor(prototype, 'close');
  Object.defineProperty(prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  onTestFinished(() => {
    if (show) Object.defineProperty(prototype, 'showModal', show); else Reflect.deleteProperty(prototype, 'showModal');
    if (close) Object.defineProperty(prototype, 'close', close); else Reflect.deleteProperty(prototype, 'close');
  });
});
function clipboard(readText: () => Promise<string>) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn(readText) } });
  onTestFinished(() => { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else Reflect.deleteProperty(navigator, 'clipboard'); });
}
function model(id: string) {
  const state = createSnapshotStore<TerminalViewState>({ phase: 'connected', writable: true,
    info: { id: id as TerminalPublicView['id'], title: 'Source shell', shell: { path: '/bin/sh', args: [], name: 'sh' }, cwd: '/source', cols: 80, rows: 24, state: 'running', exitCode: null } });
  const detach = vi.fn(), write = vi.fn(), close = vi.fn(async () => {}), resize = vi.fn();
  const view: TerminalPublicView = { id: id as TerminalPublicView['id'], state, mount: vi.fn(() => detach), write, close, resize,
    refresh: async () => {}, connect() {}, acknowledge() {}, rename: async () => {}, dispose: async () => {} };
  return { view, state, write, detach, close, resize };
}
function fixture(accessories?: TerminalViewAccessories) {
  const first = model('source-first'), second = model('source-second');
  let current = first.view, visible = true;
  const ctx = { get: () => undefined, locale: { subscribe: () => () => {}, getSnapshot: () => locale } } as unknown as Context;
  function Original(props: TerminalBodyFace) {
    const view = props.view('terminal-occurrence');
    useEffect(() => view.mount(), [view]);
    return <div data-sidebar-terminal><textarea aria-label="Terminal input"/><div className="xterm-rows"><div>visible source output</div></div></div>;
  }
  const Body = composedTerminalBody(ctx, Original, key => en[key]);
  const props = { view: () => current, useTabInfo: () => ({ tab: { id: 'terminal-occurrence', visible } }),
    useProjection: () => undefined, hapiTerminalActions: accessories,
    useTheme: <T,>(select: (value: ThemeSnapshot) => T) => select(theme) } as unknown as TerminalBodyFace;
  const rendered = render(<Body {...props}/>);
  return { first, second, ...rendered, update(options: { visible?: boolean; second?: boolean }) {
    if (options.visible !== undefined) visible = options.visible;
    if (options.second !== undefined) current = options.second ? second.view : first.view;
    rendered.rerender(<Body {...props}/>);
  } };
}
async function action(name: string) {
  fireEvent.contextMenu(screen.getByTestId('termbeam-touchbar'));
  fireEvent.click(await screen.findByRole('button', { name }));
}

test('late clipboard replies cannot type into a hidden, replaced or unmounted source terminal', async () => {
  const pending = Promise.withResolvers<string>(); clipboard(() => pending.promise);
  const f = fixture();
  await action('Paste'); f.update({ visible: false });
  await act(async () => pending.resolve('must not execute'));
  expect(f.first.write).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: en['terminal.paste.fallbackTitle'] })).not.toBeInTheDocument();
  f.update({ visible: true });
  const switched = Promise.withResolvers<string>(); vi.mocked(navigator.clipboard.readText).mockReturnValue(switched.promise);
  await action('Paste'); f.update({ second: true });
  await act(async () => switched.resolve('previous source clipboard'));
  expect(f.first.write).not.toHaveBeenCalled(); expect(f.second.write).not.toHaveBeenCalled();
  const unmounted = Promise.withResolvers<string>(); vi.mocked(navigator.clipboard.readText).mockReturnValue(unmounted.promise);
  await action('Paste'); f.unmount(); await act(async () => unmounted.resolve('late after unmount'));
  expect(f.second.write).not.toHaveBeenCalled();
  expect(f.first.detach).toHaveBeenCalledTimes(1); expect(f.second.detach).toHaveBeenCalledTimes(1);
  expect(f.first.close).not.toHaveBeenCalled(); expect(f.second.close).not.toHaveBeenCalled();
});

test('clipboard rejection opens manual paste only while the initiating terminal is visible and current', async () => {
  const pending = Promise.withResolvers<string>(); clipboard(() => pending.promise);
  const f = fixture();
  await action('Paste'); f.update({ second: true });
  await act(async () => pending.reject(new Error('permission declined')));
  expect(screen.queryByRole('dialog', { name: en['terminal.paste.fallbackTitle'] })).not.toBeInTheDocument();
  vi.mocked(navigator.clipboard.readText).mockRejectedValue(new Error('permission declined'));
  await action('Paste');
  const input = await screen.findByRole('textbox', { name: en['terminal.paste.fallbackTitle'] });
  fireEvent.change(input, { target: { value: 'line one\nline two' } });
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
  expect(f.second.write).toHaveBeenCalledExactlyOnceWith('line one\rline two'); expect(f.first.write).not.toHaveBeenCalled();
});

test('copy dialogs and late source replies retire when the terminal binding changes', async () => {
  const pending = Promise.withResolvers<TerminalTextSnapshot>(), signals: AbortSignal[] = [];
  const readCopy = vi.fn((_selection, signal: AbortSignal) => { signals.push(signal); return pending.promise; });
  const f = fixture({ readCopy });
  await action('Copy'); expect(screen.getByRole('dialog', { name: en['terminal.copy.title'] })).toBeInTheDocument();
  f.update({ second: true });
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ kind: 'visible', lines: ['previous source text'] }));
  expect(screen.queryByRole('dialog', { name: en['terminal.copy.title'] })).not.toBeInTheDocument();
  expect(screen.queryByText('previous source text')).not.toBeInTheDocument();
  readCopy.mockResolvedValue({ kind: 'visible', lines: ['current source text'] }); await action('Copy');
  expect(await screen.findByText('current source text')).toBeInTheDocument();
  f.update({ second: false }); expect(screen.queryByRole('dialog', { name: en['terminal.copy.title'] })).not.toBeInTheDocument();
});

test('Chinese composition confirmation cannot submit a command and hidden/read-only terminals cannot send controls', async () => {
  const f = fixture(); await action('Command');
  const input = screen.getByRole('textbox', { name: 'Command input' }), form = input.closest('form')!;
  fireEvent.change(input, { target: { value: 'echo 中文' } }); fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 }); fireEvent.submit(form);
  fireEvent.compositionEnd(input); fireEvent.submit(form);
  expect(f.first.write).not.toHaveBeenCalled(); expect(input).toHaveValue('echo 中文');
  // Some phone IMEs end composition without a keyup. An explicit Run tap still works.
  fireEvent.click(screen.getByRole('button', { name: 'Run command' }), { detail: 1 });
  expect(f.first.write).toHaveBeenCalledExactlyOnceWith('echo 中文\r'); expect(input).toHaveValue('');
  fireEvent.change(input, { target: { value: 'hidden command' } }); f.update({ visible: false }); fireEvent.submit(form);
  expect(f.first.write).toHaveBeenCalledTimes(1); expect(input).toHaveValue('hidden command');
  f.update({ visible: true }); await act(async () => f.first.state.set({ ...f.first.state.getSnapshot(), writable: false }));
  expect(screen.getByRole('button', { name: 'Interrupt process' })).toBeDisabled(); fireEvent.submit(form);
  expect(f.first.write).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(f.first.close).not.toHaveBeenCalled());
});
