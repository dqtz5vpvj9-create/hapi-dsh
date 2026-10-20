import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Commit one private JSON journal, cleaning temporary files on every failure. */
export function writeDurableJson(filename: string, value: unknown): void {
  const encoded = JSON.stringify(value)
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const file = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(file, encoded); fsyncSync(file) } finally { closeSync(file) }
    renameSync(temporary, filename)
    // Windows does not support opening directories for fsync. The file itself
    // remains flushed before its atomic rename on every supported platform.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(filename), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally { rmSync(temporary, { force: true }) }
}
