// Settings: My account (4f §4.14). Preferences are local (language, time display, theme, density); the password uses
// Cognito managed login (the pool has MFA off, user decision 2026-11-08); "Sign out everywhere" revokes every refresh token of this account (console-api
// AdminUserGlobalSignOut), including the llmar CLI sign-in.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import Modal from '@cloudscape-design/components/modal'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Tabs from '@cloudscape-design/components/tabs'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useProfile, useSignOutEverywhere } from '../api/hooks.ts'
import { useFlash } from '../app/flash.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { CALLBACK_PATH } from '../auth/user-manager.ts'
import { Pii } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { LOCALES, type Locale } from '../i18n/locale.ts'
import { usePrefs, type DensityPref, type Theme, type TimeDisplay } from '../prefs/prefs.tsx'
import { useBase } from './scope.ts'

export default function Settings() {
  const { t, f, locale, setLocale } = useI18n()
  const { prefs, set } = usePrefs()
  const { admin } = useBase()
  const { session } = useAuth()
  const nav = useNavigate()
  const profile = useProfile()
  const flash = useFlash()
  const everywhere = useSignOutEverywhere()
  const [confirm, setConfirm] = useState(false)
  const cfg = session.cfg
  // Managed login's own forgot-password page (no extra Cognito scope in the browser).
  const forgot = `${cfg.cognitoDomain}/forgotPassword?${new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: location.origin + CALLBACK_PATH, lang: locale })}`
  const p = profile.data
  return (
    <ContentLayout header={<Header variant="h1">{t('settings.title')}</Header>}>
      <Tabs
        activeTabId="account"
        onChange={(e) => { if (e.detail.activeTabId === 'deployment') nav('/settings/deployment') }}
        tabs={[
          {
            id: 'account', label: t('settings.tab.account'), content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2"><Pii kind="self">{p?.name ?? p?.username ?? ''}</Pii></Header>}>
                  <KeyValuePairs columns={3} items={[
                    { label: t('members.col.email'), value: p?.email ? <Pii kind="self-email">{p.email}</Pii> : '—' },
                    { label: t('members.col.role'), value: p ? t(`app.role.${p.role}`) : '—' },
                    { label: t('settings.myBudget'), value: p?.budget ? t('overview.budget.used', { spent: f.usd(p.budget.spentUsd), budget: f.usd(p.budget.monthlyUsd) }) : t('budget.none') },
                    { label: t('access.title'), value: p?.tierLimit?.maxTier ? t(`enum.tier.${p.tierLimit.maxTier}`) : t('access.none') },
                  ]} />
                </Container>
                <Container header={<Header variant="h2">{t('ext.settings.preferences')}</Header>}>
                  <SpaceBetween size="m">
                    <FormField label={t('settings.language')}>
                      <SegmentedControl label={t('settings.language')} selectedId={locale} onChange={(e) => setLocale(e.detail.selectedId as Locale)} options={LOCALES.map((l) => ({ id: l, text: t(`app.language.${l}`) }))} />
                    </FormField>
                    <FormField label={t('settings.timeDisplay')}>
                      <SegmentedControl label={t('settings.timeDisplay')} selectedId={prefs.time} onChange={(e) => set({ time: e.detail.selectedId as TimeDisplay })} options={[{ id: 'local', text: t('common.time.local') }, { id: 'utc', text: t('common.time.utc') }]} />
                    </FormField>
                    <FormField label={t('ext.settings.theme')}>
                      <SegmentedControl label={t('ext.settings.theme')} selectedId={prefs.theme} onChange={(e) => set({ theme: e.detail.selectedId as Theme })} options={[{ id: 'system', text: t('ext.settings.theme.system') }, { id: 'light', text: t('ext.settings.theme.light') }, { id: 'dark', text: t('ext.settings.theme.dark') }]} />
                    </FormField>
                    <FormField label={t('ext.settings.density')}>
                      <SegmentedControl label={t('ext.settings.density')} selectedId={prefs.density} onChange={(e) => set({ density: e.detail.selectedId as DensityPref })} options={[{ id: 'comfortable', text: t('ext.settings.density.comfortable') }, { id: 'compact', text: t('ext.settings.density.compact') }]} />
                    </FormField>
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">{t('ext.settings.security')}</Header>}>
                  <SpaceBetween size="m">
                    <FormField label={t('settings.password')} description={t('ext.settings.password.help')}>
                      <Button href={forgot} iconName="external" iconAlign="right">{t('settings.password')}</Button>
                    </FormField>
                    <FormField label={t('settings.signOutEverywhere')} description={t('settings.signOutEverywhere.body')}>
                      <Button onClick={() => setConfirm(true)}>{t('settings.signOutEverywhere')}</Button>
                    </FormField>
                  </SpaceBetween>
                </Container>
                <AboutBox />
              </SpaceBetween>
            ),
          },
          ...(admin ? [{ id: 'deployment', label: t('settings.tab.deployment'), content: null }] : []),
        ]}
      />
      <Modal visible={confirm} onDismiss={() => setConfirm(false)} header={t('settings.signOutEverywhere')}
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={everywhere.isPending} onClick={() => everywhere.mutate(undefined, {
            onSuccess: () => { setConfirm(false); void session.signOut({ everywhere: true }) },
            onError: () => flash.push({ type: 'error', content: t('state.error.title') }),
          })}>{t('common.confirm')}</Button>
        </SpaceBetween></Box>}>
        {t('settings.signOutEverywhere.body')}
      </Modal>
    </ContentLayout>
  )
}

function AboutBox() {
  const { t } = useI18n()
  return (
    <Container header={<Header variant="h2">{t('ext.settings.about')}</Header>}>
      <SpaceBetween size="xs">
        <Box>{t('ext.settings.build', { version: (import.meta.env.VITE_CONSOLE_BUILD as string | undefined) ?? 'dev' })}</Box>
        <a href="/third-party-licenses.txt" target="_blank" rel="noopener noreferrer">{t('ext.settings.licenses')}</a>
      </SpaceBetween>
    </Container>
  )
}
