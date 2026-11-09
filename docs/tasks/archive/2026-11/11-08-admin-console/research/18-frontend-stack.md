# 18 — Admin console: frontend stack, auth, i18n, build/deploy (research)

Author: 18 · 2026-11-08 · research only (no repo code, no installs into the repo, no AWS calls).
Answers design draft 0 §7 **[open: 18]** and the frontend half of §8.

Evidence used:
- **R:** the npm registry on 2026-11-08 (versions, licences, peer deps).
- **M:** a scratch Vite build of a representative Cloudscape page under `~/.cache` (removed afterwards), loaded in
  headless Chromium (Playwright 1.65) behind a static server on 127.0.0.1 that sent the proposed CSP header.
- **D:** AWS documentation (Cognito, API Gateway, CloudFront).
- **S:** this repo (`infra/src/stack.ts`, `packages/core`, `.npmrc save-exact=true`).

Claims I did not verify are labelled *unverified*.

## 0. Recommendations at a glance

| Area | Recommendation | Key evidence |
| --- | --- | --- |
| UI kit | **Cloudscape** (`@cloudscape-design/components` 3.0.1410, Apache-2.0) with its **classic charts** | R, M: zh-CN component locale works, dark mode works, strict CSP gives zero violations |
| Do not use | `@cloudscape-design/chart-components` | R: peer dependency on `highcharts`, whose licence is commercial ("highcharts.com/license") — not publishable in an MIT-0 sample |
| Framework | React 19.3.1 + Vite 8.3.6 + `@vitejs/plugin-react` 6.2.1, TS 7 (repo) | M: renders with no console errors under React 19 |
| Routing / data | `react-router` 8.5.1 (declarative, lazy routes) + `@tanstack/react-query` 5.107.1 | R: both support React 19 |
| Auth | **`oidc-client-ts` 3.5.0**, auth code + PKCE S256, static metadata from `config.json`, Cognito-specific logout | M: 17 KB gz (Amplify Auth 25 KB gz); D: Cognito token-endpoint refresh rotates |
| Token storage | `sessionStorage` (library default) + refresh-token rotation + 8 h refresh window + 15 min access tokens; `memory` as a deploy option | §2.3 |
| i18n | No i18n library: typed JSON dictionaries plus `intl-messageformat` (already in the bundle through Cloudscape) | M |
| Package | `packages/console-web` (`@auto-router/console-web`) | S: already covered by the `packages/*` workspace glob |
| Hosting | One CloudFront distribution: S3 (OAC) for the shell and **`/api/*` → HTTP API on the same origin** | §4.3: no CORS, no CloudFormation dependency cycle, WAF can cover the API |
| CSP | `script-src 'self'; style-src 'self'` + Trusted Types enforced (full string in §4.4) | M: zero violations |
| Tests | Vitest + jsdom + Testing Library + Cloudscape test-utils; Playwright smoke on 127.0.0.1 with network-level IdP/API fakes (no auth bypass in the bundle) | §4.7 |

## 1. Stack

### 1.1 Licences
- **Apache-2.0:** Cloudscape `components`, `global-styles`, `collection-hooks` and `design-tokens`; also
  `oidc-client-ts`, `aws-amplify` and `@playwright/test`.
- **MIT:** React, Vite, react-router, TanStack Query, Testing Library, jsdom and `intl-messageformat`.
- **BSD-3 / ISC:** the transitive `d3-shape` and `date-fns` (`date-fns` is MIT).
- All of these can be published with an MIT-0 repo.

**Excluded:**
- `@cloudscape-design/chart-components` 1.0.161 has peer dependency `highcharts ^12.6.2`, and Highcharts'
  licence field is a URL to a commercial licence.
- `highcharts` itself, for the same reason.
- `board-components`: not needed.

**Notice obligation:** the minified bundle contains **0 licence comments** (M: grep for SPDX/@license/Apache).
CloudFront serves this bundle, which redistributes Apache-2.0 code. Generate `dist/third-party-licenses.txt` at
build time from `pnpm licenses list --json`, using a small script and no extra dependency. Link it from Settings →
About.

### 1.2 Bundle size (M; gzip -9; one route; no code splitting)

| Build | JS gz | CSS gz |
| --- | --- | --- |
| Representative page¹ + en/zh-CN component messages + router + Query + oidc | **438 KB** | 248 KB |
| Same page, `global-styles/index-base.css` (no embedded fonts) | 438 KB | **109 KB** |
| Minimal shell: TopNavigation + AppLayout + SideNavigation + Container | **223 KB** | 72 KB |

¹ AppLayout, TopNavigation, SideNavigation, Breadcrumbs, Table + PropertyFilter + Pagination, Form controls,
Modal, Tabs, KeyValuePairs, Alert, Flashbar, DateRangePicker, Bar/Line/Pie charts, CopyToClipboard,
ExpandableSection and SegmentedControl.

What each part adds (JS gz, removed one at a time):
- Classic charts: 39 KB.
- Cloudscape en + zh-CN component messages: 16 KB.
- `oidc-client-ts`: 17 KB.
- TanStack Query: 7 KB.

What this means:
- Cloudscape is heavy. The cost is mostly AppLayout, PropertyFilter, DateRangePicker and Table, not charts.
- **About 0.7 MB gz is a cold first load. It is a one-time cost:** every asset is hashed and cached with
  `immutable`.
- Use route-level `lazy()`: the charts sit behind the Usage and Savings pages, and admin pages load in their own
  chunk.
- Budget: initial route ≤ 300 KB gz JS. Total JS ≤ 550 KB gz.

**Fonts:** `global-styles/index.css` embeds eight Open Sans faces as base64 `data:` URIs. They are 139 KB gz of
the CSS, and they need `font-src data:`.
- **Release 1:** keep `index.css` and allow `font-src 'self' data:`. This keeps Cloudscape's look with zero extra
  work, and the relaxation applies to fonts only.
- **Later:** if first-load size matters, use `index-base.css` and self-host the woff2 files (`font-src 'self'`).

### 1.3 zh-CN
- Cloudscape ships `i18n/messages/all.zh-CN` (and zh-TW; 16 locales in total). It is used through
  `<I18nProvider locale messages>`.
- M observed localized built-in strings in Chromium: 上一页, 所有页面中的第 1 页, 侧导航, 关闭帮助面板, and the
  chart filter 筛选显示的数据 / 筛选数据.
- Open Sans has **no CJK glyphs**, so Chinese text falls back to system fonts (PingFang SC, Microsoft YaHei,
  Noto Sans CJK SC).
- **Set `<html lang="zh-CN">` when the language switches.** Without it, Han unification can make browsers pick
  Japanese glyph forms.
- Do not use Cloudscape runtime theming (`applyTheme` from theming-runtime) to add CJK font families. It is
  likely to inject `<style>` at runtime (*unverified*), which would break `style-src 'self'`.

### 1.4 Charts
- The **classic** charts in `@cloudscape-design/components` cover the use cases: BarChart (stacked or grouped),
  LineChart, AreaChart, MixedLineBarChart and PieChart/donut.
  - They are built on `d3-shape`.
  - The 3.0.1410 typings have no `@deprecated` markers.
  - They follow dark mode and design tokens automatically.
- Mapping to pages:
  - Usage: stacked bars of tokens per day, one series per token class or model.
  - Cost: a line.
  - Savings: MixedLineBarChart, with bars for the routing effect (+) and for the switch penalty and assessor
    overhead (−), and a line for the net. Rendering of negative values is *unverified*; check it in the scaffold.
- Every chart gets a "table view" toggle. It is the accessible alternative, and its rows feed the same CSV export.
- Tick and tooltip formatters come from the locale formatters in §3.
- A lighter library would add bundle size and lose token, dark-mode and a11y consistency. **I found no clearly
  better charting option.**

### 1.5 Accessibility and dark mode
- **Accessibility:**
  - Cloudscape components ship ARIA wiring, keyboard navigation and focus handling, and their labels are
    localized (M).
  - What the console owns:
    - an `ariaLabel` and `ariaDescription` on every chart;
    - `ariaLabels` on tables;
    - one `Header variant="h1"` per page;
    - moving focus to the h1 after a route change;
    - a live region for flash messages.
  - The Playwright smoke runs `@axe-core/playwright` 4.14.0 (MPL-2.0, dev-only and not shipped) and fails on any
    serious or critical finding.
- **Dark mode:**
  - `applyMode(Mode.Dark | Mode.Light)` from `@cloudscape-design/global-styles` toggles a body class (M: the dark
    screenshot rendered correctly, charts included).
  - Settings offers System / Light / Dark. System follows `matchMedia('(prefers-color-scheme: dark)')` live.
  - Optional: `applyDensity(Density.Compact)` for decision tables.
  - All preferences persist in `localStorage` (non-sensitive).

### 1.6 Strict CSP compatibility (M)
- The build's `index.html` has **no inline script**. JS has no `<style>` creation, `setAttribute('style')`,
  `eval` or `new Function`.
- Served with `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; …;
  require-trusted-types-for 'script'; trusted-types 'none'`:
  - **zero CSP or Trusted Types violations and zero console errors**;
  - exercised: page load, Select open, PropertyFilter typing, DateRangePicker open, chart hover, ExpandableSection
    and the side-navigation toggle.
  - React's style props go through CSSOM, which CSP does not block.
- With `index.css` and `font-src 'self'` only, the eight embedded fonts are blocked. Hence `font-src 'self' data:`
  (§1.2).
- **Do not use Cloudscape `CodeEditor`** for the policy JSON view:
  - The app has to supply Ace, which adds bundle weight.
  - Ace is known to inject styles and start workers (*unverified here*).
  - Instead use a monospace `Textarea` with a parsed-error list (JSON pointer, then a message) and a read-only
    diff view.

### 1.7 Alternatives considered
None is clearly better.
- **Ant Design / MUI:**
  - Ant Design has excellent zh-CN support.
  - Both use runtime CSS-in-JS, which needs `'unsafe-inline'` or per-response nonces. A static CloudFront
    response-headers policy cannot issue nonces.
  - Their bundles are of similar size.
- **shadcn/Radix + Tailwind + Recharts:**
  - Smaller (*estimated*, not measured).
  - No component-level zh-CN strings, and much more UI code for us to own.
- Cloudscape's build-time CSS is what makes the strict CSP possible.

## 2. Auth in the SPA

### 2.1 Library

| | oidc-client-ts 3.5.0 | Amplify Auth 6.21.2 | Hand-rolled PKCE |
| --- | --- | --- | --- |
| Size (M, gz) | 17 KB (with `jwt-decode`) | 25 KB (+ `@aws-amplify/core` singleton) | ~3 KB |
| PKCE / state / nonce | built in (S256) | built in | ours to get right |
| Refresh | token endpoint `refresh_token` grant: rotates when rotation is enabled (D) | `GetTokensFromRefreshToken` (seen in 6.21.2 source): rotation-safe | ours |
| Storage | pluggable: `sessionStorage` (default), `InMemoryWebStorage`, custom | `localStorage` default; sessionStorage, cookie (JS-readable) or custom | ours |
| Endpoints contacted | Cognito domain only, with static metadata | Cognito domain + `cognito-idp.<region>` API | Cognito domain |
| Cognito quirks | no standard `end_session_endpoint` → custom `/logout` redirect | handled | ours |

**Recommendation: `oidc-client-ts`.**
- It is a standard relying-party library: small, no global singleton, explicit storage.
- Hand-rolled PKCE would put security-sensitive state handling (CSRF state, verifier, refresh races, multi-tab)
  into code we maintain, against the spirit of the PRD's "Cognito-native, nothing home-made" constraint.
- Amplify works but brings a second endpoint, a localStorage default and configuration-singleton surface for no
  gain here.
- `react-oidc-context` is not needed. Our `AuthProvider` is about 60 lines.

**Configuration:**
- Use **static `metadata`** built from `config.json`, so the browser makes no discovery call:
  - `issuer = https://cognito-idp.<region>.amazonaws.com/<poolId>`
  - `authorization_endpoint = <domain>/oauth2/authorize`
  - `token_endpoint = <domain>/oauth2/token`
  - `revocation_endpoint = <domain>/oauth2/revoke`
  - `userinfo_endpoint = <domain>/oauth2/userInfo`
- `response_type=code` and `automaticSilentRenew` (uses the refresh token; no iframe).
- `extraQueryParams: { lang }` so managed login matches the UI language.
- `url_state` carries the return-to path.

### 2.2 Cognito app clients (input to infra/a3; one existing pool, `ESSENTIALS` plan per `stack.ts`)
- **`console`:**
  - public client (no secret);
  - `authorizationCodeGrant` only, with `authFlows: {}`: no SRP or password flows on this client, and rotation is
    incompatible with `REFRESH_TOKEN_AUTH` anyway (D);
  - scopes `openid` and a **new resource-server scope `<prefix>/console`**;
  - callback `https://<cf-domain>/auth/callback`, sign-out URL `https://<cf-domain>/signed-out`;
  - access and ID tokens 15 min (minimum 5); refresh 8 h (minimum 60 min, D);
  - `refreshTokenRotationGracePeriod: 10 s` (CDK 2.275 has the property; S);
  - token revocation on; `preventUserExistenceErrors`.
- **Require `<prefix>/console` on every HTTP API route.**
  - The JWT authorizer matches `aud` (ID tokens) **or** `client_id` (access tokens) against the audience list, and
    API Gateway's docs recommend route scopes to tell access tokens apart (D).
  - The scope also rejects router `invoke` tokens and ID tokens.
  - Cognito access tokens carry `cognito:groups`, so the API can use access tokens alone.
- **`console-local`:**
  - created only when a deploy parameter (e.g. `consoleLocalDev=true`) is set;
  - callback `http://127.0.0.1:5173/auth/callback`. Cognito allows plain HTTP callbacks only for loopback hosts:
    `http://localhost`, `http://127.0.0.1` and `http://[::1]`, with custom ports and exact matching (D:
    `CreateUserPoolClient` API reference; corrected 2026-11-08, in agreement with 17 F12). The callback host is
    the one Vite binds (§4.6);
  - keeps the production client's URL list HTTPS-only.
- **Managed login v2 for `lang=zh-CN`:**
  - Localization requires managed login on Essentials or Plus (D; the pool is Essentials).
  - The domain currently uses the CDK default (classic hosted UI). Set
    `managedLoginVersion: NEWER_MANAGED_LOGIN` on `pool.addDomain`.
  - Add a `CfnManagedLoginBranding` (`useCognitoProvidedValues: true`) for every client that signs in
    interactively (`console`, `console-local`, and the `cli` client of the cli-login child). With version 2 and no
    style, the client has no managed-login pages (D).
  - The existing M2M client only uses `/oauth2/token`. I expect no impact (*unverified*; add it to the identity
    spike).
- **WAF note for D1 option A:**
  - **HTTP APIs cannot take a WAF web ACL.** An IP allowlist therefore covers only what passes through CloudFront
    (§4.3 routes the API through it).
  - A web ACL can also attach to the user pool itself, which protects managed login.

### 2.3 Token storage

| Option | Reload | New tab | XSS impact |
| --- | --- | --- | --- |
| Memory (`InMemoryWebStorage`) | re-login; the managed-login cookie (1 h, D) offers "continue as …" | re-login | tokens of the live page only (injected script can still hook `fetch`) |
| **`sessionStorage`** (default) | kept | re-login (cookie) | refresh token can be stolen → persistence ≤ the fixed 8 h window (rotation never extends it, D); rotation turns reuse into a race the user notices; admin disable plus global sign-out ends it |
| `localStorage` | kept | kept | widest: survives browser restarts — **no** |
| BFF / HttpOnly cookie | kept | kept | best against exfiltration, but adds a home-made session layer (cookie, CSRF, server-side refresh tokens) against the PRD constraint — **not release 1** |

**Recommendation:**
- `sessionStorage`, with these bounds:
  - rotation and the 8 h window;
  - 15 min access tokens;
  - revocation on sign-out;
  - strict CSP with Trusted Types;
  - no third-party scripts;
  - a lint ban on `dangerouslySetInnerHTML`;
  - links built only from same-origin paths.
- Expose `tokenStorage: "session" | "memory"` in `config.json` (a deploy parameter) for stricter deployments.
- Under XSS, keeping the access token in memory instead of storage gains almost nothing: injected script can call
  the API in-page anyway. **The real bound is the refresh window.**

### 2.4 Roles and route guards
- **UI only:**
  - The UI reads `cognito:groups` from the decoded (unverified) access token payload.
  - `<RequireGroup group="admin">` wraps admin routes. Admin nav items are hidden from members.
  - A deep link without the group shows a 403 page (no redirect loop).
- **The server is authoritative** (design §6).
- **Staleness (for a3):**
  - A group change reaches the UI at the next refresh (≤ 15 min).
  - The HTTP API JWT authorizer checks signature and claims only (D), so a disabled or demoted admin keeps API
    access until the access token expires.
  - If 15 min is too long, console-api should re-check the user's status and groups on admin mutations
    (`AdminGetUser` / `AdminListGroupsForUser`, cached ≤ 60 s).
- **Admin MFA enforcement** is a backend question: pool MFA `OPTIONAL` has no per-group "required" mode. Flagged
  only.

### 2.5 Flows
- **Boot:**
  1. Fetch `config.json`.
  2. Create the `UserManager`.
  3. On `/auth/callback`, run `signinCallback()`, then navigate to `url_state`. Accept it **only if it is a
     same-origin path** (no `//`, no scheme).
  4. Otherwise call `getUser()`. With no user, or an expired one whose refresh fails, call
     `signinRedirect({ url_state: location.pathname + search, extraQueryParams: { lang } })`.
- **Expiry while in use:** a silent refresh runs 60 s before `exp`. On `invalid_grant`, show the flash "session
  ended" and redirect to sign-in, keeping the route.
- **Sign-out:**
  1. Post `signout` on a `BroadcastChannel('llmar-auth')`; other tabs clear their tokens.
  2. `POST <domain>/oauth2/revoke` with `token` and `client_id` (public client, D), using `keepalive`, best
     effort.
  3. `removeUser()`.
  4. `location.assign(<domain>/logout?client_id=…&logout_uri=<origin>/signed-out)`; `logout_uri` must be a
     registered sign-out URL (D).
  5. `/signed-out` is a static page with a "Sign in again" button and no auto-redirect.

### 2.6 API call wrapper (`src/api/client.ts`)
- **Calls:** `request<T>(method, path, { body?, signal?, ifMatch? })` on **relative `/api/...`** paths (same
  origin, §4.3).
- **Token:** `getAccessToken()` does a single-flight refresh when `exp − now < 60 s`.
- **Headers:**
  - `authorization: Bearer <access>` and `accept: application/json`;
  - `content-type: application/json` on requests with a body;
  - `if-match` on config writes (optimistic lock, design §3).
- **Timeout:** `AbortSignal.any([signal, AbortSignal.timeout(15_000)])`.
- **Error handling:**
  - **401:** one forced refresh and a retry; a second 401 goes to sign-in.
  - **403:** `ForbiddenError` (page shows "no permission").
  - **409/412:** `ConflictError` ("the config changed since you opened it": reload the diff).
  - **Other 4xx:** the body is `{ error: { code, message } }` (design v1 contract §2.4), and **the UI localizes
    by `code`**. `message` is shown only for codes without a copy-deck entry.
  - **5xx / network:** TanStack Query retries GETs twice with backoff; mutations are never retried.
- **Never** puts tokens in URLs or logs. CSV export fetches with the wrapper and saves through a Blob object URL.
- **Types:** shared request/response types belong in one contract module that both console-api and console-web
  import (owner a3/0c).
- **Live validation:**
  - The policy editor can run `validatePolicy` and `checkPolicyAgainstCatalog` in the browser for instant
    feedback.
  - `packages/core/src/policy.ts` imports only types, but the `@auto-router/core` index re-exports `hash.ts`,
    which imports `node:crypto` (S).
  - **Add a `"./policy"` subpath export to core** (owner 0c/0d) so the browser bundle never touches
    `node:crypto`.
  - The server re-validates authoritatively. The catalog comes from `/api/catalog`.

## 3. i18n
- **No i18n library.**
  - Strings live in `src/i18n/en.json` (source of truth) and `src/i18n/zh-CN.json`. Keys are dotted namespaces
    (`usage.table.cost`), taken from 4f's copy deck.
  - Values use **ICU MessageFormat**, formatted by **`intl-messageformat` 10.7.18**. Cloudscape's I18nProvider
    already bundles it (M: present in the build), so the marginal cost is zero. Declare it as a direct, pinned
    dependency.
- **Types and checks:**
  - `type MessageKey = keyof typeof en`, and `zh-CN.json` is checked with `satisfies Record<MessageKey, string>`.
  - A vitest test enforces key parity, that every value parses as ICU, the same argument names per key in both
    languages, and no empty values.
- **API:** `useT()` returns `t(key, values?)`, with a formatter cache per locale.
- **Cloudscape strings:** `<I18nProvider locale={lang} messages={[cloudscape[lang]]}>` with the locale messages
  lazily imported (≈ 8 KB gz each).
- **Switch:**
  - Lives in the TopNavigation utility menu, with each language named in itself (English / 简体中文).
  - Persisted in `localStorage['llmar.console.lang']`.
  - Initial value: the stored one; otherwise `zh-CN` if any `navigator.languages` entry starts with `zh`, else
    `en`.
  - On change, set `document.documentElement.lang` and pass `lang` to managed login at the next sign-in.
- **`src/i18n/format.ts`** (observed in Node 24 ICU):

  | Value | en | zh-CN |
  | --- | --- | --- |
  | currency, always USD (list prices) | $1,234.50 | US$1,234.50 |
  | small cost, `maximumSignificantDigits: 3` | $0.00123 | US$0.00123 |
  | tokens, compact | 12.3M · 45.7K | 1234.6万 · 4.6万 |
  | percent | 87.3% | 87.3% |
  | date-time, `medium`/`short` | Nov 8, 2026, 3:04 AM | 2026年11月8日 03:04 |
  | relative | yesterday | 昨天 |

- **Time zone:**
  - Rollups are per UTC day (design §4, `R#<day>`). Day axes and day filters are **labelled UTC in both
    languages**.
  - Record timestamps show local time, with the ISO UTC time in a tooltip.
  - DateRangePicker uses offset 0 for day filters.
- **Rules for 4f's copy deck:**
  - no string concatenation; plurals and selects in ICU;
  - units inside the message;
  - code and config snippets on Get started are not translated (only the prose around them);
  - money is always labelled list price.

## 4. Build and deploy

### 4.1 Package
- **Location and name:** `packages/console-web`, name `@auto-router/console-web`, `private`, MIT-0.
- **Workspace:** the existing `packages/*` glob picks it up, so root `pnpm build | typecheck | test` cover it.
  `dist/` is already gitignored.
- **tsconfig:** extends `tsconfig.base.json` and overrides:
  - `lib: ["es2024","dom","dom.iterable"]`
  - `module: "esnext"`, `moduleResolution: "bundler"`
  - `jsx: "react-jsx"`
  - `types: ["vite/client"]`
  - `noEmit: true`, `declaration: false`
- **Toolchain compatibility:**
  - The repo's TS 7.0.2 and vitest 5.1.0 (peer `vite ^6.4 || ^7 || ^8`) work with Vite 8 (R).
  - jsdom 31 needs Node ≥ 24.15 (R; local Node is 24.20).

### 4.2 Runtime config (`/config.json`, fetched before anything else)
```json
{ "schemaVersion": 1, "region": "<region>", "userPoolId": "<region>_<id>", "clientId": "<console client>",
  "cognitoDomain": "https://<prefix>-<suffix>.auth.<region>.amazoncognito.com",
  "scopes": ["openid", "<prefix>/console"], "apiBase": "/api", "tokenStorage": "session" }
```
- **Fetch and validation:**
  - Fetched with `cache: 'no-store'` and validated by a hand-written guard.
  - If it is invalid, a static config-error page renders (never a login loop).
  - It holds no secrets: the client is public.
- **Keep it minimal:** it is anonymously reachable, so it contains only what sign-in needs. The gateway URL, CLI
  client id, token endpoint and scope for **Get started** come from `GET /api/me/setup` after sign-in.
- **CDK:**
  - `s3deploy.Source.jsonData('config.json', {...})` resolves deploy-time tokens (S: CDK 2.275 has it).
  - Both `BucketDeployment`s exist only with `-c consoleBundle=true` (design v1 deploy order: the first deploy runs
    with `consoleBundle=false`, the anonymous and valid-token checks pass, then a redeploy uploads the bundle):
    - **(a)** `assets/**` with `public, max-age=31536000, immutable` and **`prune: false`**, so tabs still open
      on the previous version can still load their lazy chunks;
    - **(b)** `index.html` + `config.json` + `third-party-licenses.txt` with `no-cache`, depending on (a), with
      `distributionPaths: ['/index.html','/config.json']`.
  - The app catches chunk-load errors and offers a reload.
- **Stale-build guard:**
  - The deploy script builds first, from the clean worktree of HEAD (repo rule), and then runs `cdk deploy`.
  - The build writes `dist/build.json` `{ gitSha, builtAt }`, shown on Settings → About.
  - Synth fails if `dist/index.html` is missing or `gitSha` ≠ HEAD.
  - `infra` unit tests point the asset at a fixture directory instead.

### 4.3 CloudFront topology (D1 option A)
- **Default behavior → S3:**
  - private bucket with all four Block Public Access settings on and `enforceSSL`;
  - OAC (`S3BucketOrigin.withOriginAccessControl`; the bucket policy conditions on the distribution's
    `AWS:SourceArn`);
  - a viewer-request **CloudFront Function** (JS 2.0) rewrites extensionless paths to `/index.html`.
  - **Do not use distribution-wide custom error responses for the SPA fallback.** They would also turn API
    403/404 responses into `index.html` with status 200.
- **`/api/*` → HTTP API default endpoint:**
  - `HttpOrigin`, `CachingDisabled`;
  - origin request policy **`AllViewerExceptHostHeader`**: it forwards `Authorization` when caching is off (D),
    and the Host header must not be forwarded to execute-api (D);
  - all methods allowed;
  - console-api routes are defined under `/api/...` (for a3).
- **Why the same origin:**
  1. No CORS, so `connect-src` is `'self'` plus the Cognito domain.
  2. It **avoids a CloudFormation cycle**: HttpApi CORS `allowOrigins` needs the distribution domain, while the
     CSP in the distribution's response-headers policy needs the API URL.
  3. A WAF on the distribution covers the API, which HTTP APIs cannot take directly.
- The direct execute-api URL still exists behind the same JWT gate. Disabling it needs a custom domain.
- **Option B** (D1, local only) uses the same SPA code. The Vite proxy plays the CloudFront `/api` role (§4.6).

### 4.4 Response headers policy (default behavior)
- **CSP** (about 420 characters, under CloudFront's CSP length quota; the exact quota is *unverified*):
  ```
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self' data:;
  connect-src 'self' https://<cognito-domain>; manifest-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none';
  upgrade-insecure-requests
  ```
  The managed-login redirects are top-level navigations, which `form-action`/`connect-src` do not govern.
- **Other headers:**
  - HSTS `max-age=63072000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer` (the callback URL carries `code`)
  - custom `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Resource-Policy: same-origin`
- **`/api/*` behavior:** HSTS, nosniff and Referrer-Policy. Lambda adds `cache-control: no-store`.
- **cdk-nag** will flag `AwsSolutions-CFR1/2/3/4` (geo, WAF, logging, TLS with the default certificate) and
  `S1/S10`. Each needs a fix or an acknowledgement with a reason.

### 4.5 Deploy order (exposure check before data exists)
- The shell, `config.json` and the licence file are **public by design**: no data, no secrets. Verify them
  inversely: an anonymous GET of `/`, a deep link and `/config.json` must succeed.
- API data is restricted:
  1. Deploy the API and its authorizer before any user or data exists.
  2. Make an anonymous request to every `/api/*` route through CloudFront **and** directly.
  3. Require the JWT authorizer's own 401 (`{"message":"Unauthorized"}`), distinct from a 404 for a missing route.
  4. Only then create users or write config and records.
- Direct GETs on the bucket's S3 endpoints must return S3 `AccessDenied`.

### 4.6 Local development (and D1 option B)
- **Vite:**
  ```
  server:  { host: '127.0.0.1', port: 5173, strictPort: true,
             proxy: { '/api': { target: '<apiUrl>', changeOrigin: true } } }
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers: { <prod CSP + headers> } }
  ```
  - `changeOrigin` sets Host to the execute-api host.
  - **No `--host` flag** in any script.
  - The browser opens `http://127.0.0.1:5173`, which matches both the bind and the registered `console-local`
    callback (§2.2). Do not use `localhost`: it can resolve to `::1`, which the IPv4 bind does not serve.
- **Local config:**
  - `pnpm --filter @auto-router/console-web config:local` writes `public/config.json` from the stack outputs
    (`cdk deploy --outputs-file`). The file is gitignored: it names a pool and region.
  - The dev server sends no CSP: Vite HMR needs inline styles and a websocket.
- **The production CSP is exercised by `vite preview`**, which the Playwright smoke uses (§4.7).
- **Note for cli-login (not mine):** the same rule covers the CLI. 17's `http://127.0.0.1:<registered port>/callback`
  is allowed. Ports must be registered exactly.

### 4.7 Tests
- **Unit and component (`pnpm test`):**
  - Stack: vitest 5.1.0 with `environment: 'jsdom'` (jsdom 31.0.0), `@testing-library/react` 16.3.3,
    `@testing-library/dom` 10.4.2, `@testing-library/user-event` 14.6.8.
  - Cloudscape's `@cloudscape-design/components/test-utils/dom` wrappers give stable selectors for Table, Select,
    PropertyFilter and the rest.
  - Cover:
    - i18n parity and ICU validity;
    - formatters;
    - the API wrapper: 401 refresh-and-retry, 403, 412, timeout;
    - callback `url_state` validation;
    - `RequireGroup`;
    - each page rendering in en and zh-CN from fixtures;
    - savings figures matching 0d's hand-calculated fixture.
  - React 19 + Cloudscape under **jsdom** is not yet exercised (M covered Chromium only). The first scaffold test
    confirms it, including ResizeObserver needs.
- **Playwright smoke (`pnpm --filter @auto-router/console-web e2e`, not part of `pnpm test`):**
  - Setup:
    - `@playwright/test` 1.65.0; Chromium is installed by `playwright install chromium`;
    - `webServer: vite preview` on 127.0.0.1:4173 with the production headers.
  - **Fakes at the network level** with `page.route`:
    - `config.json` points at `https://idp.test`;
    - `/oauth2/authorize` returns a 302 to the callback with a code;
    - `/oauth2/token` returns fake JWTs. Unsigned is fine: the SPA does not verify, the real API does;
    - `/api/**` returns fixtures.
  - The **production bundle runs unchanged**: no auth-bypass flag or code ships.
  - Assertions:
    - the authorize URL carries `code_challenge_method=S256`, `state` and `lang`;
    - the callback succeeds;
    - admin and member navigation differ, and the 403 page appears;
    - the language switch persists across reloads;
    - dark mode works;
    - **no CSP violation or console error**;
    - axe reports nothing serious or critical.
  - Results and screenshot directories are gitignored, following the existing `/packages/panel/tests/e2e/...`
    entries.

## 5. Scaffold plan (no code yet)

### 5.1 Dependencies (exact pins, repo `.npmrc save-exact=true`)
- **Runtime:**
  - `react` 19.3.1, `react-dom` 19.3.1
  - `@cloudscape-design/components` 3.0.1410, `@cloudscape-design/global-styles` 1.0.72,
    `@cloudscape-design/collection-hooks` 1.0.111
  - `react-router` 8.5.1, `@tanstack/react-query` 5.107.1
  - `oidc-client-ts` 3.5.0, `intl-messageformat` 10.7.18
  - `@auto-router/core` `workspace:*` (the `./policy` subpath only)
- **Dev:**
  - `vite` 8.3.6, `@vitejs/plugin-react` 6.2.1
  - `@types/react` 19.3.0, `@types/react-dom` 19.3.0
  - `jsdom` 31.0.0, `@testing-library/react` 16.3.3, `@testing-library/dom` 10.4.2,
    `@testing-library/user-event` 14.6.8
  - `@playwright/test` 1.65.0, `@axe-core/playwright` 4.14.0
  - `typescript` and `vitest` come from the root.
- Re-check the versions at scaffold time: Cloudscape publishes almost daily.

### 5.2 Scripts
```
dev            vite                              # 127.0.0.1:5173 from vite.config.ts
build          vite build && node scripts/licenses.ts && node scripts/build-info.ts
preview        vite preview                      # 127.0.0.1:4173, prod headers
typecheck      tsc -p tsconfig.json --noEmit
test           vitest run
e2e            playwright test
config:local   node scripts/write-local-config.ts <cdk-outputs.json>
```

### 5.3 File tree
```
packages/console-web/
  package.json  tsconfig.json  vite.config.ts  vitest.config.ts  playwright.config.ts  index.html  README.md
  public/favicon.svg                  (config.json generated, gitignored)
  scripts/ write-local-config.ts  licenses.ts  build-info.ts  security-headers.ts (one source for preview + CDK)
  src/
    main.tsx                          load config → auth → render
    app/ App.tsx  routes.tsx (lazy)  Layout.tsx (AppLayout, TopNavigation, SideNavigation)
         Forbidden.tsx  NotFound.tsx  SignedOut.tsx  ConfigError.tsx
    config/ runtime-config.ts (+ .test.ts)
    auth/ user-manager.ts (static Cognito metadata)  AuthProvider.tsx  RequireGroup.tsx  groups.ts
          sign-out.ts  return-to.ts (+ tests)
    api/ client.ts  errors.ts  contract.ts (re-exports shared types)  queries/*.ts (+ tests)
    i18n/ en.json  zh-CN.json  I18n.tsx (useT)  format.ts  cloudscape-messages.ts  messages.test.ts  format.test.ts
    prefs/ theme.ts  density.ts  language.ts
    components/ charts/{UsageChart,CostChart,SavingsChart,ChartTableToggle}.tsx  CopyBlock.tsx  JsonEditor.tsx
                ConfigDiff.tsx  Money.tsx  Tokens.tsx  UtcTime.tsx
    pages/ overview/ usage/ savings/ decisions/ (+ session timeline) get-started/ settings/
           admin/{members,service-clients,policy,assessor,gateway,audit,health}/
    test/ setup.ts  fixtures/
  e2e/ smoke.spec.ts  fakes.ts (IdP + API routes)  headers.spec.ts (CSP/no-violation)
```
- `scripts/security-headers.ts` is shared so the CSP that `vite preview` serves is the one CDK puts in the
  response-headers policy. Infra imports it, the way `infra` already depends on workspace packages.

### 5.4 Infra pieces this implies (owner 0c/a3; listed, not designed here)
- A console construct: bucket, OAC distribution, CloudFront Function, response-headers policy, two
  BucketDeployments and `config.json`.
- The `console` and optional `console-local` app clients.
- The `<prefix>/console` scope.
- Managed login v2 on the domain, plus branding styles.
- The `/api/*` behavior.

## 6. Open points for 0c
1. Confirm same-origin `/api/*` through CloudFront: console-api routes go under `/api`, and the D1 option A
   wording changes from "HTTP API public" to "HTTP API behind the same distribution".
2. Confirm the scope name `<prefix>/console`, and stable error `code`s in console-api responses (a3).
3. Add a `./policy` subpath export in `@auto-router/core` (0c/0d).
4. Switching the domain to managed login v2: confirm the M2M client is unaffected (identity spike).
5. Choose the `tokenStorage` default: `session` (recommended) or `memory` (user/0c).
6. 4f: deliver the copy deck as flat dotted keys with ICU values, en as the source of truth.
