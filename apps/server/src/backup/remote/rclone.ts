/**
 * Running rclone: no shell, a fixed list of arguments, a bare environment and only three
 * commands (copyto, lsjson, deletefile). Its error text can hold addresses or tokens, so it is
 * read only to pick a plain reason, and never logged or returned.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'

export type RcloneCommand =
  | { name: 'upload'; from: string; folder: string; filename: string }
  | { name: 'list'; folder: string }
  | { name: 'delete'; folder: string; filename: string }

export interface RcloneRun {
  command: RcloneCommand
  /** The private config for this run. rclone may rewrite it with a new token. */
  configPath: string
  /** An empty folder, so there are no credential files to find. */
  homeDir: string
}

export interface RcloneResult {
  code: number
  stdout: string
  stderr: string
}

export interface Rclone {
  available(): boolean
  run(run: RcloneRun): Promise<RcloneResult>
}

/** Always "pond:", so a folder name can never choose another remote. */
const target = (...parts: string[]) => `pond:${parts.join('/')}`

export function rcloneArgs({ command, configPath, homeDir }: RcloneRun): string[] {
  const common = [
    `--config=${configPath}`,
    `--cache-dir=${homeDir}`,
    `--temp-dir=${homeDir}`,
    '--ask-password=false',
    '--retries=3',
    '--low-level-retries=5',
    '--contimeout=30s',
    '--timeout=5m',
    // Easy on a Raspberry Pi.
    '--transfers=1',
    '--checkers=2',
  ]
  if (command.name === 'upload')
    return ['copyto', ...common, '--', command.from, target(command.folder, command.filename)]
  if (command.name === 'list')
    return ['lsjson', ...common, '--files-only', '--', target(command.folder)]
  return ['deletefile', ...common, '--', target(command.folder, command.filename)]
}

/** Nothing from Pond's own environment: no RCLONE_* or cloud variables can change a run. */
export const rcloneEnv = (homeDir: string): Record<string, string> => ({
  HOME: homeDir,
  XDG_CONFIG_HOME: homeDir,
  XDG_CACHE_HOME: homeDir,
  TMPDIR: homeDir,
})

const LIMIT_MS: Record<RcloneCommand['name'], number> = {
  upload: 6 * 60 * 60_000,
  list: 3 * 60_000,
  delete: 3 * 60_000,
}
const MAX_OUTPUT = 4 * 1024 * 1024

/** `binary` is the full path to rclone, or null if this install has none. PATH is not searched. */
export function createRclone(binary: string | null): Rclone & { stopAll(): void } {
  const running = new Set<ChildProcess>()
  return {
    available: () => binary !== null && fs.existsSync(binary),
    stopAll() {
      for (const child of running) child.kill('SIGKILL')
    },
    run(run) {
      return new Promise((resolve) => {
        const child = spawn(binary!, rcloneArgs(run), {
          env: rcloneEnv(run.homeDir),
          cwd: run.homeDir,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        running.add(child)
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (d: string) => {
          if (stdout.length < MAX_OUTPUT) stdout += d
        })
        child.stderr.setEncoding('utf8').on('data', (d: string) => {
          stderr = (stderr + d).slice(-20_000)
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS[run.command.name])
        const done = (code: number) => {
          clearTimeout(timer)
          running.delete(child)
          resolve({ code, stdout, stderr })
        }
        child.on('error', () => done(-1))
        child.on('close', (code) => done(code ?? -1))
      })
    },
  }
}

export type RemoteProblem =
  'remote_sign_in_failed' | 'remote_unreachable' | 'remote_full' | 'remote_failed'

/** A plain reason from rclone's error text. The text itself goes no further. */
export function remoteProblem(result: RcloneResult): RemoteProblem {
  const text = result.stderr
  if (/quota|insufficient.?(space|storage)|storage_exceeded|storage cap|no space/i.test(text))
    return 'remote_full'
  if (
    /invalid_grant|invalid_client|expired_access_token|invalid_access_token|unauthorized|unauthenticated|\b40[13]\b|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|bad_auth_token|couldn't fetch token|failed to authori[sz]e|empty token/i.test(
      text,
    )
  )
    return 'remote_sign_in_failed'
  if (
    /no such host|connection refused|network is unreachable|i\/o timeout|TLS handshake|certificate|deadline exceeded|dial tcp/i.test(
      text,
    )
  )
    return 'remote_unreachable'
  return 'remote_failed'
}
