// Decision detail (4f §4.4; 73 §3.4): request, decision with its basis, served model, usage and cost, assessor
// consultation (rule text from the pack archive by packVersion, not translated) and timing. Ids, codes and numbers only.

import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import type { AssessorRecord, PackEntry, RecordDetail } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { usePack, useRecord } from '../api/hooks.ts'
import { Captions } from '../components/blocks.tsx'
import { codeLabel, ruleTitle, toneStatus } from '../components/codes.ts'
import { NotFound, QueryView } from '../components/states.tsx'
import { Caller, Mono, Pct, TierBadge, Time } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { actionLabel, timelineHref } from './decisions-common.tsx'
import { shortModel, useBase } from './scope.ts'

type KV = { label: string; value: ReactNode }
const kv = (items: Array<KV | false | undefined | null | '' | 0>) => items.filter((x): x is KV => !!x)

export default function DecisionDetail() {
  const { reqId } = useParams()
  const [sp] = useSearchParams()
  const { base, admin } = useBase()
  const ts = sp.get('ts') ?? undefined
  const caller = sp.get('caller') ?? undefined
  const q = useRecord(base, reqId, { ...(ts ? { ts } : {}), ...(admin && caller ? { caller } : {}) })
  // Another caller's record and an expired one look the same: 404 (ids cannot be probed).
  if (q.error instanceof ApiError && q.error.notFound) return <NotFound />
  return <QueryView q={q}>{(r) => <Detail r={r} admin={admin} />}</QueryView>
}

function Detail({ r, admin }: { r: RecordDetail; admin: boolean }) {
  const { t, f, locale } = useI18n()
  const nav = useNavigate()
  const d = r.decision
  const reason = d?.code ? codeLabel('decision.reason', d.code, locale) : undefined
  const err = r.errorCode ? codeLabel('request.reason', r.errorCode, locale) : undefined
  const identity = r.identity?.startsWith('invalid:') ? t('enum.identityStatus.invalid', { code: r.identity.slice(8) }) : r.identity ? t(`enum.identityStatus.${r.identity as 'verified' | 'missing'}`) : undefined
  const u = r.usage
  return (
    <ContentLayout header={
      <Header variant="h1" description={<Time iso={r.ts} />} actions={
        <SpaceBetween direction="horizontal" size="xs">
          {r.session && <Button onClick={() => nav(timelineHref(r.session as string, r.caller?.key, admin))}>{t('decisions.openTimeline')}</Button>}
          <CopyToClipboard variant="button" textToCopy={r.reqId} copyButtonText={t('decisions.copyReqId')} copySuccessText={t('common.copied')} copyErrorText={t('state.error.title')} />
        </SpaceBetween>
      }>{t('decisions.title')} · <Box variant="code">{r.reqId}</Box></Header>
    }>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">{t('decision.section.request')}</Header>}>
          <KeyValuePairs columns={3} items={kv([
            { label: t('decision.reqId'), value: <Mono>{r.reqId}</Mono> },
            admin && { label: t('decisions.col.caller'), value: <Caller c={r.caller} /> },
            identity && { label: t('decision.identity'), value: identity },
            { label: t('decisions.col.session'), value: r.session ? <Mono>{r.session}</Mono> : '—' },
            { label: t('decision.lineage'), value: <Mono>{r.lineage}</Mono> },
            { label: t('decisions.col.dialect'), value: r.dialect ? t(`enum.dialect.${r.dialect}`) : '—' },
            { label: t('decisions.col.requested'), value: r.requested === 'other' ? t('decisions.requested.other') : <Mono>{r.requested}</Mono> },
            r.stream !== undefined && { label: t('decision.stream'), value: t(r.stream ? 'common.yes' : 'common.no') },
            r.bodyBytes !== undefined && { label: t('decision.bodyBytes'), value: f.int(r.bodyBytes) },
            !!r.hints?.length && { label: t('decision.hints'), value: r.hints.join(', ') },
            !!r.sanitized?.length && { label: t('decision.sanitized'), value: r.sanitized.join(', ') },
            { label: t('decisions.col.status'), value: <StatusIndicator type={r.status < 400 ? 'success' : r.status === 499 ? 'stopped' : 'error'}>{r.status} · {t(`enum.kind.${r.kind}`)}</StatusIndicator> },
            err && { label: t('decision.error'), value: <span title={err.desc}>{err.label} <Mono>{r.errorCode}</Mono></span> },
            r.clientAborted && { label: t('decisions.icon.aborted'), value: t('common.yes') },
          ])} />
        </Container>
        {d && (
          <Container header={<Header variant="h2">{t('decision.section.decision')}</Header>}>
            <SpaceBetween size="m">
              <KeyValuePairs columns={3} items={kv([
                { label: t('decisions.col.action'), value: actionLabel(t, d.action, locale) },
                { label: t('decisions.col.point'), value: t(`enum.point.${d.point}`) },
                { label: t('decision.mode'), value: t(`enum.mode.${d.mode}`) },
                { label: t('decision.model'), value: <Mono>{d.model}</Mono> },
                { label: t('decision.policyVersion'), value: <Mono>{d.policyVersion}</Mono> },
                r.configVersion && { label: t('decision.configVersion'), value: <Mono>{r.configVersion}</Mono> },
                { label: t('decision.reason'), value: reason ? <StatusIndicator type={toneStatus(reason.tone)}><span title={reason.desc}>{reason.label}</span></StatusIndicator> : t('enum.reasonCode.unknown') },
                d.source && { label: t('term.tier'), value: codeLabel('decision.source', d.source, locale).label },
                !!d.reasonFlags?.length && { label: t('common.details'), value: d.reasonFlags.map((x) => codeLabel('decision.flag', x, locale).label).join(', ') },
                r.tierLimit && { label: t('savings.capRow'), value: t('decision.cap', { maxTier: r.tierLimit.maxTier ?? '—' }) },
                d.wouldChoose && { label: t('decision.wouldChoose'), value: <Mono>{d.wouldChoose}</Mono> },
                d.projected && { label: t('savings.tab.projected'), value: t('decision.projected', { model: shortModel(d.projected.model) }) },
                d.estimate && { label: t('decision.estimate'), value: <SpaceBetween size="xxs"><span>{t('decision.estimate.stay', { usd: f.usdPrecise(d.estimate.stayUsd), calls: d.estimate.horizonCalls })}</span><span>{t('decision.estimate.switch', { usd: f.usdPrecise(d.estimate.switchUsd), calls: d.estimate.horizonCalls })}</span></SpaceBetween> },
              ])} />
              <ExpandableSection headerText={t('decision.routerDetail')}><Mono>{d.reason}</Mono></ExpandableSection>
            </SpaceBetween>
          </Container>
        )}
        <Container header={<Header variant="h2">{t('decision.section.served')}</Header>}>
          <KeyValuePairs columns={3} items={kv([
            { label: t('decisions.col.servedModel'), value: <Mono>{r.servedModel}</Mono> },
            { label: t('decisions.col.tier'), value: <TierBadge tier={r.tier} /> },
            r.switchedFrom && { label: t('timeline.marker.switch', { from: shortModel(r.switchedFrom.model), to: shortModel(r.servedModel) }), value: t('decision.switchedFrom', { model: shortModel(r.switchedFrom.model), tokens: f.compact(r.switchedFrom.warmTokens) }) },
            r.failoverDetail && { label: t('term.failover'), value: t('decision.failover', { from: shortModel(r.failoverDetail.from), to: shortModel(r.failoverDetail.to), status: String(r.failoverDetail.status) }) },
            r.servedDiffers && { label: t('decision.servedDiffers'), value: t('common.yes') },
            r.catalogVersion && { label: t('decision.catalogVersion'), value: <Mono>{r.catalogVersion}</Mono> },
          ])} />
        </Container>
        <Container header={<Header variant="h2">{t('decision.section.usage')}</Header>}>
          {u && r.cost ? (
            <KeyValuePairs columns={4} items={kv([
              { label: t('token.uncachedInput'), value: `${f.int(u.uncachedInputTokens)} · ${f.usdPrecise(r.cost.input)}` },
              { label: t('token.cacheRead'), value: `${f.int(u.cacheReadTokens)} · ${f.usdPrecise(r.cost.cacheRead)}` },
              { label: t('token.cacheWriteTotal'), value: `${Object.entries(u.cacheWriteTokens).map(([ttl, v]) => `${ttl} ${f.int(v ?? 0)}`).join(', ') || '0'} · ${f.usdPrecise(r.cost.cacheWrite)}` },
              { label: t('token.output'), value: `${f.int(u.outputTokens)}${u.reasoningTokens ? ` (${t('token.reasoning')} ${f.int(u.reasoningTokens)})` : ''} · ${f.usdPrecise(r.cost.output)}` },
              { label: t('decisions.col.cost'), value: <Box variant="strong">{f.usdPrecise(r.cost.total)}</Box> },
              { label: t('decision.costTier'), value: t(`enum.costTier.${r.cost.tier}`) },
              { label: t('decisions.col.hitRate'), value: <Pct v={r.hitRate} /> },
              r.missDetail && { label: t('decisions.icon.miss'), value: t('decision.miss', { reason: t(`enum.missReason.${r.missDetail.reason}`), expected: f.int(r.missDetail.expectedTokens), read: f.int(r.missDetail.readTokens) }) },
            ])} />
          ) : r.unmeteredBound ? (
            <Box>{t('decision.unmetered', { upperBound: f.usdPrecise(r.unmeteredBound.upperBoundUsd) })}{r.unmeteredBound.partial && ` · ${t('decision.unmetered.partial')}`}</Box>
          ) : <Box color="text-body-secondary">{t('common.notAvailable')}</Box>}
        </Container>
        {r.assessorDetail && <AssessorSection a={r.assessorDetail} />}
        {r.timing && (
          <Container header={<Header variant="h2">{t('decision.section.timing')}</Header>}>
            <KeyValuePairs columns={5} items={kv([
              r.timing.bodyReadMs !== undefined && { label: t('decision.timing.bodyRead'), value: f.ms(r.timing.bodyReadMs) },
              r.timing.decideMs !== undefined && { label: t('decision.timing.decide'), value: f.ms(r.timing.decideMs) },
              r.timing.overheadMs !== undefined && { label: t('decision.timing.overhead'), value: f.ms(r.timing.overheadMs) },
              r.timing.upstreamTtfbMs !== undefined && { label: t('decision.timing.ttfb'), value: f.ms(r.timing.upstreamTtfbMs) },
              r.timing.durationMs !== undefined && { label: t('decision.timing.duration'), value: f.ms(r.timing.durationMs) },
            ])} />
          </Container>
        )}
        <ExpandableSection headerText={t('decisions.showRaw')} variant="container">
          <pre className="llmar-diff" aria-label={t('decisions.showRaw')}>{JSON.stringify(r, null, 2)}</pre>
        </ExpandableSection>
        <Captions items={[t('caption.noContent')]} />
      </SpaceBetween>
    </ContentLayout>
  )
}

function AssessorSection({ a }: { a: AssessorRecord }) {
  const { t, f, locale } = useI18n()
  const pack = usePack(a.packVersion)
  const outcome = a.outcome ? codeLabel('assessor.outcome', a.outcome, locale) : undefined
  return (
    <Container header={<Header variant="h2">{t('decision.section.assessor')}</Header>}>
      <SpaceBetween size="m">
        <KeyValuePairs columns={4} items={kv([
          { label: t('decision.assessor.id'), value: <Mono>{a.id}</Mono> },
          a.packVersion && { label: t('decision.assessor.pack'), value: <Mono>{a.packVersion}</Mono> },
          { label: t('decision.mode'), value: `${t(`enum.mode.${a.mode}`)} · ${t(`enum.autoRules.${a.autoRules}`)}` },
          { label: t('decision.assessor.status'), value: t(`enum.assessorStatus.${a.status}`) },
          outcome && { label: t('decision.assessor.outcome'), value: <span title={outcome.desc}>{outcome.label}</span> },
          a.tier && { label: t('decision.assessor.tier'), value: <TierBadge tier={a.tier} /> },
          a.proposedTier && { label: t('decision.assessor.proposedTier'), value: <TierBadge tier={a.proposedTier} /> },
          a.confidence !== undefined && { label: t('decision.assessor.confidence'), value: a.threshold !== undefined ? t('decision.assessor.confidenceVsThreshold', { confidence: a.confidence, threshold: a.threshold }) : String(a.confidence) },
          a.guard && { label: t('decision.assessor.guard'), value: codeLabel('assessor.guard', a.guard, locale).label },
          { label: t('decision.assessor.applied'), value: t(a.applied ? 'common.yes' : 'common.no') },
          a.cached && { label: t('decision.assessor.cached'), value: t('common.yes') },
          a.called !== undefined && { label: t('decision.assessor.called'), value: t(a.called ? 'common.yes' : 'common.no') },
          { label: t('decision.assessor.latency'), value: f.ms(a.latencyMs) },
          a.costUsd !== undefined && { label: t('decision.assessor.cost'), value: f.usdPrecise(a.costUsd) },
        ])} />
        {!!a.basis?.length && (
          <SpaceBetween size="xs">
            <Box variant="h3">{t('decision.assessor.basis')}</Box>
            {a.basis.map((id) => <BasisItem key={id} id={id} pack={pack.data} packVersion={a.packVersion} />)}
            <Box variant="small" color="text-body-secondary">{t('decision.assessor.packText')}</Box>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </Container>
  )
}

function BasisItem({ id, pack, packVersion }: { id: string; pack: PackEntry | undefined; packVersion: string | undefined }) {
  const { t, locale } = useI18n()
  const rule = pack?.rules.find((r) => r.id === id)
  if (!rule) {
    const generic = codeLabel('assessor.basis', id, locale)
    if (generic.known) return <Box><Badge>{generic.label}</Badge> <Box variant="small" color="text-body-secondary">{generic.desc}</Box></Box>
    return <Box color="text-status-warning">{t('decision.assessor.basisUnknown', { id, pack: packVersion ?? '—' })}</Box>
  }
  return (
    <Box>
      <SpaceBetween size="xxs">
        <span><Box variant="strong">{ruleTitle(id, locale) ?? id}</Box> · {t('decision.assessor.basisRule', { id, tier: t(`enum.tier.${rule.tier}`) })} <TierBadge tier={rule.tier} /></span>
        <Box variant="small" fontSize="body-s"><span lang="en">“{rule.instruction}”</span> <Mono>{pack?.packVersion.split('+')[1]}</Mono></Box>
      </SpaceBetween>
    </Box>
  )
}
