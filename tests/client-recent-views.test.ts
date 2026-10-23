/** View lifetime fixtures; no source execution or browser is simulated. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecentViews } from '../src/client/surface/recent-views.ts'

test('return visits recover the same view only within the same pane and source', () => {
 const released: object[] = [], cache = new RecentViews<object>(2, view => released.push(view)), a = {}, b = {}
 cache.park('p1','a',a); cache.park('p2','a',b)
 assert.equal(cache.take('p1','b'), undefined)
 assert.equal(cache.take('p1','a'), a)
 assert.equal(cache.take('p2','a'), b)
 assert.deepEqual(released, [])
})
test('view count stays bounded and closing a pane releases all its parked views', () => {
 const released: string[] = [], cache = new RecentViews<string>(2, view => released.push(view))
 cache.park('p1','a','a'); cache.park('p1','b','b'); cache.park('p2','c','c')
 assert.deepEqual(released, ['a'])
 cache.prune(new Set(['p2']))
 assert.deepEqual(released, ['a','b'])
 assert.equal(cache.take('p1','b'), undefined)
 cache.clear(); assert.deepEqual(released, ['a','b','c'])
})
