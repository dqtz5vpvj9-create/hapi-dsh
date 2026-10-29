/** Filesystem-only package fixture for doctor. No compiler output or runtime is simulated. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLIENT_CHUNKS } from '../../src/cli/runtime.ts'

export async function createDoctorPackage(root: string): Promise<string> {
  const directory = join(root, 'doctor-package')
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'hapi-dsh', main: './dist/index.js',
    exports: { './client': './dist/client.js' },
    dsh: { bundle: { patch: './bundle.yaml' } },
  }))
  for (const name of ['index.js', 'client.js', ...CLIENT_CHUNKS]) {
    await writeFile(join(directory, 'dist', name), '// artifact-presence fixture only\n')
  }
  await writeFile(join(directory, 'bundle.yaml'), '[]\n')
  return directory
}
