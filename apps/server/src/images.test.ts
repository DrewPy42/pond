import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const deploy = path.join(repo, 'deploy')
// The production image has no browser packages, so what the server loads must not need them.
const sdk = path.join(repo, 'packages/sdk/src')

/** The instructions of the stage that downloads rclone, without comments or its FROM line. */
function rcloneStage(dockerfile: string): string {
  const lines = fs.readFileSync(path.join(deploy, dockerfile), 'utf8').split('\n')
  const start = lines.findIndex((l) => /^FROM .* AS rclone$/.test(l))
  const length = lines.slice(start + 1).findIndex((l) => l.startsWith('FROM '))
  expect(start).toBeGreaterThanOrEqual(0)
  return lines
    .slice(start + 1, start + 1 + length)
    .filter((l) => l && !l.startsWith('#'))
    .join('\n')
}

describe('the Dockerfiles', () => {
  /**
   * Inputs:   the rclone stage of Dockerfile (production) and of Dockerfile.dev
   * Expected: the same instructions, so both pin one rclone version with the same checksums
   */
  it('install the same checked rclone', () => {
    const production = rcloneStage('Dockerfile')
    expect(production).toContain('sha256sum -c')
    expect(production).toBe(rcloneStage('Dockerfile.dev'))
  })
})

/** The packages loaded at run time by a file and by the files it imports. */
function runtimePackages(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>()
  if (seen.has(file)) return found
  seen.add(file)
  const source = fs.readFileSync(file, 'utf8')
  // `import type` and `export type` lines are erased before the code runs.
  const statements = source.matchAll(/^(?:import|export)\s(?!type\s)[^'"]*?from\s+'([^']+)'/gm)
  for (const [, name = ''] of statements) {
    if (!name.startsWith('.')) found.add(name)
    else {
      const next = path.resolve(path.dirname(file), name.replace(/\.js$/, '.ts'))
      for (const p of runtimePackages(next, seen)) found.add(p)
    }
  }
  return found
}

describe('@pond/sdk entry points', () => {
  /**
   * Inputs:   everything @pond/sdk (the entry the server loads) imports when it runs
   * Expected: no Vue. The production image has no browser packages, so Pond would not start
   */
  it('keeps Vue out of what the server loads', () => {
    expect([...runtimePackages(path.join(sdk, 'index.ts'))]).not.toContain('vue')
  })

  /**
   * Inputs:   everything @pond/sdk/client imports when it runs
   * Expected: Vue is found, which shows the check above can see it
   */
  it('has the web side in its own entry point', () => {
    expect([...runtimePackages(path.join(sdk, 'client.ts'))]).toContain('vue')
  })
})
