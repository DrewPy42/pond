/**
 * Every call between a pad and Pond must be plain JSON data, so the same pad code could one day
 * run in an isolated process (docs/lilypad-contract.md, amendment A6). In strict mode (always on
 * in tests) the host checks arguments and round-trips results to prove it.
 */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1))
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      // `undefined` inside an object is allowed (it is dropped), as in optional fields.
      return Object.values(value as Record<string, unknown>).every(
        (v) => v === undefined || isPlainJson(v, depth + 1),
      )
    }
    default:
      return false
  }
}

export class PadJsonError extends Error {}

/** Wraps an async function so its arguments must be plain JSON and its result is returned as JSON. */
export function jsonGuard<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R> | R,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    for (const a of args) {
      if (a !== undefined && !isPlainJson(a))
        throw new PadJsonError(`${name}: arguments must be plain JSON data`)
    }
    const result = await fn(...args)
    return (result === undefined ? result : JSON.parse(JSON.stringify(result))) as R
  }
}

/** Applies `jsonGuard` to every function property of an API object. */
export function guardApi<T extends object>(prefix: string, api: T, enabled: boolean): T {
  if (!enabled) return api
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(api)) {
    out[k] =
      typeof v === 'function'
        ? // Bound, because some methods call their neighbors (a table's findOne uses find).
          jsonGuard(`${prefix}.${k}`, (v as (...a: unknown[]) => unknown).bind(api))
        : v && typeof v === 'object'
          ? guardApi(`${prefix}.${k}`, v, enabled)
          : v
  }
  return out as T
}
