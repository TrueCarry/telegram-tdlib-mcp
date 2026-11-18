import { z } from 'zod'

import {
  getCatalog,
  getMethod,
  getType,
  formatSignature,
  type TlEntry,
} from '../catalog.js'
import { jsonResult, type ToolResult } from './common.js'

export const schemaInputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      'Free-text search across method/type names and descriptions, e.g. "callback query", ' +
        '"send message", "inline keyboard".',
    ),
  method: z
    .string()
    .optional()
    .describe('Exact method name to describe in full, e.g. "sendMessage".'),
  type: z
    .string()
    .optional()
    .describe(
      'Exact type or abstract class name to describe, e.g. "inlineKeyboardButton" or ' +
        '"InlineKeyboardButtonType" (a class lists all its variants).',
    ),
  kind: z
    .enum(['methods', 'types', 'both'])
    .optional()
    .describe('Restrict a `query` search. Defaults to "both".'),
  expand: z
    .boolean()
    .optional()
    .describe(
      'When describing a method or type, also inline the definitions of the parameter types it ' +
        'references (one level deep). Useful for nested payloads like sendMessage. Defaults to true ' +
        'for `method`/`type` lookups.',
    ),
  limit: z.number().int().min(1).max(100).optional().describe('Max search results. Default 25.'),
}

const SchemaArgs = z.object(schemaInputSchema)

export const schemaToolDescription =
  "Discover the TDLib API: search or describe any of the 1010 methods and 2168 types, with " +
  "TDLib's own documentation for every parameter. Use this before tg_invoke to find exact " +
  'method names, parameter names, and nested payload shapes. ' +
  'Examples: {"query": "callback query"} to search, {"method": "sendMessage"} for a full ' +
  'signature, {"type": "InlineKeyboardButtonType"} to list all button variants.'

/** Primitive TL types that need no further expansion. */
const PRIMITIVES = new Set([
  'int32',
  'int53',
  'int64',
  'string',
  'bytes',
  'Bool',
  'double',
  'vector',
])

/** Strips vector<...> wrappers to get at the element type. */
function baseType(type: string): string {
  let t = type
  while (t.startsWith('vector<') && t.endsWith('>')) {
    t = t.slice('vector<'.length, -1)
  }
  return t
}

function describeEntry(entry: TlEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: entry.name,
    signature: formatSignature(entry),
    description: entry.description,
    returns: entry.returns,
    params: entry.params.map(p => ({
      name: p.name,
      type: p.type,
      description: p.description,
    })),
  }
  if (entry.class) out.belongs_to_class = entry.class
  if (entry.isSynchronous) {
    out.synchronous = true
    out.note = 'This method can be called synchronously by passing sync=true to tg_invoke.'
  }
  return out
}

/**
 * Resolves the definitions referenced by an entry's parameters, so an agent can
 * construct a nested payload without a second round of lookups.
 */
function expandReferences(entry: TlEntry): Record<string, unknown> {
  const catalog = getCatalog()
  const referenced: Record<string, unknown> = {}

  for (const param of entry.params) {
    const t = baseType(param.type)
    if (PRIMITIVES.has(t) || referenced[t]) continue

    const cls = catalog.classes[t]
    if (cls) {
      // Abstract class: list its concrete variants so the agent knows the
      // possible "@type" values for this field.
      referenced[t] = {
        kind: 'abstract_class',
        description: cls.description,
        variants: cls.members.map(name => {
          const member = getType(name)
          return member
            ? { name, signature: formatSignature(member), description: member.description }
            : { name }
        }),
      }
      continue
    }

    const concrete = getType(t)
    if (concrete) {
      referenced[t] = { kind: 'type', ...describeEntry(concrete) }
    }
  }

  return referenced
}

/**
 * Levenshtein distance, capped for early exit. Used only for "did you mean"
 * suggestions, where substring search fails on typos (e.g. "sendMesage").
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 4) return Infinity

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

/**
 * Finds close name matches for a term that produced no exact/substring hit,
 * so a typo'd method name still guides the caller to the right one.
 */
export function suggestNames(term: string, kind: 'methods' | 'types', limit = 5): string[] {
  const catalog = getCatalog()
  const pool = kind === 'methods' ? catalog.methods : catalog.types
  const needle = term.toLowerCase()

  return pool
    .map(e => ({ name: e.name, d: editDistance(needle, e.name.toLowerCase()) }))
    .filter(x => x.d <= 3)
    .sort((a, b) => a.d - b.d || a.name.length - b.name.length)
    .slice(0, limit)
    .map(x => x.name)
}

function search(term: string, kind: 'methods' | 'types' | 'both', limit: number) {
  const catalog = getCatalog()
  const needle = term.toLowerCase()
  const words = needle.split(/\s+/).filter(Boolean)

  const score = (entry: TlEntry): number => {
    const name = entry.name.toLowerCase()
    const desc = entry.description.toLowerCase()

    if (name === needle) return 1000
    let s = 0
    // Whole phrase matches rank above scattered word matches.
    if (name.includes(needle)) s += 100
    if (desc.includes(needle)) s += 20

    for (const w of words) {
      if (name.includes(w)) s += 10
      if (desc.includes(w)) s += 2
    }
    return s
  }

  const pool: Array<{ entry: TlEntry; kind: 'method' | 'type' }> = []
  if (kind === 'methods' || kind === 'both') {
    for (const m of catalog.methods) pool.push({ entry: m, kind: 'method' })
  }
  if (kind === 'types' || kind === 'both') {
    for (const t of catalog.types) pool.push({ entry: t, kind: 'type' })
  }

  return pool
    .map(item => ({ ...item, score: score(item.entry) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length)
    .slice(0, limit)
    .map(item => ({
      kind: item.kind,
      name: item.entry.name,
      signature: formatSignature(item.entry),
      description: item.entry.description,
    }))
}

export function handleSchema(rawArgs: unknown): ToolResult {
  const args = SchemaArgs.parse(rawArgs)
  const catalog = getCatalog()
  const expand = args.expand ?? true

  if (args.method) {
    const entry = getMethod(args.method)
    if (!entry) {
      // Substring search first; fall back to edit distance for typos.
      const byText = search(args.method, 'methods', 5).map(s => s.name)
      const suggestions = byText.length > 0 ? byText : suggestNames(args.method, 'methods')
      return jsonResult(
        {
          ok: false,
          error: `Unknown method "${args.method}".`,
          did_you_mean: suggestions,
        },
        true,
      )
    }
    return jsonResult({
      ok: true,
      kind: 'method',
      ...describeEntry(entry),
      ...(expand ? { referenced_types: expandReferences(entry) } : {}),
    })
  }

  if (args.type) {
    // An abstract class (capitalized) enumerates its variants.
    const cls = catalog.classes[args.type]
    if (cls) {
      return jsonResult({
        ok: true,
        kind: 'abstract_class',
        name: args.type,
        description: cls.description,
        variants: cls.members.map(name => {
          const member = getType(name)
          return member ? describeEntry(member) : { name }
        }),
      })
    }

    const entry = getType(args.type)
    if (!entry) {
      const byText = search(args.type, 'types', 5).map(s => s.name)
      const suggestions = byText.length > 0 ? byText : suggestNames(args.type, 'types')
      return jsonResult(
        {
          ok: false,
          error: `Unknown type "${args.type}".`,
          did_you_mean: suggestions,
        },
        true,
      )
    }
    return jsonResult({
      ok: true,
      kind: 'type',
      ...describeEntry(entry),
      ...(expand ? { referenced_types: expandReferences(entry) } : {}),
    })
  }

  if (args.query) {
    const limit = args.limit ?? 25
    const results = search(args.query, args.kind ?? 'both', limit)
    return jsonResult({
      ok: true,
      query: args.query,
      count: results.length,
      results,
      hint:
        results.length > 0
          ? 'Call tg_schema again with {"method": "<name>"} or {"type": "<name>"} for full parameter details.'
          : 'No matches. Try a broader term.',
    })
  }

  // No arguments: return an overview to orient the agent.
  return jsonResult({
    ok: true,
    tdlib_version: catalog.tdlibVersion,
    tdlib_commit: catalog.tdlibCommit,
    method_count: catalog.methods.length,
    type_count: catalog.types.length,
    usage: {
      search: '{"query": "callback query"}',
      describe_method: '{"method": "sendMessage"}',
      describe_type: '{"type": "InlineKeyboardButtonType"}',
    },
    common_bot_testing_methods: [
      { name: 'searchPublicChat', purpose: 'Resolve a bot by @username (pass it without the @).' },
      { name: 'sendBotStartMessage', purpose: 'Send /start with an optional deep-link parameter.' },
      { name: 'sendMessage', purpose: 'Send a message; also how you press a reply-keyboard button.' },
      { name: 'getCallbackQueryAnswer', purpose: 'Press an inline callback button.' },
      { name: 'getChatHistory', purpose: 'Read messages; call openChat first and expect partial batches.' },
      { name: 'openChat', purpose: 'Mark a chat as open so TDLib keeps its history current.' },
      { name: 'viewMessages', purpose: 'Mark messages as read.' },
    ],
  })
}
