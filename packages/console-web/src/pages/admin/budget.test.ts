// The default-budget form (Settings → Deployment): Save only when the form differs from the saved budget and is valid.

import type { Budget } from '@auto-router/console-contract'
import { describe, expect, it } from 'vitest'
import { budgetForm } from './DeploymentSettings.tsx'

const SAVED: Budget = { monthlyUsd: 200, alertAt: 0.8, hardStop: false }
const same = { on: true, usd: '200', alertAt: '80', hard: false }

describe('budgetForm', () => {
  it('the loaded budget unchanged is not dirty', () => {
    expect(budgetForm(SAVED, same)).toEqual({ next: SAVED, invalid: false, dirty: false })
  })

  it('each field change is dirty', () => {
    expect(budgetForm(SAVED, { ...same, usd: '250' }).dirty).toBe(true)
    expect(budgetForm(SAVED, { ...same, alertAt: '90' }).dirty).toBe(true)
    expect(budgetForm(SAVED, { ...same, hard: true }).dirty).toBe(true)
    expect(budgetForm(SAVED, { ...same, on: false })).toEqual({ next: null, invalid: false, dirty: true })
  })

  it('an equal value typed differently is not dirty', () => {
    expect(budgetForm(SAVED, { ...same, usd: '200.0', alertAt: '80.0' }).dirty).toBe(false)
  })

  it('no saved budget: off is not dirty, on is', () => {
    expect(budgetForm(undefined, { on: false, usd: '', alertAt: '80', hard: false }).dirty).toBe(false)
    expect(budgetForm(undefined, { on: true, usd: '100', alertAt: '80', hard: false })).toEqual({ next: { monthlyUsd: 100, alertAt: 0.8, hardStop: false }, invalid: false, dirty: true })
  })

  it('an amount that is not positive or a threshold outside 1–100 % is invalid; off never is', () => {
    for (const usd of ['', '0', '-5', 'abc']) expect(budgetForm(SAVED, { ...same, usd }).invalid).toBe(true)
    for (const alertAt of ['0', '101', '']) expect(budgetForm(SAVED, { ...same, alertAt }).invalid).toBe(true)
    expect(budgetForm(SAVED, { on: false, usd: '', alertAt: '', hard: false }).invalid).toBe(false)
  })
})
