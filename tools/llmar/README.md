# llmar

`llmar` signs a member in to an llm-auto-router deployment with their own Cognito account, and prints router
access tokens for Claude Code, Codex, the SDKs and curl. It is one Python 3.9+ file with no dependencies.
Member-facing setup lives in the console's Get started page and the README's "Connecting clients" section. This
file is for maintainers.

## Install

```bash
mkdir -p ~/bin
curl -fsSLo ~/bin/llmar <raw URL of tools/llmar/llmar> && chmod +x ~/bin/llmar
ln -sf llmar ~/bin/llmar-token && ln -sf llmar ~/bin/llmar-login
llmar configure --from '<JSON block from the Get started page>'
llmar login
```

`llmar-token` and `llmar-login` are argv[0] aliases of `llmar token` and `llmar login`, so a tool can call them
with no arguments.

## Commands

| Command | Does | Network |
|---|---|---|
| `configure --from '<json>' \| @file \| -` | validates and stores one profile's settings in `config.json` | no |
| `configure --show` | prints the stored settings | no |
| `login [--no-browser] [--port N]` | auth code + PKCE S256 with `state` and `nonce`; callback on `127.0.0.1:<registered port>/callback` | IdP |
| `token [--json]` | prints the cached access token, refreshing it within 5 min of expiry (half the lifetime for short-lived tokens) | IdP on refresh |
| `headers` | `authorization: Bearer <t>` plus `<identityHeader>: <t>`, for `curl -H @<(llmar headers)` | IdP on refresh |
| `status` | who, groups, sign-in date, token validity (no token values) | no |
| `logout` | revokes the refresh token (`/oauth2/revoke`) and deletes the credentials | IdP |

Every command takes `--profile NAME` (or `LLMAR_PROFILE`; default `default`).

### Settings (`configure --from`)

```json
{
  "cognitoDomain": "https://<domain>.auth.<region>.amazoncognito.com",
  "clientId": "<cli app client id>",
  "scope": "<prefix>/invoke",
  "redirectPorts": [52817, 52818, 52819],
  "gatewayUrl": "https://<gw-id>.gateway.bedrock-agentcore.<region>.amazonaws.com",
  "identityHeader": "x-api-key",
  "refreshDays": 30
}
```

| Key | Required | Notes |
|---|---|---|
| `cognitoDomain` | yes, unless all three endpoints are given | `authorizeEndpoint`, `tokenEndpoint` and `revokeEndpoint` default to `/oauth2/authorize`, `/oauth2/token` and `/oauth2/revoke` on it |
| `clientId` | yes | the public `cli` app client (no secret) |
| `scope` | yes | `openid` is always added |
| `redirectPorts` | yes | must be exactly the callback ports registered on the app client (Cognito matches them exactly) |
| `gatewayUrl` | no | shown by `status` |
| `identityHeader` | no | default `x-api-key`; `null` for none. It only affects `headers`; the header path stays open until spike S2 |
| `refreshDays` | no | the app client's refresh-token validity, shown by `status` |

Other keys from the console block are ignored: `schemaVersion`, `profile`, `codexOauthPort`, `region`.

Endpoints must be `https`, or plain `http` to a loopback host (tests only).

## Files

`$LLMAR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/llmar`, else `~/.config/llmar`.

- The directory is 0700. It must be owned by the user and not group- or world-writable, and its parent must not
  be group- or world-writable unless it has the sticky bit (like `/tmp`), or others could replace it.
- `config.json` holds the settings, no secrets. It is written 0600 and must not be writable by others.
- `credentials-<profile>.json` (0600) holds the refresh token, the cached access token, `expiresAt` (local clock
  at receipt plus `expires_in`), the token endpoint and client id it is bound to, and `sub`, `username` and
  `groups` for `status`. The ID token is not stored.
- `llmar` refuses to read the credentials if other users can read them, or if the file is not the user's (like
  ssh).
- Every write is atomic (temp file, then `os.replace`).
- `credentials-<profile>.lock` is a `flock` taken shared to read and exclusive to refresh, so 20 parallel
  `llmar token` calls make one refresh.
- Credentials are bound to the token endpoint and client id they came from. If the settings change, `token`
  exits 2 instead of sending the refresh token to the new endpoint.

**Windows is best effort:** POSIX mode bits are meaningless there, so llmar checks no ACLs. It relies on the
user profile's default ACL, and the lock is an exclusive `msvcrt` lock.

## `llmar token` contract

- Stdout is the token plus a newline, or nothing. Every message goes to stderr.
- It never opens a browser and never reads stdin.

| Exit | Meaning |
|---|---|
| 0 | token printed. Also when the IdP is down but the cached token has more than 30 s left (with a warning on stderr) |
| 2 | sign-in required: not signed in; the refresh was refused (`invalid_grant` wipes the tokens); or the settings changed since sign-in |
| 3 | IdP unreachable, 5xx or 429, and no usable cached token |
| 4 | bad settings, unsafe permissions, or bad usage (usage errors never exit 2) |

Clients should cache the token for at most 4 minutes (Claude Code `CLAUDE_CODE_API_KEY_HELPER_TTL_MS=240000`,
Codex `refresh_interval_ms = 240000`). Then they never hold a token with less than about 1 minute left. Both
clients also re-run the helper after a 401.

## Security notes

- The callback listener binds `127.0.0.1` only, on a registered port. It accepts one `GET /callback` with a
  matching `state` (constant-time compare) and answers 400 to a stale or forged one.
- The listener uses a 5-second socket timeout, never logs (the query carries the code), and closes after the
  first valid callback or the login timeout.
- The callback page is static en/zh text with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- The `nonce` and `aud` claims of the ID token are checked. JWT payloads are decoded without signature checks,
  for display and the nonce only, since the token came straight from the token endpoint over TLS. The gateway
  and the router verify signatures.
- Redirects on the token and revoke endpoints are refused. IdP errors are reduced to the OAuth error code;
  `error_description` is never echoed.
- Only `token` and `headers` print token values (on stdout). No token value appears on stderr, in `status`, in
  `login` output, or in an error message.
- `login` prints the authorize URL to stderr (it carries `state`, `nonce` and the PKCE challenge, never the
  verifier or a token).
- Before storing a sign-in, `login` checks the access token's `token_use` (`access`), its `client_id` (the
  configured client) and that every configured scope was granted. An app client without the router scope
  therefore fails at sign-in, not later at the gateway.

## Tests

```bash
cd tools/llmar
uv run --python 3.9 --with pytest==8.4.2 pytest -q tests
uv run --python 3.12 --with pytest==8.4.2 pytest -q tests
```

The tests run the CLI as a subprocess against a fake Cognito-style IdP (`tests/fake_idp.py`) on 127.0.0.1, with
dynamically chosen ports. They need no AWS and no network beyond loopback. Tokens are minted at runtime.
