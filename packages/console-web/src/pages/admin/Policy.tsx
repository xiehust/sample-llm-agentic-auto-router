// Routing policy (4f §4.9): edit the model mapping as a form or as JSON, validate with the router's own validators
// (server), save a draft, activate with a comment after reviewing the diff and policySwapEffects, roll back from
// Versions. Optimistic lock on the active version the editor started from.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Checkbox from '@cloudscape-design/components/checkbox'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Modal from '@cloudscape-design/components/modal'
import RadioGroup from '@cloudscape-design/components/radio-group'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Tabs from '@cloudscape-design/components/tabs'
import Textarea from '@cloudscape-design/components/textarea'
import Toggle from '@cloudscape-design/components/toggle'
import type { Cap, ConfigDocument, ConfigState, Dialect, GroupName, SwapEffect, Tier, ValidateResponse } from '@auto-router/console-contract'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../../api/client.ts'
import { useActivate, useConfig, useDiscardDraft, useSaveDraft, useValidateConfig } from '../../api/hooks.ts'
import { useFlash } from '../../app/flash.tsx'
import { compact, lineDiff } from '../../components/diff.ts'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { EffectivePanel, EffectiveValue } from '../../components/effective.tsx'
import { ErrorState, QueryView, useMutationErrorText } from '../../components/states.tsx'
import { Mono, useTime, WithPii } from '../../components/values.tsx'
import { parseDocument, shapeValidator } from '../../config/local-validation.ts'
import { useI18n } from '../../i18n/I18n.tsx'
import type { MessageKey } from '../../i18n/messages.ts'
import { shortModel } from '../scope.ts'

const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const GROUPS: GroupName[] = ['admin', 'member', 'service']

interface PoolEntry { model: string; tier?: Tier; failover?: string[] }
interface PolicyView {
  mode?: 'observe' | 'auto'
  userTurn?: 'cost-gated' | 'retain'
  sessionTier?: 'root'
  pools?: Partial<Record<Dialect, { defaultTier: Tier; models: PoolEntry[] }>>
  observeDefaults?: Partial<Record<Dialect, string>>
  aliases?: Record<string, Tier | 'default'>
  rules?: unknown[]
  gate?: { contextHeadroom?: number }
  cache?: { ttlSafetyMarginMs?: number; writeTtl?: Record<string, string> }
  hysteresis?: { costRatio?: number; minUsd?: number; minTurnsBeforeSwitch?: number; maxSwitchesPerLineage?: number }
  horizon?: { calls?: number; appendTokensPerCall?: number; outputTokensPerCall?: number }
  compaction?: { shrinkRatio?: number }
  failover?: { windowMs?: number; profileRotateOn?: number[] }
  portability?: Record<string, string>
  [k: string]: unknown
}

const pretty = (d: ConfigDocument) => JSON.stringify(d, null, 2)

export default function Policy() {
  const { t } = useI18n()
  const q = useConfig()
  if (q.data) return <Editor s={q.data} />
  // Loading or failed: the page keeps its heading; a 404/503 is an inline state, not a bare page (0c, phase 2).
  return <ContentLayout header={<Header variant="h1" description={t('policy.description')}>{t('policy.title')}</Header>}><QueryView q={q} notFound="config">{() => null}</QueryView></ContentLayout>
}

function Editor({ s }: { s: ConfigState }) {
  const { t } = useI18n()
  const flash = useFlash()
  const nav = useNavigate()
  const time = useTime()
  // New drafts start from the effective document (all sections filled from the deploy defaults); absent while a
  // section is unknown, then from the active version as written (73).
  const clean = s.effective?.document ?? s.active.document
  const start = s.draft?.document ?? clean
  const [doc, setDoc] = useState<ConfigDocument>(() => structuredClone(start))
  const [base, setBase] = useState<string>(s.draft?.baseVersion ?? s.active.version)
  const [json, setJson] = useState(pretty(start))
  const [jsonError, setJsonError] = useState<string | undefined>()
  const [tab, setTab] = useState('form')
  const [result, setResult] = useState<ValidateResponse | undefined>()
  const [activating, setActivating] = useState(false)
  const [conflict, setConflict] = useState<string | undefined>()
  const validate = useValidateConfig()
  const save = useSaveDraft()
  const discard = useDiscardDraft()
  const policy = doc.policy as PolicyView
  const dirty = pretty(doc) !== pretty(clean)
  const local = useMemo(() => shapeValidator.check(doc), [doc])

  // Keep the JSON tab in step with the form.
  useEffect(() => { if (tab !== 'json') setJson(pretty(doc)) }, [doc, tab])
  useEffect(() => { setResult(undefined) }, [doc])

  const setPolicy = (fn: (p: PolicyView) => void) => setDoc((cur) => { const next = structuredClone(cur); fn(next.policy as PolicyView); return next })
  const setAccess = (g: GroupName, cap: Cap | undefined) => setDoc((cur) => { const next = structuredClone(cur); if (cap) next.access.groups[g] = cap; else delete next.access.groups[g]; return next })
  const universe = (d: Dialect) => s.universe.filter((m) => s.catalog.models.find((x) => x.modelId === m)?.dialects.includes(d))
  const tierOf = (m: string) => s.catalog.models.find((x) => x.modelId === m)?.tier

  const applyJson = () => {
    const r = parseDocument(json)
    if (r.error || !r.doc) { setJsonError(r.error); return }
    setJsonError(undefined)
    setDoc(r.doc)
  }

  const errorText = useMutationErrorText()
  const runValidate = () => validate.mutate({ document: doc }, { onSuccess: setResult, onError: (e) => flash.push({ type: 'error', content: errorText(e) }) })

  const router = s.router
  return (
    <ContentLayout header={
      <Header variant="h1" description={t('policy.description')} actions={
        <SpaceBetween direction="horizontal" size="xs">
          {s.draft && <Button loading={discard.isPending} onClick={() => discard.mutate(undefined, { onSuccess: (st) => { setDoc(structuredClone(st.effective?.document ?? st.active.document)); setBase(st.active.version) } })}>{t('config.discardDraft')}</Button>}
          <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ document: doc, baseVersion: base }, { onSuccess: () => flash.push({ type: 'success', content: t('config.saveDraft') }) })}>{t('config.saveDraft')}</Button>
          <Button disabled={local.length > 0} loading={validate.isPending} onClick={runValidate}>{t('config.validate')}</Button>
          <Button variant="primary" disabled={!dirty || local.length > 0} onClick={() => { runValidate(); setActivating(true) }}>{t('config.activate')}</Button>
        </SpaceBetween>
      }>{t('policy.title')}</Header>
    }>
      <SpaceBetween size="l">
        <Container>
          <ColumnLayout columns={3} variant="text-grid">
            <div><Box variant="awsui-key-label">{t('config.activeVersion', { version: s.active.version })}</Box><Box><WithPii kind="author" text={t('config.by', { author: s.active.author, time: time(s.active.createdAt) })} value={s.active.author} /></Box><Box color="text-body-secondary">{s.active.comment}</Box></div>
            <div>
              <Box variant="awsui-key-label">{t('ext.policy.routerState')}</Box>
              {router.status === 'active' && <StatusIndicator type="success">{t('enum.configState.active', { time: router.since ? new Date(router.since).toLocaleString() : '' })}</StatusIndicator>}
              {router.status === 'pending' && <StatusIndicator type="in-progress">{t('enum.configState.pending')}</StatusIndicator>}
              {router.status === 'rejected' && <StatusIndicator type="error">{t('config.rejected', { active: router.reportedVersion ?? '?', reason: (router.issues ?? []).join(', ') })}</StatusIndicator>}
            </div>
            <div><Box variant="awsui-key-label">{t('policy.mode')}</Box>{s.effective
              ? <EffectiveValue s={s.effective.routerMode} render={(m) => t(`enum.mode.${m}`)} />
              : <Box>{t(`enum.mode.${(s.active.document.policy as PolicyView).mode ?? 'observe'}`)}</Box>}</div>
          </ColumnLayout>
        </Container>
        <EffectivePanel s={s} />
        <DeliveryBanner d={s.delivery} kind="config" />
        {conflict && <Alert type="warning" action={<Button onClick={() => nav('/admin/config/versions')}>{t('config.versions')}</Button>}>{t('config.conflict', { version: conflict })}</Alert>}
        {local.length > 0 && <Alert type="error" header={t('config.invalid', { count: local.length })}>{local.map((m) => <div key={m}><Mono>{m}</Mono></div>)}</Alert>}
        {result && <ValidationResult r={result} />}
        <Tabs activeTabId={tab} onChange={(e) => { if (tab === 'json' && e.detail.activeTabId !== 'json') applyJson(); setTab(e.detail.activeTabId) }} tabs={[
          { id: 'form', label: t('policy.tab.form'), content: (
            <SpaceBetween size="l">
              <Container header={<Header variant="h2" description={t('policy.mode.help')}>{t('policy.mode')}</Header>}>
                <SpaceBetween size="s">
                  <RadioGroup value={policy.mode ?? 'observe'} onChange={(e) => setPolicy((p) => { p.mode = e.detail.value as 'observe' | 'auto' })} items={[{ value: 'observe', label: t('enum.mode.observe') }, { value: 'auto', label: t('enum.mode.auto') }]} />
                  {policy.mode === 'auto' && (s.active.document.policy as PolicyView).mode !== 'auto' && <Alert type="warning">{t('policy.autoWarning')}</Alert>}
                </SpaceBetween>
              </Container>
              <Container header={<Header variant="h2">{t('policy.pools')}</Header>}>
                <SpaceBetween size="l">
                  {DIALECTS.filter((d) => policy.pools?.[d]).map((d) => {
                    const pool = policy.pools![d]!
                    return (
                      <SpaceBetween key={d} size="s">
                        <Box variant="h3">{t('policy.pool.dialect', { dialect: t(`enum.dialect.${d}`) })}</Box>
                        <FormField label={t('policy.pool.defaultTier')}>
                          <Select ariaLabel={`${t('policy.pool.defaultTier')} ${d}`} selectedOption={{ value: pool.defaultTier, label: t(`enum.tier.${pool.defaultTier}`) }} options={TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))} onChange={(e) => setPolicy((p) => { p.pools![d]!.defaultTier = e.detail.selectedOption.value as Tier })} />
                        </FormField>
                        {pool.models.map((m, i) => (
                          <ColumnLayout key={`${d}-${i}`} columns={4}>
                            <FormField label={t('policy.pool.model')}>
                              <Select filteringType="auto" ariaLabel={`${t('policy.pool.model')} ${d} ${i + 1}`} selectedOption={{ value: m.model, label: shortModel(m.model) }} options={universe(d).map((x) => ({ value: x, label: shortModel(x), description: tierOf(x) }))} onChange={(e) => setPolicy((p) => { p.pools![d]!.models[i]!.model = e.detail.selectedOption.value as string })} />
                            </FormField>
                            <FormField label={t('policy.pool.tier')}>
                              <Select ariaLabel={`${t('policy.pool.tier')} ${d} ${i + 1}`} selectedOption={{ value: m.tier ?? '', label: m.tier ? t(`enum.tier.${m.tier}`) : `${t('policy.aliases.default')} (${tierOf(m.model) ?? '?'})` }}
                                options={[{ value: '', label: `${t('policy.aliases.default')} (${tierOf(m.model) ?? '?'})` }, ...TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))]}
                                onChange={(e) => setPolicy((p) => { const v = e.detail.selectedOption.value as Tier | ''; if (v) p.pools![d]!.models[i]!.tier = v; else delete p.pools![d]!.models[i]!.tier })} />
                            </FormField>
                            <FormField label={t('policy.pool.failover')}>
                              <Input ariaLabel={`${t('policy.pool.failover')} ${d} ${i + 1}`} value={(m.failover ?? []).join(', ')} onChange={(e) => setPolicy((p) => { const v = e.detail.value.split(/[\s,]+/).filter(Boolean); if (v.length) p.pools![d]!.models[i]!.failover = v; else delete p.pools![d]!.models[i]!.failover })} />
                            </FormField>
                            <Box padding={{ top: 'xl' }}><Button iconName="remove" variant="icon" ariaLabel={`${t('common.delete')} ${m.model}`} disabled={pool.models.length < 2} onClick={() => setPolicy((p) => { p.pools![d]!.models.splice(i, 1) })} /></Box>
                          </ColumnLayout>
                        ))}
                        <div><Button iconName="add-plus" onClick={() => setPolicy((p) => { const free = universe(d).find((x) => !p.pools![d]!.models.some((y) => y.model === x)); if (free) p.pools![d]!.models.push({ model: free }) })}>{t('policy.pool.addModel')}</Button></div>
                      </SpaceBetween>
                    )
                  })}
                </SpaceBetween>
              </Container>
              <Container header={<Header variant="h2" description={t('policy.observeDefaults.help')}>{t('policy.observeDefaults')}</Header>}>
                <ColumnLayout columns={3}>
                  {DIALECTS.filter((d) => policy.pools?.[d]).map((d) => {
                    const opts = [{ value: '', label: `${t('policy.aliases.default')}` }, ...policy.pools![d]!.models.map((m) => ({ value: m.model, label: shortModel(m.model) }))]
                    const v = policy.observeDefaults?.[d] ?? ''
                    return (
                      <FormField key={d} label={t(`enum.dialect.${d}`)}>
                        <Select selectedOption={opts.find((o) => o.value === v) ?? null} options={opts} onChange={(e) => setPolicy((p) => { const x = e.detail.selectedOption.value as string; p.observeDefaults ??= {}; if (x) p.observeDefaults[d] = x; else delete p.observeDefaults[d] })} />
                      </FormField>
                    )
                  })}
                </ColumnLayout>
              </Container>
              <Container header={<Header variant="h2" description={t('policy.aliases.help')}>{t('policy.aliases')}</Header>}>
                <AliasesEditor aliases={policy.aliases ?? {}} onChange={(a) => setPolicy((p) => { p.aliases = a })} />
              </Container>
              <Container header={<Header variant="h2" description={t('policy.rules.help')}>{t('policy.rules')}</Header>}>
                <JsonField value={policy.rules ?? []} label={t('policy.rules')} onChange={(v) => setPolicy((p) => { p.rules = v as unknown[] })} />
              </Container>
              <Container header={<Header variant="h2" description={t('access.help')}>{t('access.title')}</Header>}>
                <SpaceBetween size="s">
                  <Box color="text-body-secondary">{t('access.precedence')}</Box>
                  <ColumnLayout columns={3}>
                    {GROUPS.map((g) => {
                      const cap = doc.access.groups[g]
                      const opts = [{ value: '', label: t('access.none') }, ...TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))]
                      return (
                        <SpaceBetween key={g} size="xs">
                          <FormField label={g === 'service' ? t('ext.access.group.service') : t(`access.group.${g}`)}>
                            <Select selectedOption={opts.find((o) => o.value === (cap?.maxTier ?? '')) ?? null} options={opts} onChange={(e) => { const v = e.detail.selectedOption.value as Tier | ''; setAccess(g, v || cap?.allowPins?.length ? { ...(v ? { maxTier: v } : {}), ...(cap?.allowPins?.length ? { allowPins: cap.allowPins } : {}) } : undefined) }} />
                          </FormField>
                          <FormField label={t('access.allowPins')} description={t('access.allowPins.help')}>
                            <Input value={(cap?.allowPins ?? []).join(', ')} onChange={(e) => { const pins = e.detail.value.split(/[\s,]+/).filter(Boolean); setAccess(g, cap?.maxTier || pins.length ? { ...(cap?.maxTier ? { maxTier: cap.maxTier } : {}), ...(pins.length ? { allowPins: pins } : {}) } : undefined) }} />
                          </FormField>
                        </SpaceBetween>
                      )
                    })}
                  </ColumnLayout>
                </SpaceBetween>
              </Container>
              <ExpandableSection variant="container" headerText={t('policy.advanced')}>
                <AdvancedEditor p={policy} set={setPolicy} />
              </ExpandableSection>
            </SpaceBetween>
          ) },
          { id: 'json', label: t('policy.tab.json'), content: (
            <SpaceBetween size="s">
              <FormField label={t('policy.tab.json')} errorText={jsonError}>
                <div className="llmar-json"><Textarea rows={30} value={json} onChange={(e) => setJson(e.detail.value)} spellcheck={false} ariaLabel={t('policy.tab.json')} /></div>
              </FormField>
              <div><Button onClick={applyJson}>{t('common.apply')}</Button></div>
            </SpaceBetween>
          ) },
          { id: 'versions', label: t('policy.tab.versions'), content: <Box><Button onClick={() => nav('/admin/config/versions')}>{t('config.versions')}</Button></Box> },
          { id: 'whatif', label: t('policy.tab.whatIf'), disabled: false, content: <Box color="text-body-secondary">{t('policy.whatIf.later')}</Box> },
        ]} />
      </SpaceBetween>
      {activating && (
        <ActivateModal
          prev={s.active.document} next={doc} result={result} validating={validate.isPending} validateError={validate.error} baseVersion={base}
          onClose={() => setActivating(false)}
          onConflict={(v) => { setConflict(v); setActivating(false) }}
        />
      )}
    </ContentLayout>
  )
}

export function ValidationResult({ r }: { r: ValidateResponse }) {
  const { t } = useI18n()
  if (r.ok) return <Alert type="success">{t('config.valid')}{r.changed.length > 0 && ` ${t('config.changedSections')}: ${r.changed.join(', ')}`}</Alert>
  return (
    <Alert type="error" header={t('config.invalid', { count: r.issues.length })}>
      <SpaceBetween size="xxs">{r.issues.map((i, k) => <div key={k}><Mono>{t('config.error.path', { path: i.path || '/', message: i.message })}</Mono></div>)}</SpaceBetween>
    </Alert>
  )
}

/** Console copy for effects console-api adds (73); the others show their code and core's English detail. */
const EFFECT_COPY: Partial<Record<string, MessageKey>> = {
  'identity-weakened': 'ext.effects.identityWeakened',
  'identity-strengthened': 'ext.effects.identityStrengthened',
  'assessor-mode': 'ext.effects.assessorMode',
}

export function EffectsList({ effects }: { effects: SwapEffect[] }) {
  const { t } = useI18n()
  if (effects.length === 0) return <Box>{t('config.effects.none')}</Box>
  return (
    <SpaceBetween size="xxs">
      <Box>{t('config.effects.list', { count: effects.length })}</Box>
      {effects.map((e, i) => (
        e.effect === 'cannot-compare' ? (
          <Alert key={i} type="error" data-testid="effect-cannot-compare">
            <SpaceBetween size="xxs"><span>{t('config.effects.cannotCompare')}</span><Mono>{e.detail}</Mono></SpaceBetween>
          </Alert>
        ) : (
          <StatusIndicator key={i} type={e.severity === 'disruptive' ? 'error' : e.severity === 'warn' ? 'warning' : 'info'}>
            {EFFECT_COPY[e.effect] ? <span data-testid={`effect-${e.effect}`}>{t(EFFECT_COPY[e.effect] as MessageKey)} <Mono>{e.detail}</Mono></span> : <><Mono>{e.effect}</Mono> {e.detail}</>}{e.affected !== undefined ? ` (${e.affected})` : ''}
          </StatusIndicator>
        )
      ))}
    </SpaceBetween>
  )
}

export function DiffView({ a, b, label }: { a: string; b: string; label: string }) {
  const lines = compact(lineDiff(a, b))
  return (
    <pre className="llmar-diff" aria-label={label} tabIndex={0}>
      {lines.map((l, i) => <div key={i} className={l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : ''}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}</div>)}
    </pre>
  )
}

export function ActivateModal({ prev, next, result, validating, validateError, baseVersion, onClose, onConflict, rollbackOf }: {
  prev: ConfigDocument; next: ConfigDocument; result: ValidateResponse | undefined; validating: boolean; validateError?: unknown; baseVersion: string
  onClose: () => void; onConflict: (version: string) => void; rollbackOf?: string
}) {
  const { t } = useI18n()
  const flash = useFlash()
  const errorText = useMutationErrorText()
  const activate = useActivate()
  const [comment, setComment] = useState(rollbackOf ? `Roll back to ${rollbackOf}` : '')
  const [confirm, setConfirm] = useState(false)
  const disruptive = (result?.effects ?? []).some((e) => e.severity === 'disruptive')
  const ok = result?.ok === true && comment.trim().length > 0 && (!disruptive || confirm)
  const go = () => activate.mutate({ document: next, comment: comment.trim(), baseVersion, ...(disruptive ? { confirmDisruptive: true } : {}), ...(rollbackOf ? { rollbackOf } : {}) }, {
    onSuccess: (r) => { flash.push({ type: 'success', content: `${t('config.version', { version: r.version.version })} · ${t('config.activate.body')}` }); onClose() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'config-version-moved') onConflict(e.message.match(/\d+-\S+/)?.[0] ?? '')
      else flash.push({ type: 'error', content: errorText(e) })
    },
  })
  return (
    <Modal visible size="large" onDismiss={onClose} header={t('config.activate.title', { version: String((Number(baseVersion.split('-')[0]) || 0) + 1) })}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!ok} loading={activate.isPending} onClick={go}>{disruptive ? t('config.effects.confirm') : t('config.activate')}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <Box>{t('config.activate.body')}</Box>
        {validating && <StatusIndicator type="loading">{t('config.validate')}</StatusIndicator>}
        {!validating && !result && validateError !== undefined && validateError !== null && <ErrorState error={validateError} inline notFound="config" />}
        {result && !result.ok && <ValidationResult r={result} />}
        {result?.ok && (
          <SpaceBetween size="s">
            <Box variant="h3">{t('config.effects.title')}</Box>
            <EffectsList effects={result.effects} />
            {disruptive && <Checkbox checked={confirm} onChange={(e) => setConfirm(e.detail.checked)}>{t('config.effects.confirm')}</Checkbox>}
          </SpaceBetween>
        )}
        <FormField label={t('config.comment')} description={t('config.comment.required')}>
          <Input value={comment} onChange={(e) => setComment(e.detail.value)} ariaRequired />
        </FormField>
        <ExpandableSection headerText={t('config.diff')} defaultExpanded>
          <DiffView a={pretty(prev)} b={pretty(next)} label={t('config.diff')} />
        </ExpandableSection>
      </SpaceBetween>
    </Modal>
  )
}

function AliasesEditor({ aliases, onChange }: { aliases: Record<string, Tier | 'default'>; onChange: (a: Record<string, Tier | 'default'>) => void }) {
  const { t } = useI18n()
  const entries = Object.entries(aliases)
  const opts = [{ value: 'default', label: t('policy.aliases.default') }, ...TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))]
  const set = (list: Array<[string, Tier | 'default']>) => onChange(Object.fromEntries(list))
  return (
    <SpaceBetween size="xs">
      {entries.map(([name, target], i) => (
        <ColumnLayout key={i} columns={3}>
          <FormField label={t('policy.aliases.name')}><Input value={name} onChange={(e) => set(entries.map((x, k) => (k === i ? [e.detail.value, x[1]] : x)))} /></FormField>
          <FormField label={t('policy.aliases.target')}><Select selectedOption={opts.find((o) => o.value === target) ?? null} options={opts} onChange={(e) => set(entries.map((x, k) => (k === i ? [x[0], e.detail.selectedOption.value as Tier | 'default'] : x)))} /></FormField>
          <Box padding={{ top: 'xl' }}><Button variant="icon" iconName="remove" ariaLabel={`${t('common.delete')} ${name}`} onClick={() => set(entries.filter((_, k) => k !== i))} /></Box>
        </ColumnLayout>
      ))}
      <div><Button iconName="add-plus" onClick={() => set([...entries, [`auto:new${entries.length}`, 'default']])}>{t('policy.aliases')}</Button></div>
    </SpaceBetween>
  )
}

function JsonField({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2))
  const [err, setErr] = useState<string | undefined>()
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value])
  return (
    <FormField errorText={err}>
      <div className="llmar-json"><Textarea ariaLabel={label} rows={8} value={text} spellcheck={false} onChange={(e) => setText(e.detail.value)} onBlur={() => {
        try { onChange(JSON.parse(text)); setErr(undefined) } catch (e) { setErr((e as Error).message) }
      }} /></div>
    </FormField>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => setText(value === undefined ? '' : String(value)), [value])
  return (
    <FormField label={label}>
      <Input type="number" inputMode="decimal" value={text} onChange={(e) => setText(e.detail.value)} onBlur={() => onChange(text.trim() === '' ? undefined : Number(text))} />
    </FormField>
  )
}

function AdvancedEditor({ p, set }: { p: PolicyView; set: (fn: (p: PolicyView) => void) => void }) {
  const { t } = useI18n()
  const num = (section: 'gate' | 'cache' | 'hysteresis' | 'horizon' | 'compaction' | 'failover', key: string) => (v: number | undefined) => set((x) => {
    const sec = ((x[section] as Record<string, unknown> | undefined) ?? {})
    if (v === undefined || Number.isNaN(v)) delete sec[key]; else sec[key] = v
    x[section] = sec as never
  })
  return (
    <SpaceBetween size="m">
      <ColumnLayout columns={3}>
        <FormField label={t('policy.userTurn')}>
          <Select selectedOption={{ value: p.userTurn ?? 'cost-gated', label: t(`enum.userTurn.${p.userTurn ?? 'cost-gated'}`) }} options={(['cost-gated', 'retain'] as const).map((v) => ({ value: v, label: t(`enum.userTurn.${v}`) }))} onChange={(e) => set((x) => { x.userTurn = e.detail.selectedOption.value as 'cost-gated' | 'retain' })} />
        </FormField>
        <FormField label={t('policy.sessionTier')} description={t('policy.sessionTier.help')}>
          <Toggle checked={p.sessionTier === 'root'} onChange={(e) => set((x) => { if (e.detail.checked) x.sessionTier = 'root'; else delete x.sessionTier })}>{p.sessionTier === 'root' ? t('common.on') : t('common.off')}</Toggle>
        </FormField>
        <NumberField label={t('policy.gate.contextHeadroom')} value={p.gate?.contextHeadroom} onChange={num('gate', 'contextHeadroom')} />
        <NumberField label={t('policy.cache.ttlSafetyMarginMs')} value={p.cache?.ttlSafetyMarginMs} onChange={num('cache', 'ttlSafetyMarginMs')} />
        <NumberField label={`${t('policy.hysteresis')}: ${t('policy.hysteresis.costRatio')}`} value={p.hysteresis?.costRatio} onChange={num('hysteresis', 'costRatio')} />
        <NumberField label={`${t('policy.hysteresis')}: ${t('policy.hysteresis.minUsd')}`} value={p.hysteresis?.minUsd} onChange={num('hysteresis', 'minUsd')} />
        <NumberField label={`${t('policy.hysteresis')}: ${t('policy.hysteresis.minTurnsBeforeSwitch')}`} value={p.hysteresis?.minTurnsBeforeSwitch} onChange={num('hysteresis', 'minTurnsBeforeSwitch')} />
        <NumberField label={`${t('policy.hysteresis')}: ${t('policy.hysteresis.maxSwitchesPerLineage')}`} value={p.hysteresis?.maxSwitchesPerLineage} onChange={num('hysteresis', 'maxSwitchesPerLineage')} />
        <NumberField label={`${t('policy.horizon')}: ${t('policy.horizon.calls')}`} value={p.horizon?.calls} onChange={num('horizon', 'calls')} />
        <NumberField label={`${t('policy.horizon')}: ${t('policy.horizon.appendTokensPerCall')}`} value={p.horizon?.appendTokensPerCall} onChange={num('horizon', 'appendTokensPerCall')} />
        <NumberField label={`${t('policy.horizon')}: ${t('policy.horizon.outputTokensPerCall')}`} value={p.horizon?.outputTokensPerCall} onChange={num('horizon', 'outputTokensPerCall')} />
        <NumberField label={t('policy.compaction.shrinkRatio')} value={p.compaction?.shrinkRatio} onChange={num('compaction', 'shrinkRatio')} />
        <NumberField label={`${t('policy.failover')}: ${t('policy.failover.windowMs')}`} value={p.failover?.windowMs} onChange={num('failover', 'windowMs')} />
        <FormField label={`${t('policy.failover')}: ${t('policy.failover.profileRotateOn')}`}>
          <Input value={(p.failover?.profileRotateOn ?? []).join(', ')} onChange={(e) => set((x) => { const v = e.detail.value.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n)); x.failover = { ...(x.failover ?? {}), profileRotateOn: v } })} />
        </FormField>
      </ColumnLayout>
      <FormField label={t('policy.cache.writeTtl')}><JsonField value={p.cache?.writeTtl ?? {}} label={t('policy.cache.writeTtl')} onChange={(v) => set((x) => { x.cache = { ...(x.cache ?? {}), writeTtl: v as Record<string, string> } })} /></FormField>
      <FormField label={t('policy.portability')}><JsonField value={p.portability ?? {}} label={t('policy.portability')} onChange={(v) => set((x) => { x.portability = v as Record<string, string> })} /></FormField>
    </SpaceBetween>
  )
}
