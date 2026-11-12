/** Actual production release boundary with Node's Win32 path semantics; no Windows FS claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'

const { runtimeFilePath } = createRequire(import.meta.url)('../scripts/bundle/lib/runtime.mjs') as {
    runtimeFilePath(directory: string, file: string, paths?: typeof win32): string | undefined
}

test('a Windows runtime accepts its sealed package file and refuses sibling, parent and other-drive paths', () => {
    const directory = 'D:\\hapi\\release\\runtime'
    assert.equal(runtimeFilePath(directory, 'node_modules/@deepseek-ai/dsh/lib/index.js', win32),
        'D:\\hapi\\release\\runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\index.js')
    assert.equal(runtimeFilePath(directory, 'd:/hapi/release/runtime/node_modules/package.json', win32),
        'd:\\hapi\\release\\runtime\\node_modules\\package.json')
    for (const outside of ['../manifest.json', '..\\runtime-other\\package.json', 'E:\\runtime\\package.json', '\\\\server\\share\\package.json', '.'])
        assert.equal(runtimeFilePath(directory, outside, win32), undefined, outside)
})
