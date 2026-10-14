import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const result = await Bun.build({
  entrypoints: [join(root, 'src/client/index.ts')], target: 'browser', format: 'cjs', sourcemap: 'none', minify: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
})
if (!result.success) { console.error(result.logs); throw new Error('Bun.build client failed') }
const body = (await result.outputs[0].text()).replace(/^"use strict";\s*/m, '').replace(/Object\.defineProperty\(exports,\s*"__esModule"[\s\S]*?;\s*/m, '')
const artifact = `window.__ModuleLoader__.load({
  id: "dsh-memwiki",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
    return module.exports;
  }
});
`
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib/client.js'), artifact)
console.log('wrote lib/client.js')
