#!/usr/bin/env node
/**
 * MCP server exposing the Telegram TDLib API for testing bot flows as a user.
 *
 * Design: a thin passthrough. `tg_invoke` can call any of TDLib's ~1010
 * methods with their exact documented parameters; `tg_schema` makes those
 * methods discoverable. Only genuinely awkward flows (auth, button presses,
 * awaiting a bot reply) get dedicated helpers.
 *
 * This entry point serves the stdio transport (one process per client).
 * For a shared, network-reachable instance see `src/http.ts` (`npm run http`).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { getCatalog } from './catalog.js'
import {
  SERVER_NAME,
  buildServer,
  installShutdownHandlers,
  startVersionCheck,
} from './server.js'

async function main() {
  // All diagnostics go to stderr; stdout is the MCP transport.
  const catalog = getCatalog()
  console.error(
    `[${SERVER_NAME}] catalog: TDLib ${catalog.tdlibVersion} ` +
      `(${catalog.methods.length} methods, ${catalog.types.length} types)`,
  )

  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[${SERVER_NAME}] ready on stdio`)

  startVersionCheck()
  installShutdownHandlers()
}

main().catch(err => {
  console.error(`[${SERVER_NAME}] fatal:`, err)
  process.exit(1)
})
