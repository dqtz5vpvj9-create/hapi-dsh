/** Actual sidebar presentation and persistence; original-source head resolution is the caller's boundary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SidebarState } from '../src/workspace/sidebar-state.ts'

test('source-derived unread never changes the original seen time and manual unread always wins', () => {
    const memory = new Map<string, string>(), storage = { getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => { memory.set(key, value) } }
    const sidebar = new SidebarState(storage, 'sidebar')
    sidebar.mergeSource([{ id: 'owned', seenAt: 4490, manualUnreadAt: null }])
    sidebar.setSourceUnread([{ id: 'owned', updatedAt: 9000, unread: false }])
    assert.equal(sidebar.isUnread('owned', 9000), false)
    assert.equal(sidebar.getSnapshot().seen.owned, 4490)
    assert.equal(sidebar.isUnread('owned', 10000), true, 'a changed catalog version cannot inherit the former source-head result')
    sidebar.markUnread('owned', 9001)
    assert.equal(sidebar.isUnread('owned', 9000), true)
    const reopened = new SidebarState(storage, 'sidebar')
    reopened.mergeSource([{ id: 'owned', seenAt: 4490, manualUnreadAt: null }])
    assert.equal(reopened.isUnread('owned', 9000), true, 'head-derived display facts are not persisted as fabricated timestamps')
})

test('retiring an account read owner clears only its derived unread display facts', () => {
    const sidebar = new SidebarState()
    sidebar.mergeSource([{ id: 'owned', seenAt: 4490, manualUnreadAt: null }])
    const stop = sidebar.installReadActions({ canMarkSeen: () => true, markSeen() {} })
    sidebar.setSourceUnread([{ id: 'owned', updatedAt: 9000, unread: false }])
    assert.equal(sidebar.isUnread('owned', 9000), false)
    stop()
    assert.equal(sidebar.isUnread('owned', 9000), true)
    assert.equal(sidebar.getSnapshot().seen.owned, 4490)
})

test('historical sessions older than 7 days suppress automatic unread noise while preserving manual unread', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const eightDaysAgo = now - 8 * 86_400_000
    const twoDaysAgo = now - 2 * 86_400_000
    const sidebar = new SidebarState()
    sidebar.mergeSource([
        { id: 'stale', seenAt: 0, manualUnreadAt: null },
        { id: 'recent', seenAt: 0, manualUnreadAt: null },
    ])
    assert.equal(sidebar.isUnread('stale', eightDaysAgo, now), false)
    assert.equal(sidebar.isUnread('recent', twoDaysAgo, now), true)
    sidebar.markUnread('stale', eightDaysAgo)
    assert.equal(sidebar.isUnread('stale', eightDaysAgo, now), true)
})
