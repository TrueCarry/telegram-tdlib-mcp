/**
 * End-to-end OAuth flow against a running HTTP server, as an MCP client such
 * as Claude would perform it: discovery -> dynamic registration -> consent
 * (wrong code, then right code) -> PKCE token exchange -> MCP call -> refresh
 * -> revoke.
 *
 * Usage: OAUTH_BASE=http://localhost:8795 OAUTH_CODE=... npx tsx scripts/test-oauth.ts
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.env.OAUTH_BASE ?? 'http://localhost:8795').replace(/\/$/, '')
const CODE = process.env.OAUTH_CODE ?? ''
const REDIRECT = 'http://localhost:33418/callback'

let passed = 0
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.log(`  FAIL ${name}`)
    console.error(err)
    process.exit(1)
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
const b64url = (b: Buffer) => b.toString('base64url')

async function main() {
  let resourceMetadataUrl = ''
  let asMeta: any
  let client: any
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  let requestId = ''
  let authCode = ''
  let tokens: any

  await step('unauthenticated /mcp returns 401 with resource_metadata hint', async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(r.status, 401)
    const www = r.headers.get('www-authenticate') ?? ''
    const m = /resource_metadata="([^"]+)"/.exec(www)
    assert.ok(m, `WWW-Authenticate lacks resource_metadata: ${www}`)
    resourceMetadataUrl = m[1]!
  })

  await step('protected resource metadata points at the authorization server', async () => {
    const r = await fetch(resourceMetadataUrl)
    assert.equal(r.status, 200)
    const meta = await r.json()
    assert.equal(meta.resource, `${BASE}/mcp`)
    assert.ok(meta.authorization_servers?.length, 'no authorization_servers')
  })

  await step('authorization server metadata advertises PKCE + registration', async () => {
    const r = await fetch(`${BASE}/.well-known/oauth-authorization-server`)
    assert.equal(r.status, 200)
    asMeta = await r.json()
    assert.deepEqual(asMeta.code_challenge_methods_supported, ['S256'])
    assert.ok(asMeta.registration_endpoint)
    assert.ok(asMeta.token_endpoint)
  })

  await step('dynamic client registration', async () => {
    const r = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'oauth-e2e-test',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
    assert.equal(r.status, 201)
    client = await r.json()
    assert.ok(client.client_id)
  })

  await step('/authorize renders the consent page', async () => {
    const url = new URL(asMeta.authorization_endpoint)
    url.search = form({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${BASE}/mcp`,
    })
    const r = await fetch(url, { redirect: 'manual' })
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.match(html, /Access code/)
    assert.match(html, /oauth-e2e-test/, 'client name should be shown')
    // Browsers apply form-action to the redirect after the POST too, so the
    // client's callback origin must be allowed or approval is blocked.
    const csp = r.headers.get('content-security-policy') ?? ''
    const formAction = /form-action ([^;]+)/.exec(csp)?.[1]?.split(/\s+/) ?? []
    assert.ok(formAction.includes("'self'"), `form-action should allow 'self': ${csp}`)
    assert.ok(
      formAction.includes(new URL(REDIRECT).origin),
      `form-action should allow the redirect origin: ${csp}`,
    )
    const m = /name="request_id" value="([^"]+)"/.exec(html)
    assert.ok(m, 'no request_id in form')
    requestId = m[1]!
  })

  await step('wrong access code is rejected and no code is issued', async () => {
    const r = await fetch(`${BASE}/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ request_id: requestId, access_code: 'definitely-wrong-code', action: 'approve' }),
    })
    assert.equal(r.status, 401)
    assert.equal(r.headers.get('location'), null)
    assert.match(await r.text(), /Incorrect access code/)
  })

  await step('correct access code redirects back with code and state', async () => {
    const r = await fetch(`${BASE}/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ request_id: requestId, access_code: CODE, action: 'approve' }),
    })
    assert.equal(r.status, 302)
    const loc = new URL(r.headers.get('location')!)
    assert.equal(`${loc.origin}${loc.pathname}`, REDIRECT)
    assert.equal(loc.searchParams.get('state'), 'xyz')
    authCode = loc.searchParams.get('code') ?? ''
    assert.ok(authCode)
  })

  await step('consent request cannot be replayed', async () => {
    const r = await fetch(`${BASE}/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ request_id: requestId, access_code: CODE, action: 'approve' }),
    })
    assert.equal(r.status, 400)
  })

  await step('token exchange rejects a wrong PKCE verifier', async () => {
    const r = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: b64url(randomBytes(32)),
        client_id: client.client_id,
        redirect_uri: REDIRECT,
      }),
    })
    assert.equal(r.status, 400)
  })

  await step('token exchange with the right verifier issues tokens', async () => {
    const r = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        resource: `${BASE}/mcp`,
      }),
    })
    assert.equal(r.status, 200, await r.clone().text())
    tokens = await r.json()
    assert.ok(tokens.access_token)
    assert.ok(tokens.refresh_token)
    assert.equal(tokens.token_type, 'Bearer')
  })

  await step('authorization code is single-use', async () => {
    const r = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: authCode,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
      }),
    })
    assert.equal(r.status, 400)
  })

  const mcpInit = (token: string) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'oauth-e2e-test', version: '1.0' },
        },
      }),
    })

  await step('OAuth access token opens an MCP session and lists tools', async () => {
    const init = await mcpInit(tokens.access_token)
    assert.equal(init.status, 200, await init.clone().text())
    const sid = init.headers.get('mcp-session-id')
    assert.ok(sid)
    const list = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const out = await list.json()
    const names = out.result.tools.map((t: any) => t.name)
    assert.ok(names.includes('tg_invoke'), `tools: ${names}`)
  })

  await step('refresh token rotates and old refresh token stops working', async () => {
    const r = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    })
    assert.equal(r.status, 200)
    const fresh = await r.json()
    assert.notEqual(fresh.refresh_token, tokens.refresh_token)
    const replay = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    })
    assert.equal(replay.status, 400)
    tokens = fresh
  })

  await step('revoked access token is rejected', async () => {
    const r = await fetch(`${BASE}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ token: tokens.access_token, client_id: client.client_id }),
    })
    assert.equal(r.status, 200)
    const after = await mcpInit(tokens.access_token)
    assert.equal(after.status, 401)
  })

  await step('a made-up bearer token is rejected', async () => {
    const r = await mcpInit('not-a-real-token')
    assert.equal(r.status, 401)
  })

  console.log(`\n${passed} passed`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
