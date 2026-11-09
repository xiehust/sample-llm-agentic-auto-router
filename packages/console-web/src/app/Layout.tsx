// Global frame (4f §3): top bar (product, deployment, mode badge, language, user menu), side navigation by role,
// flash notifications. Admin items are hidden from members; their routes are also guarded (RequireRole) and the
// server re-checks the group on every call.

import Alert from '@cloudscape-design/components/alert'
import AppLayout from '@cloudscape-design/components/app-layout'
import Button from '@cloudscape-design/components/button'
import Flashbar from '@cloudscape-design/components/flashbar'
import SideNavigation, { type SideNavigationProps } from '@cloudscape-design/components/side-navigation'
import TopNavigation from '@cloudscape-design/components/top-navigation'
import type { Role } from '@auto-router/console-contract'
import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { useProfile } from '../api/hooks.ts'
import { useAuth } from '../auth/AuthContext.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { LOCALES, type Locale } from '../i18n/locale.ts'
import type { MessageKey } from '../i18n/messages.ts'
import { useFlash } from './flash.tsx'

/** Top-bar mode badge [text, tooltip]; 'unknown' when the deploy defaults could not be read (0d: never guessed). */
const MODE_BADGE: Record<'observe' | 'auto' | 'unknown', [MessageKey, MessageKey]> = {
  observe: ['app.mode.observe', 'app.mode.observe.tooltip'],
  auto: ['app.mode.auto', 'app.mode.auto.tooltip'],
  unknown: ['ext.app.mode.unknown', 'ext.app.mode.unknown.tooltip'],
}

export function navItems(role: Role | undefined, t: ReturnType<typeof useI18n>['t']): SideNavigationProps.Item[] {
  const link = (text: string, href: string): SideNavigationProps.Link => ({ type: 'link', text, href })
  const usage = [link(t('nav.overview'), '/'), link(t('nav.usage'), '/usage'), link(t('nav.savings'), '/savings'), link(t('nav.decisions'), '/decisions')]
  const tail = [{ type: 'divider' } as const, link(t('nav.getStarted'), '/get-started'), link(t('nav.settings'), '/settings')]
  if (role !== 'admin') return [...usage, ...tail]
  return [
    { type: 'section-group', title: t('nav.group.usage'), items: usage },
    { type: 'section-group', title: t('nav.group.routing'), items: [link(t('nav.policy'), '/admin/policy'), link(t('nav.assessor'), '/admin/assessor'), link(t('nav.gateway'), '/admin/gateway')] },
    { type: 'section-group', title: t('nav.group.access'), items: [link(t('nav.members'), '/admin/members'), link(t('nav.clients'), '/admin/clients')] },
    { type: 'section-group', title: t('nav.group.operations'), items: [link(t('nav.health'), '/admin/health'), link(t('nav.audit'), '/admin/audit')] },
    ...tail,
  ]
}

/** The nav entry a path belongs to (detail pages highlight their list). */
export function activeHref(pathname: string): string {
  const roots = ['/usage', '/savings', '/decisions', '/get-started', '/settings', '/admin/policy', '/admin/config', '/admin/assessor', '/admin/gateway', '/admin/members', '/admin/clients', '/admin/health', '/admin/audit']
  if (pathname.startsWith('/sessions/')) return '/decisions'
  if (pathname.startsWith('/admin/config')) return '/admin/policy'
  return roots.find((r) => pathname === r || pathname.startsWith(`${r}/`)) ?? '/'
}

export function Layout() {
  const { t, locale, setLocale } = useI18n()
  const { session, claims, role } = useAuth()
  const profile = useProfile()
  const flash = useFlash()
  const nav = useNavigate()
  const loc = useLocation()
  const [navOpen, setNavOpen] = useState(true)
  const main = useRef<HTMLDivElement>(null)

  // Focus moves to the page heading after a route change (screen readers announce the new page).
  useEffect(() => {
    const h = main.current?.querySelector('h1')
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }) }
  }, [loc.pathname])

  const d = profile.data?.deployment
  const name = profile.data?.name ?? claims?.username ?? ''
  // The API takes the role from the member table on every call; the menu and route guards take it from the token's
  // group claim. After a promotion the two differ until the next sign-in, so say so (0d review, LOW).
  const promoted = profile.data?.role === 'admin' && role === 'member'
  const follow = (e: CustomEvent<{ href: string; external?: boolean }>) => {
    if (e.detail.external) return
    e.preventDefault()
    nav(e.detail.href)
  }
  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{ href: '/', title: `${t('app.title')} · ${t('app.subtitle')}`, onFollow: follow as never }}
          utilities={[
            ...(d ? [{ type: 'button' as const, text: t('app.deployment', { prefix: d.prefix, region: d.region }), disableUtilityCollapse: false }] : []),
            ...(d ? [{ type: 'button' as const, variant: 'primary-button' as const, text: t(MODE_BADGE[d.mode][0]), title: t(MODE_BADGE[d.mode][1]) }] : []),
            {
              type: 'menu-dropdown', text: t(`app.language.${locale}`), title: t('app.language'), ariaLabel: t('app.language'),
              items: LOCALES.map((l) => ({ id: l, text: t(`app.language.${l}`), lang: l })),
              onItemClick: (e) => setLocale(e.detail.id as Locale),
            },
            {
              type: 'menu-dropdown', text: name, description: role ? t(`app.role.${role}`) : undefined, iconName: 'user-profile',
              items: [{ id: 'settings', text: t('app.user.settings') }, { id: 'signout', text: t('app.user.signOut') }],
              onItemClick: (e) => { if (e.detail.id === 'settings') nav('/settings'); else void session.signOut() },
            },
          ]}
          i18nStrings={{ overflowMenuTriggerText: t('common.showMore'), overflowMenuTitleText: t('common.all') }}
        />
      </div>
      <AppLayout
        headerSelector="#top-nav"
        navigationOpen={navOpen}
        onNavigationChange={(e) => setNavOpen(e.detail.open)}
        navigation={<SideNavigation activeHref={activeHref(loc.pathname)} items={navItems(role, t)} onFollow={follow} header={{ text: t('app.title'), href: '/' }} />}
        notifications={<Flashbar items={flash.items} />}
        toolsHide
        content={<div ref={main}>
          {promoted && (
            <Alert type="info" data-testid="admin-sign-in" action={<Button onClick={() => void session.signIn(loc.pathname + loc.search, locale)}>{t('state.signIn')}</Button>}>
              {t('members.adminSignIn.self')}
            </Alert>
          )}
          {role ? <Outlet /> : <div data-testid="no-role">{t('auth.noRole')}</div>}
        </div>}
        ariaLabels={{ navigation: t('ext.nav.label'), navigationToggle: t('ext.nav.open'), navigationClose: t('ext.nav.close'), notifications: t('ext.notifications') }}
      />
    </>
  )
}
