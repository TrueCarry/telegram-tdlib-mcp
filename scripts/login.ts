/**
 * Interactive login. Prompts for your phone number, the code Telegram sends,
 * and your 2FA password if the account has one.
 *
 * Nothing is logged or persisted by this script; credentials go straight to
 * TDLib, which stores its session in TDLIB_DB_DIR. Run it once - the session
 * is reused afterwards.
 *
 * Run: npm run login
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { isAbsolute, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

const rl = createInterface({ input: stdin, output: stdout })

/** Absolute path of the TDLib database this invocation will use. */
function targetDatabaseDir(): string {
  const raw = process.env.TDLIB_DB_DIR ?? './tdlib-data'
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

/**
 * Finds running instances of this server that hold the lock on the database we
 * are about to use.
 *
 * The comparison is on the resolved TDLIB_DB_DIR rather than the working
 * directory: a primary and a secondary run from the same folder but different
 * databases, so matching on cwd would both block legitimate logins and miss
 * genuine conflicts. Both entry points are considered, since either the stdio
 * server or the HTTP server can own the lock.
 */
async function findConflictingServers(): Promise<string[]> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { readlink, readFile } = await import('node:fs/promises')
  const run = promisify(execFile)

  const wantedDb = targetDatabaseDir()

  let listing: string
  try {
    // Matches both src/index.ts and src/http.ts, plus their compiled forms.
    const { stdout: out } = await run('pgrep', ['-af', 'index\\.ts|http\\.ts|index\\.js|http\\.js'])
    listing = out
  } catch {
    return [] // pgrep exits non-zero when nothing matches
  }

  const matches: string[] = []
  for (const line of listing.split('\n')) {
    if (!line.trim() || line.includes('pgrep')) continue

    const pid = Number.parseInt(line.split(/\s+/)[0] ?? '', 10)
    if (!Number.isFinite(pid) || pid === process.pid || pid === process.ppid) continue

    // Must actually be one of this server's entry points.
    if (!/\bsrc\/(index|http)\.ts\b|\bdist\/(index|http)\.js\b/.test(line)) continue

    let cwd: string
    try {
      cwd = await readlink(`/proc/${pid}/cwd`)
    } catch {
      continue // exited, or not permitted to inspect
    }

    // Resolve that process's own TDLIB_DB_DIR from its environment, falling
    // back to the same default this script uses.
    let theirDb: string | undefined
    try {
      const env = await readFile(`/proc/${pid}/environ`, 'utf8')
      const entry = env.split('\0').find(e => e.startsWith('TDLIB_DB_DIR='))
      const raw = entry?.slice('TDLIB_DB_DIR='.length)
      if (raw) theirDb = isAbsolute(raw) ? raw : resolve(cwd, raw)
    } catch {
      // Environment unreadable; fall through to the cwd-based default.
    }
    theirDb ??= resolve(cwd, './tdlib-data')

    if (theirDb !== wantedDb) continue // different database - no conflict

    matches.push(line.trim())
  }
  return matches
}

/** Reads a line without echoing it, for secrets like the 2FA password. */
async function askHidden(prompt: string): Promise<string> {
  stdout.write(prompt)
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)

  return await new Promise<string>(resolve => {
    let value = ''
    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf8')
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.off('data', onData)
          stdout.write('\n')
          resolve(value)
          break
        case '\u0003': // Ctrl-C
          stdin.setRawMode?.(wasRaw ?? false)
          stdout.write('\n')
          process.exit(130)
          break
        case '\u007f': // Backspace
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1)
            stdout.write('\b \b')
          }
          break
        default:
          value += char
          stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  if (!stdin.isTTY) {
    console.error(
      'This script is interactive and needs a terminal.\n' +
        'Run it directly in your shell:  npm run login',
    )
    process.exit(1)
  }

  const databaseDir = targetDatabaseDir()
  console.error(`Logging in to the account stored in: ${databaseDir}\n`)

  // TDLib allows only one process per database directory. Catch a competing
  // instance now, before asking for a phone number and a time-limited code.
  const running = await findConflictingServers()
  if (running.length > 0) {
    console.error(`Another server is already using ${databaseDir}:\n`)
    for (const line of running) console.error(`  ${line}`)
    console.error(
      '\nIt holds the database lock, so login would stall. Stop it first ' +
        '(for example: kill ' +
        running.map(l => l.split(/\s+/)[0]).join(' ') +
        '), then run the login again.',
    )
    process.exit(1)
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    // Inherit so the server's diagnostics (including TDLib errors such as a
    // locked database) are visible instead of being silently swallowed.
    stderr: 'inherit',
  })

  const client = new Client({ name: 'login', version: '1.0.0' })
  await client.connect(transport)

  const login = async (args: Record<string, unknown>) =>
    parse(await client.callTool({ name: 'tg_login', arguments: args }))

  let state = await login({ action: 'status' })
  let waitRounds = 0

  // Drive the state machine until authorized or stuck.
  for (let step = 0; step < 16; step++) {
    if (state.error) {
      console.error(`\nTelegram rejected that: ${state.error.message}`)
      const current = state.current_state ?? (await login({ action: 'status' }))
      state = current
      // Fall through and retry whatever the current state asks for.
    }

    if (state.authorized) break

    switch (state.next_action) {
      case 'phone': {
        const phone = (await rl.question('\nPhone number (international, e.g. +15551234567): ')).trim()
        state = await login({ action: 'phone', phone_number: phone })
        break
      }
      case 'code': {
        console.log('\nTelegram has sent a login code (check the Telegram app, or SMS).')
        const code = (await rl.question('Login code: ')).trim()
        state = await login({ action: 'code', code })
        break
      }
      case 'password': {
        if (state.password_hint) console.log(`\nPassword hint: ${state.password_hint}`)
        const password = await askHidden('2FA password (hidden): ')
        state = await login({ action: 'password', password })
        break
      }
      case 'email': {
        const email = (await rl.question('\nEmail address: ')).trim()
        state = await login({ action: 'email', email_address: email })
        break
      }
      case 'email_code': {
        const code = (await rl.question('\nCode sent to your email: ')).trim()
        state = await login({ action: 'email_code', code })
        break
      }
      case 'register': {
        console.log('\nThis number has no Telegram account yet.')
        const first = (await rl.question('First name: ')).trim()
        const last = (await rl.question('Last name (optional): ')).trim()
        state = await login({ action: 'register', first_name: first, last_name: last })
        break
      }
      case 'wait': {
        waitRounds++
        // Initialization is normally instant. Repeated waiting means TDLib
        // cannot open its database, almost always because another instance
        // holds the lock.
        if (waitRounds >= 4 && state.authorization_state === 'authorizationStateWaitTdlibParameters') {
          console.error('\nTDLib is stuck initializing.')
          console.error(
            'Another instance of this server is probably running and holding the lock on ' +
              'TDLIB_DB_DIR (TDLib permits only one process per database directory).\n',
          )
          console.error('Check with:  pgrep -af "src/index.ts"')
          console.error('Then stop it and re-run:  npm run login')
          rl.close()
          await client.close()
          process.exit(1)
        }
        await new Promise(r => setTimeout(r, 1500))
        state = await login({ action: 'status' })
        break
      }
      default: {
        console.error(`\nCannot proceed automatically from: ${state.authorization_state}`)
        console.error(state.note ?? '')
        rl.close()
        await client.close()
        process.exit(1)
      }
    }
  }

  rl.close()

  if (state.authorized) {
    const me = parse(await client.callTool({ name: 'tg_invoke', arguments: { method: 'getMe' } }))
    console.log('\nLogged in successfully.')
    if (me.ok) {
      const u = me.result
      console.log(`  ${[u.first_name, u.last_name].filter(Boolean).join(' ')} (id ${u.id})`)
      const username = u.usernames?.editable_username
      if (username) console.log(`  @${username}`)
    }
    console.log('\nThe session is saved; you will not need to log in again.')
    console.log('Next: npm run test:live')
  } else {
    console.error('\nLogin did not complete. Last state:', state.authorization_state)
    process.exitCode = 1
  }

  await client.close()
}

main().catch(err => {
  console.error('login failed:', err)
  process.exit(1)
})
