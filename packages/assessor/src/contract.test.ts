// Compile-time contract checks against @auto-router/core (checked by `pnpm typecheck`; the runtime assertions
// only keep vitest from reporting an empty file). Core does not depend on the assessor.
import type { AssessorResult, CardContext, DecideExtras, Engine, RequestSummary, TierAssessor } from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createAssessor, type Assessor } from './assessor.ts'
import { buildCard, type CardBuildContext, type TaskCard } from './card.ts'
import { fakeTransport } from './transport.ts'

// createAssessor's return type is assignable to core's TierAssessor.
const asCore = (a: Assessor): TierAssessor => a
// assess() resolves to core's AssessorResult (costUsd included on 'ok').
type AssessReturn = Awaited<ReturnType<Assessor['assess']>>
const resultIsCore = (r: AssessReturn): AssessorResult => r
// buildCard accepts core's CardContext, and the card thunk fits core's DecideExtras.
const fromCoreCtx = (s: RequestSummary, body: unknown, ctx: CardContext): TaskCard => buildCard(s, body, ctx)
const ctxIsBuildCtx = (ctx: CardContext): CardBuildContext => ctx
const extras = (a: Assessor, s: RequestSummary, body: unknown): DecideExtras => ({ card: (ctx) => a.card(s, body, ctx) })
// The extras are what Engine.decide takes as its second argument.
type DecideSecondArg = Parameters<Engine['decide']>[1]
const extrasFitDecide = (x: DecideExtras): DecideSecondArg => x

describe('contract with @auto-router/core', () => {
  it('createAssessor returns a core TierAssessor whose ok results carry costUsd', () => {
    const a = createAssessor({ transport: fakeTransport([{ body: {} }]), catalog: loadCatalog() })
    expectTypeOf(a).toExtend<TierAssessor>()
    expectTypeOf<Extract<AssessorResult, { status: 'ok' }>['costUsd']>().toEqualTypeOf<number | undefined>()
    expect(asCore(a).id).toBe('assessor/v2.2@global.openai.gpt-6-luna')
    expect([resultIsCore, fromCoreCtx, ctxIsBuildCtx, extras, extrasFitDecide].every((f) => typeof f === 'function')).toBe(true)
  })
})
