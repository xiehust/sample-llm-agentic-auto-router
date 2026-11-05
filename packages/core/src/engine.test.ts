import { describe, expect, it } from 'vitest'
import { HAIKU, SONNET } from './__fixtures__/catalog.ts'
import {
  anthropicBody, assistantText, assistantToolUse, Conversation, EXPLORE_SYSTEM, Harness, MIN, SEC, T0, testPolicy, toolResult, userText,
  type Step,
} from './__fixtures__/traces.ts'
import { summarize, templateFamilyOf } from './summarize/index.ts'

describe('end-to-end: Claude Code-like session with a sub-agent and compaction', () => {
  it('produces the expected decision sequence and keeps lineages apart', async () => {
    const exploreFamily = templateFamilyOf(summarize('anthropic-messages', anthropicBody([], { system: EXPLORE_SYSTEM }), {}, T0))
    const hz = new Harness(testPolicy({ rules: [{ id: 'explore', when: { templateFamily: [exploreFamily] }, tier: 'fast' }] }))
    const steps: Array<{ who: string; step: Step }> = []
    let t = T0
    const main = new Conversation().push(userText(`Refactor the parser. ${'context '.repeat(10_000)}`))
    const run = async (who: string, body: unknown, dt: number) => {
      t += dt
      const step = await hz.cc(body, {}, { at: t })
      steps.push({ who, step })
      return step
    }

    await run('main', main.body(), 0)                                                    // 1 session start
    main.push(assistantToolUse('t1', 'rg parse'), toolResult('t1', 'src/parser.ts: ...'))
    await run('main', main.body(), 2 * SEC)                                               // 2 tool loop
    main.push(assistantToolUse('t2', 'Task: explore the tokenizer'))
    const sub = new Conversation({ system: EXPLORE_SYSTEM }).push(userText('Explore the tokenizer and report.'))
    await run('sub', sub.body(), 1 * SEC)                                                 // 3 sub-agent start (new lineage under the seen root)
    sub.push(assistantToolUse('s1', 'cat src/tokenizer.ts'), toolResult('s1', 'export function tokenize() {}'))
    await run('sub', sub.body(), 1 * SEC)                                                 // 4 sub-agent tool loop
    main.push(toolResult('t2', 'The tokenizer is a hand-written lexer.'))
    await run('main', main.body(), 20 * SEC)                                              // 5 main resumes with the Task result
    main.push(assistantText('Done, see diff.'), userText('Now add tests.'))
    await run('main', main.body(), 90 * SEC)                                              // 6 user turn
    const compacted = new Conversation().push(userText('<summary>Refactored parser; tests pending.</summary>'), assistantText('ok'), userText('continue'))
    await run('main', compacted.body(), 30 * SEC)                                         // 7 compaction
    compacted.push(assistantToolUse('t3', 'pnpm test'), toolResult('t3', 'all green'))
    await run('main', compacted.body(), 3 * SEC)                                          // 8 tool loop after compaction
    compacted.push(assistantText('Tests pass.'), userText('Thanks, one more thing.'))
    await run('main', compacted.body(), 10 * MIN)                                         // 9 idle > TTL

    expect(steps.map(({ who, step }) => `${who}:${step.decision.point}:${step.decision.action}:${step.decision.model}`)).toEqual([
      `main:session-start:initialize:${SONNET}`,
      `main:hard-lock-tool-loop:retain:${SONNET}`,
      `sub:subagent-start:initialize:${HAIKU}`,
      `sub:hard-lock-tool-loop:retain:${HAIKU}`,
      `main:hard-lock-tool-loop:retain:${SONNET}`,
      `main:user-turn:retain:${SONNET}`,
      `main:compaction:retain:${SONNET}`,
      `main:hard-lock-tool-loop:retain:${SONNET}`,
      `main:idle-expired:retain:${SONNET}`,
    ])
    const [m1, , s1] = steps
    expect(s1!.step.summary.session.root).toBe(m1!.step.summary.session.root)
    expect(s1!.step.summary.session.lineage).not.toBe(m1!.step.summary.session.lineage)
    expect(s1!.step.decision.reason).toContain('via rule:explore')
    expect(s1!.step.decision.reason).toMatch(/^subagent-start: new lineage under seen root, /)

    // The sub-agent never touched the parent's state.
    const mainState = (await hz.store.get(m1!.step.summary.session.lineage))!
    const subState = (await hz.store.get(s1!.step.summary.session.lineage))!
    expect(mainState).toMatchObject({ current: SONNET, calls: 7, turns: 4, switches: 0 })
    expect(Object.keys(mainState.perModel)).toEqual([SONNET])
    expect(subState).toMatchObject({ current: HAIKU, calls: 2, turns: 1, switches: 0 })

    // The provider behaved as predicted: no unexpected misses anywhere in the trace.
    expect(steps.filter(({ step }) => step.result.miss)).toEqual([])
  })
})
