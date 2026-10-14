import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = await Bun.build({ entrypoints: [join(root, 'src/dsh/host.ts')], target: 'node', format: 'esm', packages: 'external', sourcemap: 'none', minify: false })
if (!result.success) { console.error(result.logs); throw new Error('Bun.build host failed') }
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib/dsh-host.js'), await result.outputs[0].text())
console.log('wrote lib/dsh-host.js')
