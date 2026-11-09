// Get started (4f §4.6, §6): connect a client with this deployment's values. The console serves no files: llmar
// comes from the repository.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import Tabs from '@cloudscape-design/components/tabs'
import type { SetupInfo, Tier } from '@auto-router/console-contract'
import { useNavigate } from 'react-router'
import { useLatest, useSetup } from '../api/hooks.ts'
import { CodeBlock } from '../components/blocks.tsx'
import { QueryView } from '../components/states.tsx'
import { Mono, useTime } from '../components/values.tsx'
import { CLI_PATH, repoRawUrl } from '../config/links.ts'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'
import * as S from './getstarted-snippets.ts'
import { shortModel, useBase } from './scope.ts'

export default function GetStarted() {
  const q = useSetup()
  return <QueryView q={q}>{(s) => <Content s={s} />}</QueryView>
}

function Content({ s }: { s: SetupInfo }) {
  const { t } = useI18n()
  const { admin } = useBase()
  const nav = useNavigate()
  const time = useTime()
  const latest = useLatest()
  const v = S.snippetValues(s, repoRawUrl(CLI_PATH))
  // What to put in each highlighted placeholder (CodeBlock lists them under the snippet).
  const explain = (name: string) => name === S.USER_PLACEHOLDER
    ? <>{t('ext.code.replace.you')} <Box variant="code">{S.HOME_SED}</Box></>
    : name === 'host' ? t('ext.code.replace.host')
    : S.DEPLOYMENT_PLACEHOLDERS.has(name) ? t('ext.code.replace.deployment', { name }) : undefined
  const faq: Array<{ id: string; values?: Record<string, string | number>; code?: string; plain?: boolean }> = [
    { id: 'claudeBedrock', code: S.claudeEnvCheck },
    { id: 'claudeApiKey', code: S.unsetApiKey },
    { id: 'claudeModel' },
    { id: 'configure', code: S.configParentFix },
    { id: 'redirectPort', values: { port: s.codexOauthPort ?? '—' } },
    { id: 'gatewaySignIn', code: S.credentialsStoreLine },
    { id: 'ssh', code: S.sshForward(s.redirectPorts?.[0], s.codexOauthPort) },
    { id: 'path', code: S.HOME_SED, plain: true },
    { id: 'status2', values: { refreshDays: s.refreshDays ?? 30 } },
    { id: 'maxTokens' },
    { id: 'whichModel' },
    { id: 'metadata' },
  ]
  const missing = s.missing ?? []
  const notes = (keys: MessageKey[]) => <SpaceBetween size="xxs">{keys.map((k) => <Box key={k} variant="p">{t(k)}</Box>)}</SpaceBetween>
  const step = (title: MessageKey, body: React.ReactNode) => <Container header={<Header variant="h2">{t(title)}</Header>}><SpaceBetween size="s">{body}</SpaceBetween></Container>
  const aliasesOf = (tier: Tier) => Object.entries(s.aliases).filter(([, x]) => x === tier).map(([a]) => a)

  return (
    <ContentLayout header={<Header variant="h1" description={t('getStarted.intro')}>{t('getStarted.title')}</Header>}>
      <SpaceBetween size="l">
        {missing.length > 0 && (
          <Alert type="warning">{admin ? missing.map((name) => <div key={name}>{t('getStarted.values.missingAdmin', { name })}</div>) : t('getStarted.values.missing')}</Alert>
        )}
        <Container header={<Header variant="h2">{t('getStarted.values.title')}</Header>}>
          <KeyValuePairs columns={2} items={[
            { label: t('getStarted.values.gatewayUrl'), value: <Mono>{s.gatewayUrl}</Mono> },
            { label: t('getStarted.values.tokenEndpoint'), value: <Mono>{s.tokenEndpoint}</Mono> },
            { label: t('getStarted.values.clientId'), value: <Mono>{s.clientId}</Mono> },
            { label: t('getStarted.values.scope'), value: <Mono>{s.scope}</Mono> },
          ]} />
        </Container>
        {step('getStarted.step1.title', <>
          <Box variant="p">{t('getStarted.step1.body')}</Box>
          <CodeBlock explain={explain} label={t('getStarted.step1.title')} code={S.install(v)} />
          <Box variant="small" color="text-body-secondary">{t('getStarted.step1.source')}</Box>
        </>)}
        {step('getStarted.configure.title', <>
          <Box variant="p">{t('getStarted.configure.body')}</Box>
          <CodeBlock explain={explain} label={t('getStarted.configure.title')} code={S.configure(v)} />
        </>)}
        {step('getStarted.step2.title', <>
          <Box variant="p">{t('getStarted.step2.body')}</Box>
          <CodeBlock explain={explain} label={t('getStarted.step2.title')} code={S.signIn()} />
          {notes(['getStarted.step2.mfa', 'getStarted.step2.noBrowser', 'getStarted.step2.test'])}
          <Box variant="p">{t('getStarted.step2.again', { refreshDays: s.refreshDays })}</Box>
        </>)}
        {step('getStarted.step3.title', <>
          <Alert type="info">{t('getStarted.step3.identity')}</Alert>
          <Tabs tabs={[
            { id: 'claude', label: t('getStarted.tab.claudeCode'), content: <SpaceBetween size="s"><Box>{t('getStarted.claudeCode.where')}</Box><CodeBlock explain={explain} label={t('getStarted.tab.claudeCode')} code={S.claudeCode(v)} />{notes(['getStarted.claudeCode.token', 'getStarted.claudeCode.tiers', 'getStarted.claudeCode.countTokens', 'getStarted.claudeCode.refusal'])}</SpaceBetween> },
            { id: 'codex', label: t('getStarted.tab.codex'), content: <SpaceBetween size="s"><Box>{t('getStarted.codex.where')}</Box><CodeBlock explain={explain} label={t('getStarted.tab.codex')} code={S.codex(v)} />{notes(['getStarted.codex.auth', 'getStarted.codex.oauth'])}<Box variant="p">{t('getStarted.codex.ssh', { port: s.codexOauthPort ?? '<port>' })}</Box><Box variant="p">{t('getStarted.codex.keyring')}</Box><Box>{t('getStarted.codex.run')}</Box><CodeBlock explain={explain} label={t('getStarted.codex.run')} code={S.codexRun()} /><Box>{t('getStarted.codex.short')}</Box><CodeBlock explain={explain} label={t('getStarted.codex.short')} code={S.codexShort(v)} />{notes(['getStarted.codex.webSearch', 'getStarted.codex.warning'])}</SpaceBetween> },
            { id: 'anthropic', label: t('getStarted.tab.anthropicSdk'), content: <SpaceBetween size="s"><CodeBlock explain={explain} label={t('getStarted.tab.anthropicSdk')} code={S.anthropicSdk(v)} />{notes(['getStarted.sdk.token', 'getStarted.sdk.session', 'getStarted.sdk.decision', 'getStarted.sdk.stream'])}</SpaceBetween> },
            { id: 'openai', label: t('getStarted.tab.openaiSdk'), content: <SpaceBetween size="s"><CodeBlock explain={explain} label={t('getStarted.tab.openaiSdk')} code={S.openaiSdk(v)} />{notes(['getStarted.sdk.token', 'getStarted.sdk.session', 'getStarted.sdk.decision', 'getStarted.sdk.stream'])}</SpaceBetween> },
            { id: 'curl', label: t('getStarted.tab.curl'), content: <SpaceBetween size="s"><CodeBlock explain={explain} label={t('getStarted.tab.curl')} code={S.curl(v)} /><Box>{t('getStarted.curl.body')}</Box></SpaceBetween> },
          ]} />
        </>)}
        {step('getStarted.step4.title', <>
          <Box variant="p">{t('getStarted.step4.body')}</Box>
          <Box>{t(s.identityMode === 'require' ? 'getStarted.step4.require' : s.identityMode === 'off' ? 'getStarted.step4.off' : s.identityMode === 'unknown' ? 'ext.getStarted.step4.unknown' : 'getStarted.step4.observe')}</Box>
          <div><Button loading={latest.isPending} onClick={() => latest.mutate()}>{t('getStarted.step4.button')}</Button></div>
          {latest.data && (latest.data.record
            ? <StatusIndicator type="success">{t('getStarted.step4.found', { time: time(latest.data.record.ts), dialect: latest.data.record.dialect ? t(`enum.dialect.${latest.data.record.dialect}`) : '—', requested: latest.data.record.requested ?? '—', model: shortModel(latest.data.record.servedModel) })}</StatusIndicator>
            : <StatusIndicator type="warning">{t('getStarted.step4.notFound')}</StatusIndicator>)}
          {latest.error && <StatusIndicator type="error">{t('state.error.title')}</StatusIndicator>}
        </>)}
        <ExpandableSection variant="container" headerText={t('getStarted.models.title')} defaultExpanded>
          <SpaceBetween size="s">
            <Box>{s.mode === 'observe' ? t('getStarted.models.observe', { observeDefaults: Object.values(s.observeDefaults).map(shortModel).join(', ') || '—' }) : s.mode === 'auto' ? t('getStarted.models.auto') : t('ext.getStarted.models.unknown')}</Box>
            {s.tierLimit?.maxTier && <Box>{t('decision.cap', { maxTier: t(`enum.tier.${s.tierLimit.maxTier}`) })}</Box>}
            {s.pools.map((p) => (
              <Table key={p.dialect} variant="embedded" header={<Header variant="h3">{t('policy.pool.dialect', { dialect: t(`enum.dialect.${p.dialect}`) })}</Header>}
                ariaLabels={{ tableLabel: t(`enum.dialect.${p.dialect}`) }}
                columnDefinitions={[
                  { id: 'tier', header: t('getStarted.models.col.tier'), cell: (r: { tier: Tier; models: string[] }) => t(`enum.tier.${r.tier}`) + (r.tier === p.defaultTier ? ` (${t('policy.aliases.default')})` : ''), isRowHeader: true },
                  { id: 'alias', header: t('getStarted.models.col.alias'), cell: (r) => <Mono>{[...aliasesOf(r.tier), ...(r.tier === p.defaultTier ? ['auto'] : [])].join(', ')}</Mono> },
                  { id: 'models', header: t('getStarted.models.col.models'), cell: (r) => r.models.map(shortModel).join(', ') || '—' },
                ]}
                items={p.tiers}
              />
            ))}
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection variant="container" headerText={t('getStarted.endpoints.title')}>
          <SpaceBetween size="xs">
            <Box>{t('getStarted.endpoints.model')}</Box>
            {s.forwardedHeaders && <Box>{t('getStarted.endpoints.headers', { headers: s.forwardedHeaders.join(', ') })}</Box>}
            <Box>{t('getStarted.endpoints.response')}</Box>
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection variant="container" headerText={t('ext.getStarted.faq.title')} data-testid="faq">
          <SpaceBetween size="m">
            {faq.map((x) => (
              <SpaceBetween key={x.id} size="xxs">
                <Box variant="h4">{t(`ext.getStarted.faq.${x.id}.q` as MessageKey)}</Box>
                <Box variant="p">{t(`ext.getStarted.faq.${x.id}.a` as MessageKey, x.values)}</Box>
                {x.code && <CodeBlock {...(x.plain ? {} : { explain })} label={t(`ext.getStarted.faq.${x.id}.q` as MessageKey)} code={x.code} />}
              </SpaceBetween>
            ))}
          </SpaceBetween>
        </ExpandableSection>
        <ExpandableSection variant="container" headerText={t('getStarted.trouble.title')}>
          {notes(['getStarted.trouble.401', 'getStarted.trouble.403', 'getStarted.trouble.pin', 'getStarted.trouble.accessCap', 'getStarted.trouble.accessCapContext', 'getStarted.trouble.budget', 'getStarted.trouble.countTokens', 'getStarted.trouble.codexStream', 'getStarted.trouble.relogin', 'getStarted.trouble.codexAuth', 'getStarted.trouble.idpDown', 'getStarted.trouble.usage'])}
        </ExpandableSection>
        {admin && <Alert type="info" action={<Button onClick={() => nav('/admin/clients')}>{t('nav.clients')}</Button>}>{t('getStarted.admin.clients')}</Alert>}
      </SpaceBetween>
    </ContentLayout>
  )
}

