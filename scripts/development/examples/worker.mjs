// Deliberately broken deterministic fixture; this is not an AI capability benchmark.
import { writeFileSync } from 'node:fs'
writeFileSync(`${process.env.HHPI_RSI_WORKSPACE}/answer.json`, '[]')
