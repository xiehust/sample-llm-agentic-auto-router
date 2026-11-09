// URL-backed filter state and a multiselect bound to one URL list parameter.

import Multiselect from '@cloudscape-design/components/multiselect'
import Select from '@cloudscape-design/components/select'
import { useSearchParams } from 'react-router'

export function useListParam(name: string): [string[], (v: string[]) => void] {
  const [sp, setSp] = useSearchParams()
  const v = (sp.get(name) ?? '').split(',').filter(Boolean)
  const set = (next: string[]) => setSp((cur) => {
    const n = new URLSearchParams(cur)
    if (next.length) n.set(name, next.join(',')); else n.delete(name)
    n.delete('cursor')
    return n
  }, { replace: true })
  return [v, set]
}

export function useParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get(name)
  const v = allowed.includes(raw as T) ? (raw as T) : fallback
  const set = (next: T) => setSp((cur) => {
    const n = new URLSearchParams(cur)
    if (next === fallback) n.delete(name); else n.set(name, next)
    n.delete('cursor')
    return n
  }, { replace: true })
  return [v, set]
}

export function useBoolParam(name: string): [boolean | undefined, (v: boolean | undefined) => void] {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get(name)
  const v = raw === 'true' ? true : raw === 'false' ? false : undefined
  const set = (next: boolean | undefined) => setSp((cur) => {
    const n = new URLSearchParams(cur)
    if (next === undefined) n.delete(name); else n.set(name, String(next))
    n.delete('cursor')
    return n
  }, { replace: true })
  return [v, set]
}

export function ListFilter({ label, options, value, onChange }: { label: string; options: Array<{ value: string; label: string }>; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Multiselect
      placeholder={label}
      ariaLabel={label}
      options={options}
      selectedOptions={options.filter((o) => value.includes(o.value))}
      onChange={(e) => onChange(e.detail.selectedOptions.map((o) => o.value as string))}
      hideTokens={value.length > 2}
      filteringType={options.length > 8 ? 'auto' : 'none'}
    />
  )
}

export function ChoiceFilter<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <Select
      ariaLabel={label}
      inlineLabelText={label}
      options={options}
      selectedOption={options.find((o) => o.value === value) ?? null}
      onChange={(e) => onChange(e.detail.selectedOption.value as T)}
    />
  )
}

export function clearAll(setSp: ReturnType<typeof useSearchParams>[1], keep: readonly string[] = ['range', 'from', 'to']) {
  setSp((cur) => {
    const n = new URLSearchParams()
    for (const k of keep) { const v = cur.get(k); if (v) n.set(k, v) }
    return n
  }, { replace: true })
}
