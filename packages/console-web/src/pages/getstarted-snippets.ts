// Get started snippet templates (4f §6; frontend templates, not copy: comments stay in English in both languages,
// as in the README). Values come from /api/me/setup. Placeholders for missing values stay visible ('<…>').

import type { SetupInfo } from '@auto-router/console-contract'

export interface SnippetValues {
  inferenceUrl: string
  authorizeEndpoint: string
  tokenEndpoint: string
  clientId: string
  scope: string
  codexOauthPort: string
  configureJson: string
  cliRawUrl: string
}

/** Placeholder names for values this deployment should provide (Get started explains them as missing settings). */
export const CLI_RAW_URL_PLACEHOLDER = 'raw URL of tools/llmar/llmar in your copy of the repository'
export const DEPLOYMENT_PLACEHOLDERS: ReadonlySet<string> = new Set(['inference URL', 'authorize endpoint', 'token endpoint',
  'cli client id', 'scope', 'Codex callback port', 'configure JSON', CLI_RAW_URL_PLACEHOLDER])
/** The one value each reader fills in: Codex needs an absolute path to llmar-token and the browser cannot know $HOME. */
export const USER_PLACEHOLDER = 'you'
export const HOME_SED = `sed -i "s#/home/<${USER_PLACEHOLDER}>#$HOME#" ~/.codex/config.toml`

const or = (v: string | number | undefined, name: string) => (v === undefined || v === '' ? `<${name}>` : String(v))

/** Single-quoted shell argument. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function snippetValues(s: SetupInfo, cliRawUrl: string | undefined): SnippetValues {
  return {
    inferenceUrl: or(s.inferenceUrl, 'inference URL'),
    authorizeEndpoint: or(s.authorizeEndpoint, 'authorize endpoint'),
    tokenEndpoint: or(s.tokenEndpoint, 'token endpoint'),
    clientId: or(s.clientId, 'cli client id'),
    scope: or(s.scope, 'scope'),
    codexOauthPort: or(s.codexOauthPort, 'Codex callback port'),
    configureJson: s.configureJson ? JSON.stringify(s.configureJson) : '<configure JSON>',
    cliRawUrl: cliRawUrl ?? `<${CLI_RAW_URL_PLACEHOLDER}>`,
  }
}

export const install = (v: SnippetValues) => `mkdir -p ~/bin
curl -fsSLo ~/bin/llmar ${shellQuote(v.cliRawUrl)} && chmod +x ~/bin/llmar
ln -sf llmar ~/bin/llmar-token && ln -sf llmar ~/bin/llmar-login`

export const configure = (v: SnippetValues) => `llmar configure --from ${shellQuote(v.configureJson)}`

export const signIn = () => `llmar login
llmar status`

export const claudeCode = (v: SnippetValues) => JSON.stringify({
  apiKeyHelper: '~/bin/llmar-token',
  env: {
    ANTHROPIC_BASE_URL: v.inferenceUrl,
    CLAUDE_CODE_USE_BEDROCK: '0',   // the router, not Bedrock directly (an existing Bedrock setup would win over ANTHROPIC_BASE_URL)
    ANTHROPIC_MODEL: 'auto',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'auto:frontier',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto:standard',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'auto:fast',
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '240000',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
}, null, 2)

export const codex = (v: SnippetValues) => `model = "auto"
model_provider = "llmar"
model_context_window = 1000000
model_auto_compact_token_limit = 700000
web_search = "disabled"                # required: Bedrock rejects Codex's built-in web search tool mid-stream

[model_providers.llmar]
name = "llmar router"
base_url = "${v.inferenceUrl}/v1"
wire_api = "responses"
env_http_headers = { "x-router-session" = "LLMAR_SESSION" }
requires_openai_auth = false
supports_websockets = false

[model_providers.llmar.auth]           # Authorization: Bearer, refreshed by llmar
command = "/home/<${USER_PLACEHOLDER}>/bin/llmar-token"
timeout_ms = 15000
refresh_interval_ms = 240000

[model_providers.llmar.gateway_oauth]  # Codex's own sign-in; its token goes in x-api-key
authorization_url = "${v.authorizeEndpoint}"
token_url = "${v.tokenEndpoint}"
client_id = "${v.clientId}"
scopes = ["openid", "${v.scope}"]
redirect_port = ${v.codexOauthPort}
delivery = { kind = "header", name = "x-api-key" }
# credentials_store = "file"          # headless Linux without a keyring: keep this sign-in in $CODEX_HOME/secrets/

[features]
enable_request_compression = false`

export const credentialsStoreLine = 'credentials_store = "file"'
export const configParentFix = 'chmod g-w ~/.config'
export const claudeEnvCheck = "env | grep -E 'CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL'"
export const unsetApiKey = 'unset ANTHROPIC_API_KEY'
export const sshForward = (cliPort: number | undefined, codexPort: number | undefined) =>
  `ssh -L ${cliPort ?? 52817}:127.0.0.1:${cliPort ?? 52817} -L ${codexPort ?? 52820}:127.0.0.1:${codexPort ?? 52820} <host>`

export const codexRun = () => 'LLMAR_SESSION=$(uuidgen) codex'

export const codexShort = (v: SnippetValues) => `[model_providers.llmar]
name = "llmar router"
base_url = "${v.inferenceUrl}/v1"
wire_api = "responses"
env_key = "LLMAR_TOKEN"                # sent as Authorization: Bearer
env_http_headers = { "x-router-session" = "LLMAR_SESSION", "x-api-key" = "LLMAR_TOKEN" }
requires_openai_auth = false
supports_websockets = false

# run: LLMAR_TOKEN=$(llmar-token) LLMAR_SESSION=$(uuidgen) codex`

const sdkCommon = `import subprocess, uuid
import anthropic, openai
import httpx2 as httpx   # anthropic>=2 / openai>=3 ship httpx2; older releases use httpx

def router_token() -> str:   # llmar answers from its cache; it refreshes 5 min before expiry
    return subprocess.run(['llmar-token'], capture_output=True, text=True, check=True).stdout.strip()

class RouterAuth(httpx.Auth):   # both headers on every request
    def auth_flow(self, request):
        t = router_token()
        request.headers['authorization'] = f'Bearer {t}'
        request.headers['x-api-key'] = t
        yield request

session = {'x-router-session': str(uuid.uuid4())}   # one id per agent session`

export const anthropicSdk = (v: SnippetValues) => `${sdkCommon}
claude = anthropic.Anthropic(base_url='${v.inferenceUrl}', auth_token='unused', default_headers=session,
                             http_client=httpx.Client(auth=RouterAuth()))
msg = claude.messages.create(model='auto', max_tokens=512, messages=[{'role': 'user', 'content': 'Hello'}])`

export const openaiSdk = (v: SnippetValues) => `${sdkCommon}
oai = openai.OpenAI(base_url='${v.inferenceUrl}/v1', api_key='unused', default_headers=session,
                    http_client=httpx.Client(auth=RouterAuth()))
resp = oai.responses.create(model='auto', input='Hello', store=False)`

export const curl = (v: SnippetValues) => `TOKEN=$(llmar-token)
curl -sS "${v.inferenceUrl}/v1/messages" -H "Authorization: Bearer $TOKEN" -H "x-api-key: $TOKEN" \\
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H "x-router-session: $(uuidgen)" \\
  -d '{"model": "auto", "max_tokens": 256, "messages": [{"role": "user", "content": "Say ok."}]}' -D -`
