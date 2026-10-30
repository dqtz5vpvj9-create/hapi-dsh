import { defineConfig } from 'vitest/config'
import { faults } from './tests/experience/faults.ts'

const faultName = process.env.HAPI_DSH_TEST_FAULT
if (faultName && !(faultName in faults)) throw new Error(`Unknown experience fault: ${faultName}`)
const fault = faultName ? faults[faultName as keyof typeof faults] : undefined

export default defineConfig({
  plugins: fault ? [{
    name: 'experience-fault', enforce: 'pre',
    transform(code, id) {
      const modulePath = id.replaceAll('\\', '/').split('?', 1)[0]!
      if (!modulePath.endsWith(`/${fault.file}`)) return
      if (code.split(fault.before).length !== 2) throw new Error(`Fault target changed: ${faultName}`)
      return { code: code.replace(fault.before, fault.after), map: null }
    },
  }] : [],
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/experience/**/*.test.tsx'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://experience.invalid/' } },
    setupFiles: ['tests/experience/setup.ts'],
    // Deterministic interaction tests, not CPU benchmarks. Bound worker memory.
    maxWorkers: 2,
    testTimeout: 5_000,
    hookTimeout: 10_000,
    retry: 0,
    clearMocks: true,
  },
})
