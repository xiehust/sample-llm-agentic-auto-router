// TanStack Query hooks, one per contract route. GETs retry twice on 5xx / network errors; mutations never retry and
// invalidate what they change.

import type {
  ActivateRequest, ActivateResponse, AuditEntry, ClientsResponse, Delivery, MembersResponse, AuditQuery, BudgetsPatch, BudgetsResponse, ClientAction, ClientPatch, ClientSecretResponse, ConfigDocument,
  ConfigState, ConfigVersionMeta, CreateClientRequest, DeploymentSettings, GatewayInfo, HealthRange, HealthReport, InviteRequest, LatestResponse,
  Member, MemberAction, MemberDetail, MemberPatch, PackEntry, PacksResponse, Page, Profile, RecordDetail, RecordLookup, RecordQuery, RecordSummary, SavingsQuery,
  SavingsReport, ServiceClient, SessionDetail, SettingsPatch, SetupInfo, UsageQuery, UsageReport, ValidateResponse,
} from '@auto-router/console-contract'
import { pathOf, toQuery } from '@auto-router/console-contract'
import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { ApiError, SignInRequiredError, type ApiClient } from './client.ts'

export const ApiCtx = createContext<ApiClient | undefined>(undefined)

export function useApi(): ApiClient {
  const v = useContext(ApiCtx)
  if (!v) throw new Error('useApi outside <ApiCtx.Provider>')
  return v
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // 503 config-unavailable is the server's answer (baked.json unreadable), not a transient failure: no retry.
        retry: (n, e) => !(e instanceof SignInRequiredError) && !(e instanceof ApiError && (e.status < 500 || e.code === 'config-unavailable')) && n < 2,
      },
      mutations: { retry: false },
    },
  })
}

type Base = 'me' | 'admin'
type Q<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>

function useGet<T>(key: readonly unknown[], path: string | undefined, opts: Q<T> = {}) {
  const api = useApi()
  return useQuery<T, Error>({ queryKey: key, queryFn: ({ signal }) => api.get<T>(path as string, { signal }), enabled: path !== undefined, ...opts })
}

const qs = (q: object) => toQuery(q as Record<string, never>)

export const useProfile = () => useGet<Profile>(['profile'], '/api/me/profile', { staleTime: 60_000 })
export const useUsage = (base: Base, q: UsageQuery | undefined) =>
  useGet<UsageReport>(['usage', base, q], q ? `/api/${base}/usage${qs(q)}` : undefined, { placeholderData: keepPreviousData })
export const useSavings = (base: Base, q: SavingsQuery | undefined) =>
  useGet<SavingsReport>(['savings', base, q], q ? `/api/${base}/usage${qs(q)}` : undefined, { placeholderData: keepPreviousData })
export const useRecords = (base: Base, q: RecordQuery | undefined) =>
  useGet<Page<RecordSummary>>(['records', base, q], q ? `/api/${base}/records${qs(q)}` : undefined, { placeholderData: keepPreviousData })
/** ts (both roles) and caller (admin) from the list row make the lookup a direct key read. */
export const useRecord = (base: Base, reqId: string | undefined, lookup: RecordLookup = {}) =>
  useGet<RecordDetail>(['record', base, reqId, lookup.ts, lookup.caller], reqId ? pathOf(`/api/${base}/records/:reqId`, { reqId }) + qs(base === 'admin' ? lookup : { ts: lookup.ts }) : undefined)
/** Admin lookups need the caller (a label is unique per caller only, GSI2 key). */
export const useSession = (base: Base, label: string | undefined, caller?: string) =>
  useGet<SessionDetail>(['session', base, label, caller], label && (base === 'me' || caller) ? pathOf(`/api/${base}/sessions/:label`, { label }) + qs({ caller }) : undefined)
export const useSetup = () => useGet<SetupInfo>(['setup'], '/api/me/setup')
export const usePack = (packVersion: string | undefined) =>
  useGet<PackEntry>(['pack', packVersion], packVersion ? pathOf('/api/packs/:packVersion', { packVersion }) : undefined, { staleTime: Infinity })

export function useSignOutEverywhere() {
  const api = useApi()
  return useMutation<unknown, Error>({ mutationFn: () => api.post('/api/me/sign-out-everywhere') })
}

export function useLatest() {
  const api = useApi()
  return useMutation<LatestResponse, Error>({ mutationFn: () => api.get<LatestResponse>('/api/me/latest') })
}

// ---- admin
export const useMembers = () => useGet<MembersResponse>(['members'], '/api/admin/members', { refetchInterval: (q) => (q.state.data?.items.some((m) => m.applying) || q.state.data?.identity.state === 'pending' ? 5000 : false) })
export const useMember = (id: string | undefined) => useGet<MemberDetail>(['member', id], id ? pathOf('/api/admin/members/:id', { id }) : undefined)
export const useClients = () => useGet<ClientsResponse>(['clients'], '/api/admin/service-clients')
export const useConfig = () => useGet<ConfigState>(['config'], '/api/admin/config', { refetchInterval: (q) => (q.state.data?.router.status === 'pending' ? 3000 : false) })
export const useConfigVersions = () => useGet<{ items: ConfigVersionMeta[] }>(['config', 'versions'], '/api/admin/config/versions')
export const useConfigVersion = (v: string | undefined) =>
  useGet<{ meta: ConfigVersionMeta; document: ConfigDocument }>(['config', 'version', v], v ? pathOf('/api/admin/config/versions/:version', { version: v }) : undefined, { staleTime: Infinity })
export const usePacks = () => useGet<PacksResponse>(['packs'], '/api/admin/assessor/packs')
export const useGateway = () => useGet<GatewayInfo>(['gateway'], '/api/admin/gateway', { staleTime: 300_000 })
export const useHealth = (range: HealthRange) => useGet<HealthReport>(['health', range], `/api/admin/health${qs({ range })}`, { refetchInterval: 60_000 })
export const useAudit = (q: AuditQuery | undefined) => useGet<Page<AuditEntry>>(['audit', q], q ? `/api/admin/audit${qs(q)}` : undefined, { placeholderData: keepPreviousData })
export const useBudgets = () => useGet<BudgetsResponse>(['budgets'], '/api/admin/budgets')
export const useSettings = () => useGet<DeploymentSettings>(['settings'], '/api/admin/settings')

function useMut<TVars, TRes>(fn: (api: ApiClient, v: TVars) => Promise<TRes>, invalidate: readonly (readonly unknown[])[]) {
  const api = useApi()
  const qc = useQueryClient()
  return useMutation<TRes, Error, TVars>({
    mutationFn: (v) => fn(api, v),
    onSuccess: () => { for (const k of invalidate) void qc.invalidateQueries({ queryKey: k }) },
  })
}

export const useInvite = () => useMut<InviteRequest, Member>((a, v) => a.post('/api/admin/members', v), [['members'], ['audit']])
export const usePatchMember = () => useMut<{ id: string; patch: MemberPatch }, Member>((a, v) => a.patch(pathOf('/api/admin/members/:id', { id: v.id }), v.patch), [['members'], ['member'], ['audit']])
export const useMemberAction = () => useMut<{ id: string; action: MemberAction }, Member>((a, v) => a.post(pathOf('/api/admin/members/:id/actions', { id: v.id }), { action: v.action }), [['members'], ['member'], ['audit']])
export const useDeleteMember = () => useMut<{ id: string }, unknown>((a, v) => a.delete(pathOf('/api/admin/members/:id', { id: v.id })), [['members'], ['audit']])
export const useCreateClient = () => useMut<CreateClientRequest, ClientSecretResponse>((a, v) => a.post('/api/admin/service-clients', v), [['clients'], ['audit']])
export const usePatchClient = () => useMut<{ id: string; patch: ClientPatch }, ServiceClient>((a, v) => a.patch(pathOf('/api/admin/service-clients/:id', { id: v.id }), v.patch), [['clients'], ['audit']])
export const useClientAction = () =>
  useMut<{ id: string; action: ClientAction }, ServiceClient | ClientSecretResponse>((a, v) => a.post(pathOf('/api/admin/service-clients/:id/actions', { id: v.id }), { action: v.action }), [['clients'], ['audit']])
export const useDeleteClient = () => useMut<{ id: string }, unknown>((a, v) => a.delete(pathOf('/api/admin/service-clients/:id', { id: v.id })), [['clients'], ['audit']])
export const useValidateConfig = () => useMut<{ document: ConfigDocument }, ValidateResponse>((a, v) => a.post('/api/admin/config/validate', v), [])
export const useSaveDraft = () => useMut<{ document: ConfigDocument; baseVersion: string }, ConfigState>((a, v) => a.put('/api/admin/config', v), [['config']])
export const useDiscardDraft = () => useMut<void, ConfigState>((a) => a.delete('/api/admin/config'), [['config']])
export const useActivate = () => useMut<ActivateRequest, ActivateResponse>((a, v) => a.post('/api/admin/config/activate', v), [['config'], ['audit'], ['profile'], ['setup']])
export const usePutBudgets = () => useMut<BudgetsPatch, unknown>((a, v) => a.put('/api/admin/budgets', v), [['budgets'], ['audit']])
export const useRepublishIdentity = () => useMut<void, { identity: Delivery }>((a) => a.post('/api/admin/identity/republish'), [['members'], ['clients'], ['settings'], ['audit']])
export const useRedeliverConfig = () => useMut<void, ConfigState>((a) => a.post('/api/admin/config/redeliver'), [['config'], ['audit']])
export const usePatchSettings = () => useMut<SettingsPatch, DeploymentSettings>((a, v) => a.patch('/api/admin/settings', v), [['settings'], ['profile'], ['audit']])
