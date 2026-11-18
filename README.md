# telegram-tdlib-mcp

An MCP server for driving a **Telegram user account** programmatically — open bots, send them messages, press their buttons, read replies, and receive updates.

It is deliberately a **thin passthrough** over [TDLib](https://core.telegram.org/tdlib): all 1000+ TDLib methods are callable directly with their exact documented parameters, rather than a small curated set of wrappers. Helpers exist only for the few flows that are genuinely awkward as raw calls.

## Why TDLib + Node

- **No build step.** TDLib normally requires compiling a large C++ project. [`prebuilt-tdlib`](https://www.npmjs.com/package/prebuilt-tdlib) ships precompiled binaries per platform, so `npm install` is all you need.
- **Fast-moving upstream.** `prebuilt-tdlib` tracks TDLib releases roughly monthly, so new Telegram features arrive quickly.
- **Verbatim API surface.** [`tdl`](https://github.com/eilvelia/tdl) rewrites only the type discriminator (`@type` ↔ `_`) and leaves every field name in TDLib's own snake_case, so payloads copied from Telegram's documentation work as-is.

## Setup

1. Get an `api_id` and `api_hash` from <https://my.telegram.org/apps> (these identify your *application*, not your account).

2. Install and build:

   ```bash
   npm install
   npm run gen:schema   # downloads td_api.tl and builds the method catalog
   npm run build
   ```

3. Configure the server in your MCP client:

   ```json
   {
     "mcpServers": {
       "telegram": {
         "command": "node",
         "args": ["/absolute/path/to/telegram-tdlib-mcp/dist/index.js"],
         "env": {
           "TDLIB_API_ID": "123456",
           "TDLIB_API_HASH": "your_api_hash",
           "TDLIB_DB_DIR": "/absolute/path/to/tdlib-data"
         }
       }
     }
   }
   ```

4. Log in once, via the `tg_login` tool:

   ```
   tg_login {"action": "status"}                                → authorizationStateWaitPhoneNumber
   tg_login {"action": "phone", "phone_number": "+15551234567"} → authorizationStateWaitCode
   tg_login {"action": "code", "code": "12345"}                 → authorizationStateReady
   ```

   If the account has 2FA enabled you will land in `authorizationStateWaitPassword`; submit it with `{"action": "password", "password": "..."}`. The session persists in `TDLIB_DB_DIR`, so this is normally a one-time step.

> **Security:** after login, `TDLIB_DB_DIR` contains your account's authorization keys — anyone with that directory can act as your account. It is git-ignored by default. Prefer a dedicated test account.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TDLIB_API_ID` | yes | — | Application id from my.telegram.org |
| `TDLIB_API_HASH` | yes | — | Application hash from my.telegram.org |
| `TDLIB_DB_DIR` | no | `./tdlib-data` | Session database and downloaded files |
| `TG_UPDATE_BUFFER_SIZE` | no | `1000` | Updates retained in memory |
| `TDLIB_USE_TEST_DC` | no | `0` | Use Telegram's test datacenters |

HTTP transport only (see [Remote access over HTTP](#remote-access-over-http)):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TG_HTTP_TOKEN` | yes* | — | Static bearer token, accepted on every request |
| `TG_PUBLIC_URL` | for OAuth | — | Public https base URL, advertised in OAuth metadata |
| `TG_OAUTH_ACCESS_CODE` | yes* | — | Enables OAuth; users enter it to approve a client |
| `TG_OAUTH_ACCESS_TOKEN_TTL` | no | `3600` | OAuth access token lifetime (s) |
| `TG_OAUTH_REFRESH_TOKEN_TTL` | no | `2592000` | OAuth refresh token lifetime (s) |
| `TG_HTTP_HOST` | no | `127.0.0.1` | Interface to bind |
| `TG_HTTP_PORT` | no | `8787` | Port to listen on |
| `TG_HTTP_PATH` | no | `/mcp` | Endpoint path |
| `TG_HTTP_ALLOW_NO_AUTH` | no | `0` | Disable the token (loopback only) |
| `TG_HTTP_ALLOWED_HOSTS` | no | loopback names | `Host` allowlist for DNS-rebinding protection |
| `TG_HTTP_SSE` | no | `0` | Prefer SSE streaming over plain JSON replies |
| `TG_HTTP_MAX_BODY_BYTES` | no | `4194304` | Request body size cap |
| `TG_HTTP_SESSION_IDLE_MS` | no | `1800000` | Close a session after 30m idle (`0` disables) |
| `TG_HTTP_SESSION_MAX_MS` | no | `43200000` | Close a session 12h after opening (`0` disables) |
| `TG_HTTP_MAX_SESSIONS` | no | `100` | Concurrent session cap (`0` disables) |
| `TG_HTTP_SWEEP_INTERVAL_MS` | no | `60000` | How often expiry is checked |

\* at least one of `TG_HTTP_TOKEN` or `TG_OAUTH_ACCESS_CODE` (with `TG_PUBLIC_URL`), unless `TG_HTTP_ALLOW_NO_AUTH=1`.

## Remote access over HTTP

By default this is a **stdio** server: the MCP client spawns it as a child process and talks over stdin/stdout. If another program — a bot, a CI job, a service on your machine — needs to reach it, run the Streamable HTTP transport instead:

```bash
./start-primary.sh     # generates and persists a token, then starts on :8787
```

The script mints a `TG_HTTP_TOKEN` into `.env` on first run and reuses it afterwards, so clients do not need reconfiguring after a restart. It refuses to start if the port is taken. Pass `--build` to run the compiled output instead of `tsx`.

To start a second, independent server (its own port, own database, own token):

```bash
./start-secondary.sh   # :8789, ./tdlib-data-2, token in .env.secondary
```

Or drive it manually:

```bash
export TG_HTTP_TOKEN=$(openssl rand -hex 32)
npm run http           # or: npm run build && npm run start:http
```

```
[telegram-tdlib-mcp] listening on http://127.0.0.1:8787/mcp
[telegram-tdlib-mcp] auth: bearer token required
```

Point an MCP client at it:

```json
{
  "mcpServers": {
    "telegram": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <TG_HTTP_TOKEN>" }
    }
  }
}
```

Or drive it with plain HTTP. Send `initialize`, keep the returned `mcp-session-id`, and pass it on every later request:

```bash
curl -sD- -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TG_HTTP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"my-bot","version":"1.0"}}}'

curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $TG_HTTP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"tg_invoke","arguments":{"method":"getMe","params":{}}}}'
```

`GET /health` needs no token and reports liveness, session count and the configured limits.

### Session lifetime

MCP clients are not required to send `DELETE /mcp`, and most simply disconnect. Each session holds an `McpServer` and its transport, so without expiry they accumulate for the life of the process — a long-lived server slowly collects hundreds of dead sessions.

Sessions are therefore reaped automatically:

- **Idle timeout** (`TG_HTTP_SESSION_IDLE_MS`, default 30m) — no requests for this long. Comfortably longer than the maximum `tg_updates` long-poll (50s), and every request refreshes it, including one still in flight.
- **Max lifetime** (`TG_HTTP_SESSION_MAX_MS`, default 12h) — closed regardless of activity.
- **Concurrency cap** (`TG_HTTP_MAX_SESSIONS`, default 100) — further `initialize` calls get `503`. Expired sessions are reclaimed *before* the cap is applied, so abandoned sessions cannot lock out a live client.

A request against an expired id returns `404` telling the client to re-initialize. Set any limit to `0` to disable it. Well-behaved clients should still send `DELETE /mcp` when finished; expiry is the safety net, not the primary mechanism.

### One process, one account

TDLib takes an **exclusive lock** on `td.binlog`, so only one process can use a given `TDLIB_DB_DIR` at a time. The HTTP server is therefore a single long-running process, and every HTTP session multiplexes onto the same authorized account. Consequences worth knowing:

- You cannot run the HTTP server and a stdio instance against the same `TDLIB_DB_DIR`. The second one fails with `can't lock file`. Use a separate directory (and a separate account) if you need two — see [Running more than one instance](#running-more-than-one-instance).
- Clients share one update stream. Two callers polling `tg_updates` with independent cursors each see every update, but a message consumed by one is not hidden from the other.
- There is no per-client isolation or rate limiting. Concurrent `tg_invoke` calls hit Telegram as fast as they arrive, which can trigger flood waits.

### Public deployment with OAuth (Coolify / Docker)

See **[Deploying on Coolify](#deploying-on-coolify)** for the full runbook. In short: run the Docker image with `TG_PUBLIC_URL` and `TG_OAUTH_ACCESS_CODE` set, behind HTTPS, with a persistent volume at `/data`. MCP clients such as Claude discover OAuth on their own, register themselves, and open a consent page. Anyone who enters the access code gets connected.

### Running more than one instance

Two servers can run side by side, but they need **both** a free port and their own TDLib database:

```bash
# instance A - the existing account
TG_HTTP_TOKEN=$TOKEN_A npm run http

# instance B - separate port AND separate database
TG_HTTP_TOKEN=$TOKEN_B TG_HTTP_PORT=8789 TDLIB_DB_DIR=./tdlib-data-2 npm run http
```

The working directory is irrelevant — copying the project to another folder changes nothing on its own, because `TDLIB_DB_DIR` defaults to `./tdlib-data` *relative to where you start it*. What matters is that the two resolved database paths differ.

The catch: **a new `TDLIB_DB_DIR` starts unauthorized.** Instance B reports `authorizationStateWaitPhoneNumber` and needs its own `tg_login`. Usually you want a second Telegram account for it; logging the same account in twice creates two independent sessions, and Telegram may prompt or invalidate one.

Log the second account in from the CLI — **stop the secondary server first**, since TDLib allows one process per database:

```bash
npm run login:secondary     # == TDLIB_DB_DIR=./tdlib-data-2 npm run login
npm run status:secondary    # check without logging in
```

Both print which database they are operating on, and refuse to start if another process already holds that specific database — the primary may keep running throughout, because the check compares resolved database paths rather than working directories. For any other location:

```bash
TDLIB_DB_DIR=/path/to/other-db npm run login
```

Do not copy `tdlib-data/` to clone a login. The directory holds live session keys tied to one connection; two processes using copies of the same session tend to invalidate each other server-side.

If a second instance does end up on a locked database, TDLib refuses it. The port still binds, so the server *looks* healthy — but calls fail immediately with a `409` naming the directory, instead of hanging:

```
TDLib database at /path/tdlib-data is locked by another process. Only one instance
may use a database at a time. Stop the other server, or start this one with a
different TDLIB_DB_DIR (a fresh directory starts unauthorized and needs its own login).
```

### Security

The token is the *only* thing between a caller and full control of the account — it can read every chat, send messages, and spend money in bots. The defaults are closed:

- Binds to `127.0.0.1`; nothing is exposed off-box until you change that.
- Refuses to start without `TG_HTTP_TOKEN` unless you explicitly set `TG_HTTP_ALLOW_NO_AUTH=1`.
- Refuses to start with auth disabled *and* a non-loopback bind, which would be an open account takeover.
- Compares tokens in constant time and validates `Host` against an allowlist to blunt DNS rebinding.

There is no TLS here. To reach it from another machine, put it behind a reverse proxy that terminates HTTPS rather than binding `0.0.0.0` directly.

## Deploying on Coolify

This runbook takes a fresh [Coolify](https://coolify.io) v4 instance to a public MCP endpoint that Claude can connect to over OAuth. It is written so another agent can follow it step by step. Every step can be done in the UI or through the Coolify API ([API runbook](#coolify-api-runbook)).

### What gets deployed

| Item | Value |
|---|---|
| Image | Built from `Dockerfile` (Debian `node:22-bookworm-slim`, prebuilt glibc TDLib, runs as uid 1000 `node`) |
| Process | `node dist/http.js`: Streamable HTTP MCP with an OAuth 2.1 server |
| Container port | `8787` (binds `0.0.0.0` inside the container) |
| MCP endpoint | `https://<domain>/mcp` |
| Health | `GET /health` → `200 {"status":"ok",...}`, no auth. The Dockerfile `HEALTHCHECK` already uses it |
| State | `/data/tdlib`: Telegram session. **Must be a persistent volume** |
| Build needs network | Yes. `npm run gen:schema` downloads `td_api.tl` from GitHub during the build |

### Prerequisites

1. **Telegram app credentials.** Get `api_id` and `api_hash` from <https://my.telegram.org/apps>. They identify the application, not the account, so the ones used locally can be reused.
2. **A Telegram account to log in as.** Prefer a dedicated test account. You will need its phone number, the ability to receive its login code, and its 2FA password if it has one.
3. **A domain** with a DNS `A` record pointing at the Coolify server, e.g. `tg.example.com`. Coolify's proxy (Traefik by default) issues the Let's Encrypt certificate. OAuth requires HTTPS.
4. **Repository access.** `TrueCarry/telegram-tdlib-mcp` is **private**, so Coolify needs one of:
   - **GitHub App** (recommended): Coolify → Sources → add a GitHub App with access to the repo. Enables push-to-deploy.
   - **Deploy key**: Coolify → Keys & Tokens → Private Keys → generate a key. Add its public half under GitHub → repo → Settings → Deploy keys (read-only). Use the SSH URL `git@github.com:TrueCarry/telegram-tdlib-mcp.git`.
5. **An access code.** This is the shared secret people type on the consent page. It must be at least 12 characters. Generate one without shell-special characters:

   ```bash
   openssl rand -hex 16
   ```

### Option A: Dockerfile build pack (recommended)

1. **Create the application.** Project → environment → **+ New** → **Private Repository (with GitHub App)** or **(with Deploy Key)**. Select the repo, branch `master`, build pack **Dockerfile**. Base directory `/`, Dockerfile location `/Dockerfile`.
2. **Network.** Set *Ports Exposes* to `8787`. Set *Domains* to `https://tg.example.com` (no port suffix: with the Dockerfile build pack, Coolify routes the domain to the first exposed port). Leave *Ports Mappings* empty. A host port mapping bypasses the proxy, and it also stops Coolify from doing rolling updates.
3. **Persistent storage.** *Persistent Storage* → **+ Add** → **Volume Mount**. Name `tdlib-data`, destination path **`/data`**.
   - Use a *Volume* mount, not a *Directory* (bind) mount. A new Docker volume inherits the image's `node:node` ownership of `/data`. A host directory is owned by root, so TDLib cannot write to it unless you `chown -R 1000:1000` it on the host first.
   - Without this mount, every redeploy wipes the session and logs the account out.
4. **Disable rolling updates.** *Advanced* → enable **Consistent Container Name** (`is_consistent_container_name_enabled`). See [Why rolling updates must be off](#why-rolling-updates-must-be-off).
5. **Environment variables.** Set these as *runtime* variables. None are needed at build time:

   | Variable | Required | Value |
   |---|---|---|
   | `TDLIB_API_ID` | yes | numeric id from my.telegram.org |
   | `TDLIB_API_HASH` | yes | hash from my.telegram.org |
   | `TG_PUBLIC_URL` | yes | `https://tg.example.com`: scheme + host exactly as clients reach it, no path, no trailing slash |
   | `TG_OAUTH_ACCESS_CODE` | yes | the access code (≥ 12 chars) |
   | `TG_HTTP_TOKEN` | no | static bearer token for bots/scripts, accepted alongside OAuth (`openssl rand -hex 32`) |
   | `TG_OAUTH_ACCESS_TOKEN_TTL` | no | access token lifetime in seconds, default `3600` |
   | `TG_OAUTH_REFRESH_TOKEN_TTL` | no | refresh token lifetime in seconds, default `2592000` (30 days) |

   Leave `TG_HTTP_HOST`, `TG_HTTP_PORT` and `TDLIB_DB_DIR` alone. The image sets them to `0.0.0.0`, `8787` and `/data/tdlib`. Do not set `TG_HTTP_ALLOW_NO_AUTH`.
6. **Health check.** Leave Coolify's own health check disabled. The image's `HEALTHCHECK` (which uses `node`, as the image has no `curl`) is picked up automatically.
7. **Deploy.** Then [verify](#verify-the-deployment).

### Option B: Docker Compose build pack

`docker-compose.yml` already declares the service, the `tdlib-data:/data` volume and the required variables. Coolify marks required variables as missing until they are filled in.

1. **+ New** → private repository → build pack **Docker Compose**, compose file `/docker-compose.yml`.
2. **Environment variables:** fill in `TDLIB_API_ID`, `TDLIB_API_HASH`, `TG_PUBLIC_URL`, `TG_OAUTH_ACCESS_CODE`, and optionally `TG_HTTP_TOKEN`.
3. **Domain:** on the `telegram-mcp` service set **`https://tg.example.com:8787`**. With Compose, the `:8787` suffix tells the proxy which container port to route to. Clients still use plain `https://tg.example.com`, and `TG_PUBLIC_URL` must **not** include the port.
4. **Storage:** nothing to add. The compose volume appears read-only under *Persistent Storage*.
5. Deploy. Compose resources never do rolling updates, so the next step is not needed here.

### Why rolling updates must be off

TDLib takes an exclusive lock on `td.binlog`. During a rolling update Coolify starts the new container before stopping the old one, and both mount the same `/data`. The new container cannot get the lock, so every TDLib call fails with `409 ... locked by another process`. `/health` still returns 200, though, so Coolify considers the new container healthy and stops the old, working one. The broken container then keeps serving until it is restarted.

A consistent container name makes Coolify stop the old container first. The cost is a few seconds of downtime per redeploy, which is fine for this service. If a deploy ever does end up in the locked state, **Restart** the application fixes it.

### Verify the deployment

```bash
D=https://tg.example.com

curl -s $D/health
# {"status":"ok","server":"telegram-tdlib-mcp","transport":"streamable-http","oauth":true,...}

curl -s $D/.well-known/oauth-protected-resource/mcp
# {"resource":"https://tg.example.com/mcp","authorization_servers":["https://tg.example.com/"],...}

curl -s $D/.well-known/oauth-authorization-server | head -c 200
# "issuer":"https://tg.example.com/" ... - every URL must start with $D

curl -si -X POST $D/mcp | grep -i www-authenticate
# Bearer error="invalid_token", resource_metadata="https://tg.example.com/.well-known/oauth-protected-resource/mcp"
```

Expected runtime log lines (Coolify → application → *Logs*):

```
[telegram-tdlib-mcp] public:    https://tg.example.com/mcp
[telegram-tdlib-mcp] auth: OAuth (access code) + static bearer token
[telegram-tdlib-mcp] TDLib 1.8.67 matches catalog
```

If `TG_HTTP_TOKEN` is set, a full MCP round trip can be checked without a browser:

```bash
curl -s -X POST $D/mcp \
  -H "Authorization: Bearer $TG_HTTP_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
# -> result.serverInfo.name == "telegram-tdlib-mcp"
```

### Connect Claude

- **Claude (web/desktop):** Settings → Connectors → **Add custom connector** → URL `https://tg.example.com/mcp`. Leave the OAuth client id/secret empty, because the server supports dynamic client registration. Claude opens the consent page; enter the access code and approve.
- **Claude Code:** `claude mcp add --transport http telegram https://tg.example.com/mcp`, then run `/mcp` inside Claude Code to authenticate in the browser.
- **Scripts/bots:** use `Authorization: Bearer <TG_HTTP_TOKEN>` directly, no OAuth.

OAuth state is held in memory, so a redeploy or restart signs every client out. Clients re-run the consent flow on their own, and the access code is needed again.

### Log the Telegram account in (once per volume)

A new `/data` volume starts logged out. The container has no dev tooling (`npm run login` is not available), so log in through the `tg_login` tool from a connected client. Ask Claude to:

```
tg_login {"action": "status"}                                → authorizationStateWaitPhoneNumber
tg_login {"action": "phone", "phone_number": "+15551234567"} → authorizationStateWaitCode
tg_login {"action": "code", "code": "12345"}                 → authorizationStateReady
tg_login {"action": "password", "password": "..."}           ← only if 2FA is enabled
```

Telegram sends the code to the account's other sessions, or by SMS. Give it to Claude in the chat. Do not forward the code through Telegram itself: Telegram invalidates login codes that are sent in a Telegram message. After `authorizationStateReady`, the session lives in the volume and survives restarts and redeploys.

Moving an existing local login into the container is possible but discouraged. Two processes using copies of one session tend to invalidate each other. If you do it, stop the local server first, copy `tdlib-data/` into the volume as `/data/tdlib/`, `chown -R 1000:1000` it, and never start the local copy again.

### Operations

| Task | How |
|---|---|
| Deploy new code | push to `master` (GitHub App with auto-deploy) or click **Redeploy** |
| Revoke all client access | change `TG_OAUTH_ACCESS_CODE` (and `TG_HTTP_TOKEN`), redeploy |
| Log the account out | ask a client to call `tg_invoke {"method":"logOut","params":{}}`, then **Restart** (a closed TDLib client cannot be reused) |
| Start over with a fresh account | stop the app, delete the `tdlib-data` volume, start, log in again |
| Backups | Coolify volume backups work, but **the backup is the account**: anyone holding `td.binlog` can act as it. Store backups only where secrets belong. |
| Run one replica only | never scale beyond 1. Each container needs its own volume and its own account. |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build fails in `gen:schema` | build server cannot reach `raw.githubusercontent.com`; allow outbound HTTPS |
| Container exits: `TG_OAUTH_ACCESS_CODE is too short` / `TG_OAUTH_ACCESS_CODE is set but TG_PUBLIC_URL is not` / `TG_PUBLIC_URL is not a valid URL` | fix the variable, redeploy |
| Container exits: `No authentication configured` | none of `TG_OAUTH_ACCESS_CODE`+`TG_PUBLIC_URL` or `TG_HTTP_TOKEN` is set |
| `No available server` / 502 / 404 from the proxy | container is unhealthy or the port is wrong. Dockerfile: *Ports Exposes* `8787`. Compose: domain must end in `:8787`. Check runtime logs |
| `Invalid Host header: ...` on `/mcp` | request `Host` is not `TG_PUBLIC_URL`'s host. If the app has several domains, list them all in `TG_HTTP_ALLOWED_HOSTS` (comma-separated `host[:port]`) |
| Claude: "couldn't connect" / OAuth fails | metadata URLs do not match the real domain. `TG_PUBLIC_URL` must be exactly `https://<domain>` |
| Consent page says too many attempts | 10 tries per 15 minutes per client IP; wait, or check the code |
| Tool calls return `409 ... locked by another process` | two containers share the volume: **Restart**, then turn rolling updates off |
| `401 Unauthorized` on `getMe` / `authorizationStateWaitPhoneNumber` after a redeploy | `/data` is not persistent (the session was lost). Add the volume, then log in again |
| `EACCES` / TDLib cannot open the database | `/data` is a host bind mount owned by root; switch to a volume mount or `chown -R 1000:1000` the host path |
| `FLOOD_WAIT_X` / `retry_after_seconds` | Telegram rate limit; wait the given time |

### Coolify API runbook

For agents with a Coolify API token (Coolify → *Keys & Tokens* → *API tokens*, permission `write` + `deploy`). All calls are `Authorization: Bearer $COOLIFY_TOKEN` against `$COOLIFY/api/v1`. Field names follow Coolify's [OpenAPI spec](https://github.com/coollabsio/coolify/blob/v4.x/openapi.json).

```bash
COOLIFY=https://coolify.example.com
H=(-H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Content-Type: application/json')

# 1. Look up ids
curl -s "${H[@]}" $COOLIFY/api/v1/projects        # -> project uuid
curl -s "${H[@]}" $COOLIFY/api/v1/servers         # -> server uuid
curl -s "${H[@]}" $COOLIFY/api/v1/github-apps     # -> github_app uuid (or /security/keys for a deploy key)

# 2. Create the application (private repo via GitHub App; for a deploy key use
#    /applications/private-deploy-key with "private_key_uuid" and the SSH repo URL)
APP=$(curl -s "${H[@]}" -X POST $COOLIFY/api/v1/applications/private-github-app -d '{
  "project_uuid": "<project>", "server_uuid": "<server>", "environment_name": "production",
  "github_app_uuid": "<github-app>",
  "git_repository": "TrueCarry/telegram-tdlib-mcp", "git_branch": "master",
  "build_pack": "dockerfile", "dockerfile_location": "/Dockerfile", "base_directory": "/",
  "ports_exposes": "8787", "domains": "https://tg.example.com",
  "is_consistent_container_name_enabled": true,
  "name": "telegram-mcp", "instant_deploy": false
}' | jq -r .uuid)

# 3. Persistent volume for the Telegram session
curl -s "${H[@]}" -X POST $COOLIFY/api/v1/applications/$APP/storages \
  -d '{"type":"persistent","name":"tdlib-data","mount_path":"/data"}'

# 4. Environment variables (is_literal avoids $-interpolation of secrets)
curl -s "${H[@]}" -X PATCH $COOLIFY/api/v1/applications/$APP/envs/bulk -d "{\"data\":[
  {\"key\":\"TDLIB_API_ID\",\"value\":\"$TDLIB_API_ID\",\"is_literal\":true},
  {\"key\":\"TDLIB_API_HASH\",\"value\":\"$TDLIB_API_HASH\",\"is_literal\":true},
  {\"key\":\"TG_PUBLIC_URL\",\"value\":\"https://tg.example.com\",\"is_literal\":true},
  {\"key\":\"TG_OAUTH_ACCESS_CODE\",\"value\":\"$TG_OAUTH_ACCESS_CODE\",\"is_literal\":true},
  {\"key\":\"TG_HTTP_TOKEN\",\"value\":\"$TG_HTTP_TOKEN\",\"is_literal\":true}
]}"

# 5. Deploy and wait
DEP=$(curl -s "${H[@]}" -X POST "$COOLIFY/api/v1/deploy?uuid=$APP" | jq -r '.deployments[0].deployment_uuid')
until s=$(curl -s "${H[@]}" $COOLIFY/api/v1/deployments/$DEP | jq -r .status); \
      [[ $s == finished || $s == failed || $s == cancelled* ]]; do sleep 10; done; echo "$s"

# 6. Runtime logs if something is off
curl -s "${H[@]}" "$COOLIFY/api/v1/applications/$APP/logs?lines=100"
```

Then run [Verify the deployment](#verify-the-deployment), connect a client, and [log in](#log-the-telegram-account-in-once-per-volume).

### Checklist

- [ ] DNS for the domain points at the Coolify server
- [ ] Coolify can read the private repo (GitHub App or deploy key)
- [ ] Build pack Dockerfile, port `8787`, domain `https://<domain>` (Compose: `https://<domain>:8787`)
- [ ] Volume mount at `/data`
- [ ] Consistent container name enabled (Dockerfile build pack)
- [ ] `TDLIB_API_ID`, `TDLIB_API_HASH`, `TG_PUBLIC_URL`, `TG_OAUTH_ACCESS_CODE` set
- [ ] `/health` ok and OAuth metadata URLs match the domain
- [ ] Claude connected through the consent page
- [ ] `tg_login` reached `authorizationStateReady`; `getMe` returns the account

## Tools

### Core (thin passthrough)

**`tg_invoke`** — call any TDLib method.

```jsonc
// By method name + params
{"method": "searchPublicChat", "params": {"username": "BotFather"}}

// Or paste a payload verbatim from the TDLib docs, using @type
{"request": {"@type": "getChat", "chat_id": 133777}}
```

Nested objects carry their own type tag, exactly as in TDLib:

```jsonc
{
  "method": "sendMessage",
  "params": {
    "chat_id": 133777,
    "input_message_content": {
      "@type": "inputMessageText",
      "text": {"@type": "formattedText", "text": "/start"}
    }
  }
}
```

Errors are returned as structured data (with TDLib's numeric code), never thrown — so an agent can react to e.g. `502` or a flood wait instead of just failing.

**`tg_schema`** — discover the API. This is what makes the passthrough usable; call it before `tg_invoke`.

```jsonc
{}                                        // overview + common bot-testing methods
{"query": "callback query"}               // search names and descriptions
{"method": "sendMessage"}                 // full signature, params, and nested types
{"type": "InlineKeyboardButtonType"}      // list every button variant
```

Method lookups expand referenced types one level deep, so a single call tells you how to build a nested payload. Typos get "did you mean" suggestions.

**`tg_updates`** — poll for updates (see the contract below).

### Helpers

**`tg_login`** — walks the multi-step authorization state machine.

**`tg_click_button`** — presses a button on a bot's message, dispatching correctly by kind:

- inline callback → `getCallbackQueryAnswer` (base64 payload passed through untouched)
- reply-keyboard → sends the button's text, which is how Telegram clients implement it
- URL / Web App / login-URL → returns the URL without opening it

Find buttons by label (exact, then case-insensitive substring, which tolerates emoji) or by `row`/`col`. Ambiguous labels are reported rather than guessed. Pass `{"list_only": true}` to inspect a keyboard first.

**`tg_wait_for`** — waits for a bot's response, handling the edit case (below). Can also resolve a `sendMessage` temporary id to its permanent one via `resolve_message_id`.

## The update contract

Three facts drive the design, and are worth understanding:

1. **`tdl` does not buffer updates.** Anything emitted while no listener is attached is lost. This server attaches its listener synchronously at startup and stores updates in a sequence-numbered ring buffer, so nothing is missed between tool calls.
2. **MCP tool calls typically time out at 60s** and progress notifications do not reliably extend that. So blocking polls are capped at 50s (default 25s) and are designed to be called repeatedly.
3. **Bots usually *edit* their message after a button press** instead of sending a new one. Waiting only for `updateNewMessage` will hang forever.

Polling is cursor-based. Pass the `next_seq` you got last time as `since_seq`:

```jsonc
{"wait_ms": 0}                                  // first call: drain what is buffered
{"since_seq": 42}                               // long-poll for anything newer
{"since_seq": 42, "types": ["updateMessage*"]}  // prefix wildcard supported
{"since_seq": 42, "chat_id": 133777}
```

If the buffer wrapped past your cursor, the response sets `dropped: true` with `oldest_seq` and `total_dropped`, so a gap is always explicit rather than silent. Increase `TG_UPDATE_BUFFER_SIZE` or poll more often if you see it.

## Typical bot-testing flow

```jsonc
// 1. Resolve the bot (username without the @)
tg_invoke {"method": "searchPublicChat", "params": {"username": "BotFather"}}
//    -> chat.id, and chat.type.user_id is the bot's user id

// 2. Keep the chat open so TDLib keeps its history current
tg_invoke {"method": "openChat", "params": {"chat_id": 133777}}

// 3. Start the bot (optionally with a deep-link parameter)
tg_invoke {"method": "sendBotStartMessage",
           "params": {"bot_user_id": 93372553, "chat_id": 133777, "parameter": ""}}

// 4. Wait for its reply
tg_wait_for {"chat_id": 133777}
//    -> message_id, text, and buttons already extracted

// 5. Press a button
tg_click_button {"chat_id": 133777, "message_id": 55, "text": "Approve"}
//    -> returns updates_cursor

// 6. Observe the result - the bot most likely EDITED its message
tg_wait_for {"chat_id": 133777, "since_seq": <updates_cursor>}
```

Reading history: call `openChat` first, and expect `getChatHistory` to return
fewer messages than requested — TDLib chooses the batch size, so loop with an
adjusted `from_message_id` until you have enough.

## Development

```bash
npm test            # typecheck + unit tests + end-to-end MCP smoke test
npm run gen:schema  # regenerate the catalog (needs network)
npm run dev         # run from source
```

The catalog is generated from the `td_api.tl` matching the exact TDLib commit that `prebuilt-tdlib` was built from, so it can never drift from the binary. At startup the server compares the running TDLib version against the catalog and warns on mismatch.

## Limitations

- One account per server process. TDLib supports multiple clients, but this server manages a single session.
- A closed TDLib client cannot be reused; after `logOut`, restart the server.
- Web App buttons return their URL rather than launching a mini-app; use `openWebApp` via `tg_invoke` if you need the full flow.
- Respect Telegram's terms of service and rate limits. Flood-wait errors are surfaced with a `retry_after_seconds` field.
