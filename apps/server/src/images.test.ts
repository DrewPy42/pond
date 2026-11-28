import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const deploy = path.join(repo, 'deploy')
// The production image has no browser packages, so what the server loads must not need them.
const sdk = path.join(repo, 'packages/sdk/src')

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

/** Runs deploy/caddy-start.sh with a stand-in for caddy that only says it was started. */
function startCaddy(env: Record<string, string>) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-caddy-'))
  try {
    fs.writeFileSync(path.join(bin, 'caddy'), '#!/bin/sh\necho "caddy $*"\n', { mode: 0o755 })
    return spawnSync('/bin/sh', [path.join(deploy, 'caddy-start.sh')], {
      env: { PATH: bin, ...env },
      encoding: 'utf8',
    })
  } finally {
    fs.rmSync(bin, { recursive: true, force: true })
  }
}

describe('deploy/caddy-start.sh: settings from .env', () => {
  const good = { POND_ADDRESS: 'pond.local', POND_HTTPS_PORT: '443', POND_HTTP_REDIRECT: 'true' }

  /**
   * Inputs:   a name or an IP address on 443 with the redirect, and port 8443 without it
   * Expected: Caddy is started each time
   */
  it.each([
    good,
    { ...good, POND_ADDRESS: '192.168.1.20' },
    { ...good, POND_HTTPS_PORT: '8443', POND_HTTP_REDIRECT: 'false' },
  ])('starts Caddy for $POND_ADDRESS on $POND_HTTPS_PORT', (env) => {
    const run = startCaddy(env)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('caddy run')
  })

  /**
   * Inputs:   the plain-HTTP redirect together with HTTPS on 8443
   * Expected: Caddy is not started, and the message says which line of .env to change. The
   *           redirect is only for 443 (docs/ship-design.md, decision 15)
   */
  it('refuses the redirect when HTTPS is not on 443', () => {
    const run = startCaddy({ ...good, POND_HTTPS_PORT: '8443' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('COMPOSE_FILE')
    expect(run.stdout).not.toContain('caddy run')
  })

  /**
   * Inputs:   an empty address, and ones with https://, a port, a path or two names
   * Expected: Caddy is not started, and the message says what an address looks like
   */
  it.each(['', 'https://pond.local', 'pond.local:8443', 'pond.local/', 'pond.local pi.local'])(
    'refuses the address "%s"',
    (address) => {
      const run = startCaddy({ ...good, POND_ADDRESS: address })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('POND_ADDRESS')
    },
  )
})

describe('deploy/compose.yml', () => {
  /**
   * Inputs:   the pond service in the production compose file
   * Expected: it publishes no ports, so Pond is reachable only through Caddy, over HTTPS
   */
  it('publishes no port for Pond itself', () => {
    const compose = fs.readFileSync(path.join(deploy, 'compose.yml'), 'utf8')
    const pond = compose.slice(compose.indexOf('\n  pond:\n'), compose.indexOf('\n  caddy:\n'))
    expect(pond).toContain('read_only: true')
    expect(pond).not.toMatch(/^\s*ports:/m)
  })
})
