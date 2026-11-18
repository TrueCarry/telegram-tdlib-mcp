/**
 * Copies the generated TDLib catalog into dist/ so the compiled server can
 * load it without depending on the source tree.
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'src/generated/schema.json')
const dest = resolve(root, 'dist/generated/schema.json')

if (!existsSync(src)) {
  console.error('[copy-schema] src/generated/schema.json not found. Run `npm run gen:schema` first.')
  process.exit(1)
}

mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.error(`[copy-schema] ${src} -> ${dest}`)
