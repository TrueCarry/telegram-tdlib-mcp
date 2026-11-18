/**
 * Generates a machine-readable catalog of the TDLib API from `td_api.tl`.
 *
 * TDLib exposes no runtime introspection, so the only way for an agent to
 * discover the ~1010 available methods and their parameters is to parse the
 * schema at build time. The schema is fetched at the exact commit that the
 * installed `prebuilt-tdlib` binary was built from, guaranteeing the catalog
 * always matches the binary we actually call.
 *
 * Output: src/generated/schema.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_PATH = resolve(ROOT, 'src/generated/schema.json')

interface TlParam {
  name: string
  type: string
  description: string
}

interface TlEntry {
  name: string
  /** Parameters in declaration order. */
  params: TlParam[]
  /** The TL result type, e.g. `Ok`, `Message`, `Chat`. */
  returns: string
  description: string
  /** For types: the abstract class it belongs to (its union parent). */
  class?: string
  /** True when the method may be called synchronously via tdl.execute(). */
  isSynchronous?: boolean
}

interface Catalog {
  tdlibVersion: string
  tdlibCommit: string
  generatedAt: string
  methods: TlEntry[]
  types: TlEntry[]
  /** Abstract class -> description, for union types like `AuthorizationState`. */
  classes: Record<string, { description: string; members: string[] }>
}

function getTdlibInfo(): { commit: string; version: string } {
  const req = createRequire(import.meta.url)
  const prebuilt = req('prebuilt-tdlib') as {
    getTdlibInfo: () => { commit: string; version: string }
  }
  return prebuilt.getTdlibInfo()
}

async function fetchSchema(commit: string): Promise<string> {
  // Allow an offline/local override, useful in sandboxes and CI without network.
  const override = process.env.TD_API_TL_PATH
  if (override && existsSync(override)) {
    console.error(`[gen-schema] using local schema from ${override}`)
    return readFileSync(override, 'utf8')
  }

  const url = `https://raw.githubusercontent.com/tdlib/td/${commit}/td/generate/scheme/td_api.tl`
  console.error(`[gen-schema] fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch td_api.tl at commit ${commit}: HTTP ${res.status}`)
  }
  return await res.text()
}

/**
 * Joins a doc comment block into a single string.
 *
 * TDLib doc comments come in two shapes:
 *   //@description Foo @param_a Bar @param_b Baz          (packed on one line)
 *   //@description Foo
 *   //-continued text of the previous field
 *   //@param_a Bar                                        (one field per line)
 */
function normalizeDocBlock(lines: string[]): string {
  const parts: string[] = []
  for (const line of lines) {
    const body = line.replace(/^\/\//, '')
    if (body.startsWith('-')) {
      // Continuation of the previous field's text.
      parts.push(' ' + body.slice(1).trim())
    } else {
      parts.push((parts.length ? ' ' : '') + body.trim())
    }
  }
  return parts.join('').trim()
}

/**
 * Splits a normalized doc block into its `@`-prefixed sections.
 *
 * We only split on keys we know exist (`description` plus the declared
 * parameter names), because descriptive prose legitimately contains `@`
 * (e.g. "the bot @username") which would otherwise corrupt the parse.
 */
function splitDoc(doc: string, knownKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!doc) return out

  const keys = ['description', 'class', ...knownKeys]
  // Build an alternation of the exact known keys, longest first so that a key
  // that is a prefix of another (e.g. `id` vs `id_hash`) cannot shadow it.
  const escaped = [...new Set(keys)]
    .sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`@(${escaped.join('|')})\\b`, 'g')

  const matches = [...doc.matchAll(re)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!
    const key = m[1]!
    const start = m.index! + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : doc.length
    out[key] = doc.slice(start, end).trim()
  }
  return out
}

/** Parses `name:type` pairs out of a TL definition body. */
function parseParams(body: string): Array<{ name: string; type: string }> {
  const params: Array<{ name: string; type: string }> = []
  // Tokens are space-separated; a parameter is `name:type`. Types may contain
  // nested vectors like `vector<vector<inlineKeyboardButton>>` but no spaces.
  for (const token of body.split(/\s+/)) {
    if (!token) continue
    const colon = token.indexOf(':')
    if (colon <= 0) continue
    params.push({ name: token.slice(0, colon), type: token.slice(colon + 1) })
  }
  return params
}

function parse(schema: string, info: { commit: string; version: string }): Catalog {
  const lines = schema.split('\n')

  const methods: TlEntry[] = []
  const types: TlEntry[] = []
  const classes: Catalog['classes'] = {}

  let inFunctions = false
  let pendingDoc: string[] = []
  /** Definitions can span multiple physical lines; accumulate until the `;`. */
  let pendingDef = ''

  const flushEntry = (defLine: string) => {
    // `name param:type ... = ReturnType;`
    const eq = defLine.lastIndexOf('=')
    if (eq === -1) return
    const lhs = defLine.slice(0, eq).trim()
    const returns = defLine
      .slice(eq + 1)
      .replace(/;$/, '')
      .trim()

    const firstSpace = lhs.search(/\s/)
    const name = firstSpace === -1 ? lhs : lhs.slice(0, firstSpace)
    const body = firstSpace === -1 ? '' : lhs.slice(firstSpace + 1)
    if (!name) return

    const rawParams = parseParams(body)
    const doc = normalizeDocBlock(pendingDoc)
    const sections = splitDoc(
      doc,
      rawParams.map(p => p.name),
    )

    const entry: TlEntry = {
      name,
      params: rawParams.map(p => ({
        name: p.name,
        type: p.type,
        description: sections[p.name] ?? '',
      })),
      returns,
      description: sections.description ?? '',
    }

    if (inFunctions) {
      // TDLib marks synchronously-callable methods in the description.
      if (/can be called synchronously/i.test(entry.description)) {
        entry.isSynchronous = true
      }
      methods.push(entry)
    } else {
      // A concrete type belongs to an abstract class when its return type is
      // capitalized and differs from its own (lowercase-initial) name.
      if (returns && returns[0] === returns[0]!.toUpperCase()) {
        entry.class = returns
        if (!classes[returns]) classes[returns] = { description: '', members: [] }
        classes[returns]!.members.push(name)
      }
      types.push(entry)
    }
    pendingDoc = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    if (line.startsWith('---functions---')) {
      inFunctions = true
      pendingDoc = []
      continue
    }
    if (line.startsWith('---types---')) {
      inFunctions = false
      pendingDoc = []
      continue
    }

    if (line.startsWith('//')) {
      // `//@class Foo @description ...` documents an abstract union type.
      if (/^\/\/@class\s/.test(line)) {
        const doc = normalizeDocBlock([line])
        const m = /^@class\s+(\S+)/.exec(doc)
        if (m) {
          const className = m[1]!
          const descMatch = /@description\s+([\s\S]*)$/.exec(doc)
          if (!classes[className]) classes[className] = { description: '', members: [] }
          classes[className]!.description = descMatch ? descMatch[1]!.trim() : ''
        }
        pendingDoc = []
        continue
      }
      pendingDoc.push(line)
      continue
    }

    if (!line.trim()) {
      // Blank line separates doc blocks from unrelated definitions, but only
      // when we are not mid-definition.
      if (!pendingDef) pendingDoc = []
      continue
    }

    pendingDef += (pendingDef ? ' ' : '') + line.trim()
    if (pendingDef.endsWith(';')) {
      flushEntry(pendingDef)
      pendingDef = ''
    }
  }

  return {
    tdlibVersion: info.version,
    tdlibCommit: info.commit,
    generatedAt: new Date().toISOString(),
    methods,
    types,
    classes,
  }
}

async function main() {
  const info = getTdlibInfo()
  console.error(`[gen-schema] TDLib ${info.version} @ ${info.commit}`)

  const schema = await fetchSchema(info.commit)
  const catalog = parse(schema, info)

  if (catalog.methods.length < 500) {
    throw new Error(
      `Parsed only ${catalog.methods.length} methods, expected >500. The schema format may have changed.`,
    )
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(catalog))

  console.error(
    `[gen-schema] wrote ${catalog.methods.length} methods, ${catalog.types.length} types, ` +
      `${Object.keys(catalog.classes).length} classes -> ${OUT_PATH}`,
  )
}

main().catch(err => {
  console.error('[gen-schema] failed:', err)
  process.exit(1)
})
