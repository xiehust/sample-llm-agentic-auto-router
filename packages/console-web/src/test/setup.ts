// jsdom gaps Cloudscape and our code rely on. Node-environment tests (mock/, scripts/) skip this.
import { afterEach } from 'vitest'

// Testing Library cleans up automatically only with vitest globals; do it explicitly.
const cleanup = typeof window !== 'undefined' ? (await import('@testing-library/react')).cleanup : undefined

if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in globalThis)) {
    class RO { observe() {} unobserve() {} disconnect() {} }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  }
  if (!window.matchMedia) {
    window.matchMedia = (q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList
  }
  afterEach(() => { cleanup?.(); localStorage.clear(); sessionStorage.clear() })
}
