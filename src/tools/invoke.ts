import { z } from 'zod'

import { getSession } from '../tdlib.js'
import { getMethod, formatSignature } from '../catalog.js'
import { suggestNames } from './schema.js'
import { jsonResult, errorResult, normalizeDiscriminator, type ToolResult } from './common.js'

export const invokeInputSchema = {
  method: z
    .string()
    .optional()
    .describe(
      'TDLib method name, e.g. "getMe", "searchPublicChat", "sendMessage". ' +
        'Omit if you pass a full request object in `request` instead.',
    ),
  params: z
    .record(z.unknown())
    .optional()
    .describe(
      'Parameters for the method, using TDLib\'s exact snake_case field names. ' +
        'Nested objects need their own type tag, e.g. ' +
        '{"input_message_content": {"@type": "inputMessageText", "text": {"@type": "formattedText", "text": "hi"}}}',
    ),
  request: z
    .record(z.unknown())
    .optional()
    .describe(
      'A complete TDLib request object including its type tag, e.g. ' +
        '{"@type": "getChat", "chat_id": 123}. Use this to paste payloads verbatim from the TDLib docs. ' +
        'Either `method` or `request` is required.',
    ),
  sync: z
    .boolean()
    .optional()
    .describe(
      'Execute synchronously instead of sending to the server. Only valid for methods TDLib marks ' +
        'as synchronous (e.g. getTextEntities, parseTextEntities, getMarkdownText).',
    ),
}

const InvokeArgs = z.object(invokeInputSchema)

export const invokeToolDescription =
  'Call ANY TDLib method directly (1010 available). This is a thin passthrough: parameters are ' +
  "sent to TDLib verbatim using its own snake_case field names, so payloads from Telegram's TDLib " +
  'documentation work as-is. Type tags may be written as either "@type" (TDLib native) or "_". ' +
  'Use tg_schema first to discover exact method names and parameters. ' +
  'Errors are returned structurally with TDLib\'s numeric code rather than thrown.'

export async function handleInvoke(rawArgs: unknown): Promise<ToolResult> {
  const args = InvokeArgs.parse(rawArgs)

  let request: Record<string, unknown>

  if (args.request && Object.keys(args.request).length > 0) {
    request = normalizeDiscriminator(args.request) as Record<string, unknown>
    if (args.method && !request._) request._ = args.method
  } else if (args.method) {
    const params = args.params ? (normalizeDiscriminator(args.params) as Record<string, unknown>) : {}
    request = { _: args.method, ...params }
  } else {
    return jsonResult(
      {
        ok: false,
        error: {
          code: 0,
          message: 'Either `method` or `request` must be provided.',
        },
      },
      true,
    )
  }

  const methodName = typeof request._ === 'string' ? request._ : undefined
  if (!methodName) {
    return jsonResult(
      {
        ok: false,
        error: {
          code: 0,
          message: 'Request has no method type. Provide `method`, or include "@type" in `request`.',
        },
      },
      true,
    )
  }

  // Catch typos against the catalog before spending a round trip, and point at
  // the real signature so the agent can self-correct.
  const known = getMethod(methodName)
  if (!known) {
    return jsonResult(
      {
        ok: false,
        error: {
          code: 0,
          message: `Unknown TDLib method "${methodName}".`,
        },
        did_you_mean: suggestNames(methodName, 'methods'),
        hint: 'Use tg_schema with a query to find the correct method name.',
      },
      true,
    )
  }

  const session = getSession()

  try {
    if (args.sync) {
      const result = session.execute(request)
      return jsonResult({ ok: true, method: methodName, result })
    }

    const result = await session.invoke(request)
    return jsonResult({ ok: true, method: methodName, result })
  } catch (err) {
    return errorResult(err, {
      method: methodName,
      signature: formatSignature(known),
    })
  }
}
