import { writeFileSync } from 'node:fs'
import { WarmOfficialSession } from '../../e2e/warm-session.ts'
import { beginUiLive } from '../../e2e/ui-live-fixture.ts'

const modes = ['marker', 'setter', 'off']
const samples = 3
const session = new WarmOfficialSession()
await session.start()
const results = []
for (const mode of modes) {
  process.env.HAPI_DSH_FOLLOW_EDGE = mode
  for (let sample = 1; sample <= samples; sample++) {
    const page = await session.page()
    const errors = []
    page.on('pageerror', error => errors.push(String(error).slice(0, 160)))
    const record = { mode, sample, errors }
    try {
      await session.admit(page)
      await page.locator('button.hapi-session-open').filter({ hasText: 'Native Codex accept-history' }).first().click()
      const pane = page.getByRole('region', { name: 'Pane: Native Codex accept-history', exact: true })
      await pane.locator('[data-chat-flow]').first().waitFor({ timeout: 30000 })
      await pane.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30000 })
      const port = pane.locator('[data-conversation-scroll]').first()
      await page.waitForTimeout(600)
      const text = `Follow matrix answer ${mode} ${sample} ${crypto.randomUUID()}`
      const live = beginUiLive(session.environment.hapi, 'native-accept-history', 'indexed')
      try {
        record.marker = await page.evaluate(() => document.documentElement.dataset.dshFollowEdge ?? null)
        // 1) Leave the edge first so following is clear in every mode; later
        //    chunks must not pull the reader.
        await port.evaluate(element => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40) })
        await page.waitForTimeout(400)
        record.awayBefore = await port.evaluate(element => ({ top: element.scrollTop, remaining: element.scrollHeight - element.clientHeight - element.scrollTop }))
        record.followingWhileAway = await pane.locator('[data-chat-following-tail]').count()
        for (let chunk = 1; chunk <= 2; chunk++) {
          live.update(`${text}: tail content ${'away '.repeat(chunk)}`)
          await page.waitForTimeout(320)
        }
        record.awayAfter = await port.evaluate(element => ({ top: element.scrollTop, remaining: element.scrollHeight - element.clientHeight - element.scrollTop }))
        record.awayDelta = record.awayAfter.top - record.awayBefore.top
        // 2) Programmatic landing exactly at the live edge: ext 0004 is the
        //    only path that may re-enter following here.
        await port.evaluate(element => { element.scrollTop = element.scrollHeight })
        await page.waitForTimeout(400)
        record.followingAfterProgrammaticFloor = await pane.locator('[data-chat-following-tail]').count()
        record.before = await port.evaluate(element => ({ top: element.scrollTop, floor: element.scrollHeight - element.clientHeight }))
        for (let chunk = 3; chunk <= 5; chunk++) {
          live.update(`${text}: tail content ${'follow '.repeat(chunk)}`)
          await page.waitForTimeout(320)
        }
        record.afterTailStream = await port.evaluate(element => ({ top: element.scrollTop, floor: element.scrollHeight - element.clientHeight,
          remaining: element.scrollHeight - element.clientHeight - element.scrollTop }))
        record.followedTail = record.afterTailStream.remaining <= 4
      } finally { live.finish() }
    } catch (error) {
      record.error = String(error).slice(0, 240)
    }
    results.push(record)
    await page.context().close().catch(() => {})
  }
}
await session.close().catch(() => {})
const summary = modes.map(mode => {
  const rows = results.filter(row => row.mode === mode)
  return { mode, samples: rows.length,
    followedTail: rows.filter(row => row.followedTail === true).length,
    stayedAway: rows.filter(row => row.awayDelta === 0).length,
    followingMarkerAtFloor: rows.filter(row => row.followingAfterProgrammaticFloor > 0).length,
    errors: rows.filter(row => row.error).map(row => row.error) }
})
writeFileSync('/mnt/cache/src/hapi-dsh/.tmp/gates/follow-edge-matrix.json', JSON.stringify({ summary, results }, null, 1))
console.log(JSON.stringify(summary, null, 1))
