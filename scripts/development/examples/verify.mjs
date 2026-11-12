import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
const task = JSON.parse(readFileSync(process.env.HHPI_RSI_CASE, 'utf8'))
const answer = JSON.parse(readFileSync(`${process.env.HHPI_RSI_WORKSPACE}/answer.json`, 'utf8'))
const expected = task.input.items.map(item => item.trim())
writeFileSync(process.env.HHPI_RSI_RESULT, JSON.stringify({ checks: { normalized: isDeepStrictEqual(answer, expected) } }))
