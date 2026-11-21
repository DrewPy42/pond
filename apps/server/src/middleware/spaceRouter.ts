import { Router, type RequestHandler } from 'express'
import type { Db } from '../db/index.js'
import type { Role } from '../types.js'
import { requireAuth, requireSpace } from './auth.js'

export interface SpaceRouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  /** Full path with `:spaceId` (and any other params) as declared. */
  path: string
  minRole: Role
}

/**
 * The only way to declare a Space-scoped route. Every route gets requireAuth + requireSpace
 * (deny by default) and is recorded in `registry` so tests can prove the non-member-gets-404
 * rule for every one of them (security.md).
 */
export function createSpaceRouter(db: Db, basePath: string, registry: SpaceRouteInfo[]) {
  const router = Router({ mergeParams: true })
  const add =
    (method: SpaceRouteInfo['method']) =>
    (path: string, minRole: Role, ...handlers: RequestHandler[]) => {
      registry.push({ method, path: `${basePath}${path === '/' ? '' : path}`, minRole })
      router[method](path, requireAuth(), requireSpace(db, minRole), ...handlers)
    }
  return {
    router,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  }
}
