import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TlParam {
  name: string
  type: string
  description: string
}

export interface TlEntry {
  name: string
  params: TlParam[]
  returns: string
  description: string
  class?: string
  isSynchronous?: boolean
}

export interface Catalog {
  tdlibVersion: string
  tdlibCommit: string
  generatedAt: string
  methods: TlEntry[]
  types: TlEntry[]
  classes: Record<string, { description: string; members: string[] }>
}

let catalog: Catalog | undefined
let methodIndex: Map<string, TlEntry> | undefined
let typeIndex: Map<string, TlEntry> | undefined

/**
 * Loads the build-time generated TDLib API catalog.
 *
 * TDLib offers no runtime introspection, so this file - produced by
 * `npm run gen:schema` from the exact `td_api.tl` matching the shipped binary -
 * is the only source of method/parameter discovery.
 */
export function getCatalog(): Catalog {
  if (catalog) return catalog

  const here = dirname(fileURLToPath(import.meta.url))
  // Resolves for both `src/` (tsx) and `dist/` (compiled) layouts.
  const candidates = [
    resolve(here, 'generated/schema.json'),
    resolve(here, '../src/generated/schema.json'),
    resolve(here, '../../src/generated/schema.json'),
  ]

  let raw: string | undefined
  for (const candidate of candidates) {
    try {
      raw = readFileSync(candidate, 'utf8')
      break
    } catch {
      continue
    }
  }

  if (!raw) {
    throw new Error(
      'TDLib API catalog not found. Run `npm run gen:schema` to generate ' +
        'src/generated/schema.json before starting the server.',
    )
  }

  catalog = JSON.parse(raw) as Catalog
  return catalog
}

export function getMethod(name: string): TlEntry | undefined {
  if (!methodIndex) {
    methodIndex = new Map(getCatalog().methods.map(m => [m.name, m]))
  }
  return methodIndex.get(name)
}

export function getType(name: string): TlEntry | undefined {
  if (!typeIndex) {
    typeIndex = new Map(getCatalog().types.map(t => [t.name, t]))
  }
  return typeIndex.get(name)
}

/** Formats an entry as its TL signature, e.g. `getChat chat_id:int53 = Chat`. */
export function formatSignature(entry: TlEntry): string {
  const params = entry.params.map(p => `${p.name}:${p.type}`).join(' ')
  return `${entry.name}${params ? ' ' + params : ''} = ${entry.returns}`
}
