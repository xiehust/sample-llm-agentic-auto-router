import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { highlightPlaceholders, placeholdersIn } from './blocks.tsx'
import * as S from '../pages/getstarted-snippets.ts'

describe('snippet placeholders', () => {
  it('finds <name> tokens once each, and ignores code that only uses < or >', () => {
    expect(placeholdersIn('a <you> b <you> c <Codex callback port>')).toEqual(['you', 'Codex callback port'])
    expect(placeholdersIn("def f() -> str:\n    x = a > b and c < d\n    # anthropic>=2")).toEqual([])
    expect(placeholdersIn('TOKEN=$(llmar-token) <<EOF')).toEqual([])
  })

  it('highlights each placeholder and keeps the rest of the text byte for byte', () => {
    const code = 'command = "/home/<you>/bin/llmar-token"\nredirect_port = <Codex callback port>'
    const { container } = render(<pre>{highlightPlaceholders(code)}</pre>)
    expect([...container.querySelectorAll('mark[data-testid="placeholder"]')].map((m) => m.textContent)).toEqual(['<you>', '<Codex callback port>'])
    expect(container.textContent).toBe(code)
  })

  it('the Codex snippet asks only for <you> when the deployment provides every value', () => {
    const setup = { inferenceUrl: 'https://gw.example/inference', authorizeEndpoint: 'https://d.example/oauth2/authorize',
      tokenEndpoint: 'https://d.example/oauth2/token', clientId: 'cli123', scope: 'llmar/invoke', codexOauthPort: 52820 }
    const v = S.snippetValues(setup as never, 'https://raw.example/llmar')
    expect(placeholdersIn(S.codex(v))).toEqual([S.USER_PLACEHOLDER])
    expect(S.codex(v)).toContain('redirect_port = 52820')
    const missing = S.snippetValues({ ...setup, codexOauthPort: undefined } as never, undefined)
    expect(placeholdersIn(S.codex(missing))).toContain('Codex callback port')
    expect(placeholdersIn(S.install(missing))).toEqual([S.CLI_RAW_URL_PLACEHOLDER])
    for (const n of placeholdersIn(S.codex(missing)).filter((x) => x !== S.USER_PLACEHOLDER)) expect(S.DEPLOYMENT_PLACEHOLDERS.has(n)).toBe(true)
    expect(S.HOME_SED).toBe('sed -i "s#/home/<you>#$HOME#" ~/.codex/config.toml')
    // Headless Linux hint ships in the snippet, commented out (the OS keyring is the better store where it exists).
    expect(S.codex(v)).toMatch(/^# credentials_store = "file" .*keyring/m)
    expect(S.sshForward(52817, 52820)).toBe('ssh -L 52817:127.0.0.1:52817 -L 52820:127.0.0.1:52820 <host>')
    expect(placeholdersIn(S.sshForward(52817, 52820))).toEqual(['host'])
    // Claude Code must not fall back to its own Bedrock setup (CLAUDE_CODE_USE_BEDROCK wins over ANTHROPIC_BASE_URL).
    expect(JSON.parse(S.claudeCode(v)).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: setup.inferenceUrl })
  })
})
