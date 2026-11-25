import { inject, type Component, type InjectionKey } from 'vue'
import type { Role } from './context.js'

/**
 * The web side of a pad. A pad's client code registers components for the places Pond lets pads
 * add to (docs/lilypad-contract.md, "UI extension points"). It never removes or replaces core
 * items, and it reaches the server only through `usePadHost().api`.
 */
export interface PadPage {
  /** Path under `/p/<padId>/`, e.g. "notes" -> /p/notes/notes. Empty string is the pad's home. */
  path: string
  component: Component
  /** Hide from people below this role in the Space. Tidiness only: server routes enforce access. */
  role?: Role
}
export interface PadSidebarItem {
  title: string
  /** An mdi icon name, e.g. "mdi-note-text-outline". */
  icon: string
  /** The page path this item opens. */
  path: string
  /** Hide from people below this role in the Space. Tidiness only: server routes enforce access. */
  role?: Role
}
export interface PadWidget {
  title?: string
  component: Component
}
/** A report the pad offers, listed under Pond's own Reports as well as inside the pad. */
export interface PadReportLink {
  title: string
  description: string
  /** The page path that shows it. */
  path: string
  role?: Role
}
export interface PadClientDefinition {
  reportPages?: PadReportLink[]
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
  /** The person is an owner of the Space. For showing controls; server routes enforce access. */
  isOwner: boolean
  api: {
    get<T = unknown>(
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
    ): Promise<T>
    post<T = unknown>(path: string, body?: unknown): Promise<T>
    put<T = unknown>(path: string, body?: unknown): Promise<T>
    patch<T = unknown>(path: string, body?: unknown): Promise<T>
    del<T = unknown>(path: string): Promise<T>
    /** Send a file to an `upload` route (as the raw request body). */
    upload<T = unknown>(
      path: string,
      file: Blob,
      query?: Record<string, string | number | boolean | undefined>,
    ): Promise<T>
    /** Save a file a route returns with `files.download`. */
    download(
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
    ): Promise<void>
  }
}
export const PAD_HOST: InjectionKey<PadHostApi> = Symbol('pond-pad-host')

/** Use inside a pad component. Throws if the component is mounted outside Pond's pad slots. */
export function usePadHost(): PadHostApi {
  const host = inject(PAD_HOST)
  if (!host) throw new Error('usePadHost() was called outside a Pond pad slot')
  return host
}
