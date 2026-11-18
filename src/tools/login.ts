import { z } from 'zod'

import { getSession } from '../tdlib.js'
import { jsonResult, errorResult, type ToolResult } from './common.js'

export const loginInputSchema = {
  action: z
    .enum(['status', 'phone', 'code', 'password', 'email', 'email_code', 'register', 'logout'])
    .describe(
      'status: report the current authorization state (start here). ' +
        'phone: submit a phone number. code: submit the login code. ' +
        'password: submit the 2FA password. email: submit an email address. ' +
        'email_code: submit the emailed code. register: create a new account. logout: sign out.',
    ),
  phone_number: z.string().optional().describe('For action=phone. International format, e.g. +15551234567.'),
  code: z.string().optional().describe('For action=code or action=email_code.'),
  password: z.string().optional().describe('For action=password. The 2FA (cloud) password.'),
  email_address: z.string().optional().describe('For action=email.'),
  first_name: z.string().optional().describe('For action=register.'),
  last_name: z.string().optional().describe('For action=register.'),
}

const LoginArgs = z.object(loginInputSchema)

export const loginToolDescription =
  'Authorize the Telegram user account. Auth is a multi-step state machine: call with ' +
  'action="status" to see what is required, then submit each credential as a separate call ' +
  '(phone -> code -> password if 2FA is enabled). The session is persisted in the TDLib database ' +
  'directory, so this is normally only needed once.'

/** Human-readable guidance for each authorization state. */
const STATE_GUIDANCE: Record<string, { next: string; note: string }> = {
  authorizationStateWaitTdlibParameters: {
    next: 'wait',
    note:
      'TDLib is still initializing. This normally lasts under a second. If it persists, another ' +
      'process is probably holding the TDLib database lock - see `stuck_hint`.',
  },
  authorizationStateWaitPhoneNumber: {
    next: 'phone',
    note: 'Call tg_login with action="phone" and phone_number in international format.',
  },
  authorizationStateWaitEmailAddress: {
    next: 'email',
    note: 'Call tg_login with action="email" and email_address.',
  },
  authorizationStateWaitEmailCode: {
    next: 'email_code',
    note: 'Call tg_login with action="email_code" and the code sent to your email.',
  },
  authorizationStateWaitCode: {
    next: 'code',
    note: 'Call tg_login with action="code" and the login code sent via Telegram or SMS.',
  },
  authorizationStateWaitOtherDeviceConfirmation: {
    next: 'confirm_on_device',
    note: 'Open the returned link on another logged-in device to confirm, then check status again.',
  },
  authorizationStateWaitRegistration: {
    next: 'register',
    note: 'This phone number has no account. Call tg_login with action="register", first_name and last_name.',
  },
  authorizationStateWaitPassword: {
    next: 'password',
    note: 'Two-factor authentication is enabled. Call tg_login with action="password".',
  },
  authorizationStateWaitPremiumPurchase: {
    next: 'unsupported',
    note: 'Telegram requires a Premium subscription to sign in with this number.',
  },
  authorizationStateReady: {
    next: 'none',
    note: 'Authorized. You can now use tg_invoke freely.',
  },
  authorizationStateLoggingOut: { next: 'wait', note: 'Logging out.' },
  authorizationStateClosing: { next: 'wait', note: 'The client is closing.' },
  authorizationStateClosed: {
    next: 'restart',
    note: 'The client is closed and cannot be reused. Restart the MCP server.',
  },
}

async function currentState(): Promise<Record<string, unknown>> {
  const session = getSession()
  const state = (await session.invoke({ _: 'getAuthorizationState' })) as Record<string, unknown>
  return state
}

function describeState(state: Record<string, unknown>): Record<string, unknown> {
  const name = typeof state._ === 'string' ? state._ : 'unknown'
  const guidance = STATE_GUIDANCE[name]
  const out: Record<string, unknown> = {
    ok: true,
    authorization_state: name,
    authorized: name === 'authorizationStateReady',
    next_action: guidance?.next ?? 'unknown',
    note: guidance?.note ?? 'Unrecognized state; inspect `details`.',
    details: state,
  }

  // Being stuck here almost always means the TDLib database is locked by
  // another running instance, which TDLib reports only on stderr.
  if (name === 'authorizationStateWaitTdlibParameters') {
    out.stuck_hint =
      'If this state persists for more than a few seconds, another instance of this server is ' +
      'likely already running and holding the lock on TDLIB_DB_DIR. TDLib allows only one ' +
      'process per database directory. Stop the other process (pgrep -af "src/index.ts") or ' +
      'point TDLIB_DB_DIR at a different directory.'
  }

  // Surface the fields an agent needs to act on without digging.
  if (name === 'authorizationStateWaitPassword') {
    out.password_hint = state.password_hint ?? ''
    out.has_recovery_email_address = state.has_recovery_email_address ?? false
  }
  if (name === 'authorizationStateWaitOtherDeviceConfirmation') {
    out.link = state.link
  }
  return out
}

function requireArg(value: string | undefined, name: string, action: string): string {
  if (!value) {
    throw new Error(`\`${name}\` is required for action="${action}".`)
  }
  return value
}

export async function handleLogin(rawArgs: unknown): Promise<ToolResult> {
  const args = LoginArgs.parse(rawArgs)
  const session = getSession()

  try {
    await session.start()

    switch (args.action) {
      case 'status':
        return jsonResult(describeState(await currentState()))

      case 'phone': {
        const phone = requireArg(args.phone_number, 'phone_number', 'phone')
        await session.invoke({
          _: 'setAuthenticationPhoneNumber',
          phone_number: phone,
        })
        return jsonResult({
          ...describeState(await currentState()),
          submitted: 'phone_number',
        })
      }

      case 'code': {
        const code = requireArg(args.code, 'code', 'code')
        await session.invoke({ _: 'checkAuthenticationCode', code })
        return jsonResult({ ...describeState(await currentState()), submitted: 'code' })
      }

      case 'password': {
        const password = requireArg(args.password, 'password', 'password')
        await session.invoke({ _: 'checkAuthenticationPassword', password })
        return jsonResult({ ...describeState(await currentState()), submitted: 'password' })
      }

      case 'email': {
        const email = requireArg(args.email_address, 'email_address', 'email')
        await session.invoke({
          _: 'setAuthenticationEmailAddress',
          email_address: email,
        })
        return jsonResult({
          ...describeState(await currentState()),
          submitted: 'email_address',
        })
      }

      case 'email_code': {
        const code = requireArg(args.code, 'code', 'email_code')
        await session.invoke({
          _: 'checkAuthenticationEmailCode',
          code: { _: 'emailAddressAuthenticationCode', code },
        })
        return jsonResult({ ...describeState(await currentState()), submitted: 'email_code' })
      }

      case 'register': {
        const firstName = requireArg(args.first_name, 'first_name', 'register')
        await session.invoke({
          _: 'registerUser',
          first_name: firstName,
          last_name: args.last_name ?? '',
          disable_notification: false,
        })
        return jsonResult({ ...describeState(await currentState()), submitted: 'registration' })
      }

      case 'logout': {
        await session.invoke({ _: 'logOut' })
        return jsonResult({
          ok: true,
          logged_out: true,
          note: 'Logged out. The TDLib client is shutting down; restart the MCP server to log in again.',
        })
      }

      default: {
        const exhaustive: never = args.action
        throw new Error(`Unhandled action: ${String(exhaustive)}`)
      }
    }
  } catch (err) {
    // Include the current state so a rejected credential still tells the agent
    // what to do next (e.g. PHONE_CODE_INVALID leaves you in WaitCode).
    let state: Record<string, unknown> | undefined
    try {
      state = describeState(await currentState())
    } catch {
      // ignore - the original error is what matters
    }
    return errorResult(err, state ? { current_state: state } : undefined)
  }
}
