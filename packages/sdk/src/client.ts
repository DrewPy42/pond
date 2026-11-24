import { inject, type Component, type InjectionKey } from 'vue'

/**
 * The web side of a pad. A pad's client code registers components for the places Pond lets pads
 * add to (docs/lilypad-contract.md, "UI extension points"). It never removes or replaces core
 * items, and it reaches the server only through `usePadHost().api`.
 */
export interface PadPage {
  /** Path under `/p/<padId>/`, e.g. "notes" -> /p/notes/notes. Empty string is the pad's home. */
  path: string
  component: Component
}
export interface PadSidebarItem {
  title: string
  /** An mdi icon name, e.g. "mdi-note-text-outline". */
  icon: string
  /** The page path this item opens. */
  path: string
}
export interface PadWidget {
  title?: string
  component: Component
}
export interface PadClientDefinition {
  sidebar?: PadSidebarItem[]
  pages?: PadPage[]
  /** Cards on the core dashboard, shown in Spaces where the pad is enabled. */
  widgets?: PadWidget[]
  /** A panel on a transaction's detail dialog. Receives `transactionId`. */
  transactionPanels?: PadWidget[]
}
export const definePadClient = (def: PadClientDefinition): PadClientDefinition => def

/** The registry entry for a pad's client side. */
export interface PadClientModule {
  id: string
  client: PadClientDefinition
}

/** What the web app gives pad components (injected, so pads never import the web app). */
export interface PadHostApi {
  padId: string
  spaceId: string
  canEdit: boolean
  api: {
    get<T = unknown>(
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
    ): Promise<T>
    post<T = unknown>(path: string, body?: unknown): Promise<T>
    put<T = unknown>(path: string, body?: unknown): Promise<T>
    patch<T = unknown>(path: string, body?: unknown): Promise<T>
    del<T = unknown>(path: string): Promise<T>
  }
}
export const PAD_HOST: InjectionKey<PadHostApi> = Symbol('pond-pad-host')

/** Use inside a pad component. Throws if the component is mounted outside Pond's pad slots. */
export function usePadHost(): PadHostApi {
  const host = inject(PAD_HOST)
  if (!host) throw new Error('usePadHost() was called outside a Pond pad slot')
  return host
}
