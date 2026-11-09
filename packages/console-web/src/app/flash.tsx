// Global flash messages (Cloudscape Flashbar in the AppLayout notifications slot, announced to screen readers).

import type { FlashbarProps } from '@cloudscape-design/components/flashbar'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export interface FlashInput { type: 'success' | 'error' | 'warning' | 'info'; content: ReactNode; header?: ReactNode; id?: string }

interface FlashCtx { items: FlashbarProps.MessageDefinition[]; push(f: FlashInput): void; dismiss(id: string): void }
const Ctx = createContext<FlashCtx | undefined>(undefined)

let seq = 0

export function FlashRoot({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<FlashbarProps.MessageDefinition[]>([])
  const dismiss = useCallback((id: string) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const push = useCallback((f: FlashInput) => {
    const id = f.id ?? `flash-${++seq}`
    setItems((xs) => [...xs.filter((x) => x.id !== id), { id, type: f.type, content: f.content, header: f.header, dismissible: true, dismissLabel: '×', onDismiss: () => dismiss(id), ariaRole: f.type === 'error' ? 'alert' : 'status' }])
  }, [dismiss])
  const v = useMemo(() => ({ items, push, dismiss }), [items, push, dismiss])
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>
}

export function useFlash(): FlashCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useFlash outside <FlashRoot>')
  return v
}
