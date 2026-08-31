import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { assertE2EDatabaseGuard, requireE2ERunnerEnvironment } from './e2e-fixture.js'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const { runId, databaseUrl } = requireE2ERunnerEnvironment()
const environment = {
  ...process.env,
  E2E_RUN_ID: runId,
  E2E_DATABASE_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: 'http://127.0.0.1:4173',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  VITE_YANDEX_MAPS_API_KEY: 'kabanda-e2e-yandex-mock',
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

const guardPool = new Pool({ connectionString: databaseUrl, max: 1 })
try {
  await assertE2EDatabaseGuard(guardPool)
} finally {
  await guardPool.end()
}
await run('pnpm', ['db:migrate'])
await run('pnpm', ['build'])
await run('pnpm', ['exec', 'playwright', 'test'])
