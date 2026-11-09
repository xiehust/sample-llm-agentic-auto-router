// Config versions (4f §4.9 Versions tab): list, diff between any two, roll back (a new version with old content).

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useConfig, useConfigVersion, useConfigVersions, useValidateConfig } from '../../api/hooks.ts'
import { QueryView } from '../../components/states.tsx'
import { Mono, Pii, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import { ActivateModal, DiffView } from './Policy.tsx'

export default function Versions() {
  const { t } = useI18n()
  const nav = useNavigate()
  const { version } = useParams()
  const list = useConfigVersions()
  const cfg = useConfig()
  const [left, setLeft] = useState<string | undefined>()
  const right = version ?? list.data?.items[0]?.version
  const leftV = left ?? list.data?.items.find((v) => v.version !== right)?.version
  const a = useConfigVersion(leftV)
  const b = useConfigVersion(right)
  const validate = useValidateConfig()
  const [rollback, setRollback] = useState(false)
  const options = (list.data?.items ?? []).map((v) => ({ value: v.version, label: t('config.version', { version: v.version }), description: v.comment }))
  const isActive = right === cfg.data?.active.version
  return (
    <ContentLayout header={<Header variant="h1" actions={<Button onClick={() => nav('/admin/policy')}>{t('policy.title')}</Button>}>{t('config.versions')}</Header>}>
      <SpaceBetween size="l">
        <QueryView q={list} notFound="config">{(d) => (
          <Table items={d.items} ariaLabels={{ tableLabel: t('config.versions'), selectionGroupLabel: t('config.versions'), itemSelectionLabel: (_, v) => t('config.version', { version: v.version }) }} selectionType="single" selectedItems={d.items.filter((v) => v.version === right)}
            onSelectionChange={(e) => { const v = e.detail.selectedItems[0]; if (v) nav(`/admin/config/versions/${encodeURIComponent(v.version)}`) }}
            columnDefinitions={[
              { id: 'v', header: t('config.versions'), cell: (v) => <Mono>{v.version}</Mono>, isRowHeader: true },
              { id: 'a', header: t('audit.col.actor'), cell: (v) => <Pii kind="author">{v.author}</Pii> },
              { id: 't', header: t('decisions.col.time'), cell: (v) => <Time iso={v.createdAt} /> },
              { id: 'c', header: t('config.comment'), cell: (v) => v.comment + (v.rollbackOf ? ` (${t('config.rollback')}: ${v.rollbackOf})` : '') },
              { id: 's', header: t('config.changedSections'), cell: (v) => v.changed.join(', ') },
            ]} />
        )}</QueryView>
        <Container header={<Header variant="h2" actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Select ariaLabel={t('config.diff')} selectedOption={options.find((o) => o.value === leftV) ?? null} options={options} onChange={(e) => setLeft(e.detail.selectedOption.value)} />
            <Box padding={{ top: 'xs' }}>→ <Mono>{right}</Mono></Box>
            <Button disabled={!b.data || isActive || !cfg.data} onClick={() => { if (b.data) { validate.mutate({ document: b.data.document }); setRollback(true) } }}>{t('config.rollback')}</Button>
          </SpaceBetween>
        }>{t('config.diff')}</Header>}>
          {a.data && b.data ? <DiffView a={JSON.stringify(a.data.document, null, 2)} b={JSON.stringify(b.data.document, null, 2)} label={t('config.diff')} /> : <Box color="text-body-secondary">{t('state.loading')}</Box>}
        </Container>
        {rollback && b.data && cfg.data && (
          <ActivateModal prev={cfg.data.active.document} next={b.data.document} result={validate.data} validating={validate.isPending} validateError={validate.error} baseVersion={cfg.data.active.version}
            rollbackOf={b.data.meta.version} onClose={() => setRollback(false)} onConflict={() => setRollback(false)} />
        )}
      </SpaceBetween>
    </ContentLayout>
  )
}
