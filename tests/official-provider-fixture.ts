/** Minimal Loader discovery fixture; Cordis isolation and the official services themselves are real. */
import type { Context } from '@deepseek-ai/cordis'
import { LocalRealm, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { OFFICIAL_PROVIDERS, OFFICIAL_PROVIDER_PACKAGES, type OfficialProviderId } from '../src/shared/official-provider.ts'

const rows = new WeakMap<Context, Entry[]>()
export function officialDelegateFixture(ctx: Context, id: OfficialProviderId, config: unknown): Context {
  let entries = rows.get(ctx)
  if (!entries) {
    entries = []
    rows.set(ctx, entries)
    const selected = entries
    ctx.provide('loader', { *entries() { yield* selected } } as Context['loader'])
  }
  const service = OFFICIAL_PROVIDERS[id]
  const entry = { options: { id, name: OFFICIAL_PROVIDER_PACKAGES[id], isolate: { [service]: true } }, disabled: false,
    fiber: { config } } as unknown as Entry
  entry.realm = new LocalRealm(entry)
  const scope = ctx.isolate(service, entry.realm.access(service, true))
  entries.push(entry)
  return scope
}
