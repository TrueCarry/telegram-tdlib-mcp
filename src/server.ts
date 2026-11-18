/**
 * Shared MCP server definition.
 *
 * Both transports (stdio in index.ts, Streamable HTTP in http.ts) build the
 * same tool set from here so the two can never drift apart.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { getSession } from './tdlib.js'
import { invokeInputSchema, invokeToolDescription, handleInvoke } from './tools/invoke.js'
import { schemaInputSchema, schemaToolDescription, handleSchema } from './tools/schema.js'
import { updatesInputSchema, updatesToolDescription, handleUpdates } from './tools/updates.js'
import { loginInputSchema, loginToolDescription, handleLogin } from './tools/login.js'
import { clickInputSchema, clickToolDescription, handleClick } from './tools/click.js'
import { waitForInputSchema, waitForToolDescription, handleWaitFor } from './tools/waitfor.js'

export const SERVER_NAME = 'telegram-tdlib-mcp'
export const SERVER_VERSION = '0.1.0'

export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerTool(
    'tg_schema',
    {
      title: 'Discover the TDLib API',
      description: schemaToolDescription,
      inputSchema: schemaInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async args => handleSchema(args),
  )

  server.registerTool(
    'tg_invoke',
    {
      title: 'Call any TDLib method',
      description: invokeToolDescription,
      inputSchema: invokeInputSchema,
      annotations: { openWorldHint: true },
    },
    async args => handleInvoke(args),
  )

  server.registerTool(
    'tg_updates',
    {
      title: 'Poll Telegram updates',
      description: updatesToolDescription,
      inputSchema: updatesInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async args => handleUpdates(args),
  )

  server.registerTool(
    'tg_login',
    {
      title: 'Authorize the Telegram account',
      description: loginToolDescription,
      inputSchema: loginInputSchema,
      annotations: { openWorldHint: true },
    },
    async args => handleLogin(args),
  )

  server.registerTool(
    'tg_click_button',
    {
      title: 'Press a message button',
      description: clickToolDescription,
      inputSchema: clickInputSchema,
      annotations: { openWorldHint: true },
    },
    async args => handleClick(args),
  )

  server.registerTool(
    'tg_wait_for',
    {
      title: "Wait for a bot's response",
      description: waitForToolDescription,
      inputSchema: waitForInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async args => handleWaitFor(args),
  )

  return server
}

/**
 * Verifies the running TDLib binary matches the generated catalog.
 *
 * Runs in the background so startup is not blocked by TDLib initialization,
 * and tolerates missing credentials so tg_schema stays usable.
 */
export function startVersionCheck(): void {
  const session = getSession()
  void (async () => {
    try {
      const check = await session.checkVersion()
      if (!check.matches) {
        console.error(
          `[${SERVER_NAME}] WARNING: TDLib binary is ${check.binaryVersion} but the API catalog ` +
            `was generated from ${check.catalogVersion}. Method signatures may differ. ` +
            `Run \`npm run gen:schema\` to regenerate.`,
        )
      } else {
        console.error(`[${SERVER_NAME}] TDLib ${check.binaryVersion} matches catalog`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        `[${SERVER_NAME}] Telegram client not started: ${message}\n` +
          `[${SERVER_NAME}] tg_schema still works; set credentials to use the other tools.`,
      )
    }
  })()
}

/** Installs SIGINT/SIGTERM handlers that close TDLib cleanly. */
export function installShutdownHandlers(before?: () => Promise<void> | void): void {
  const session = getSession()
  let shuttingDown = false

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[${SERVER_NAME}] received ${signal}, closing TDLib...`)
    try {
      if (before) await before()
    } catch (err) {
      console.error(`[${SERVER_NAME}] shutdown hook failed:`, err)
    }
    try {
      await session.close()
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
