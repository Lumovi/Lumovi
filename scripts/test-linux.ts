/**
 * Runs the e2e tests on Linux in Docker, the way CI does: Ubuntu, Node.js 26, Xvfb's
 * screen, no mouse. `npm run test:linux`, or with Playwright's arguments:
 * `npm run test:linux -- tests/e2e/logs.spec.ts`.
 *
 * The checkout is copied into a Docker volume, which keeps Linux's node_modules between
 * runs, so nothing here changes. Failures' traces land in test-results-linux/.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { version } = JSON.parse(
  readFileSync('node_modules/@playwright/test/package.json', 'utf8'),
) as { version: string }
const node = readFileSync('.nvmrc', 'utf8').trim()
const image = `kubestacks-test-linux:${version}-node${node}`

// Playwright's image (Chromium's libraries, Xvfb), with the Node.js the project uses.
const dockerfile = `
FROM node:${node}-bookworm-slim AS node
FROM mcr.microsoft.com/playwright:v${version}-noble
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
`
const built = spawnSync('docker', ['build', '--quiet', '-t', image, '-'], {
  input: dockerfile,
  stdio: ['pipe', 'ignore', 'inherit'],
})
if (built.status !== 0) process.exit(built.status ?? 1)
const results = resolve('test-results-linux')
mkdirSync(results, { recursive: true })

const script = String.raw`
set -e
# A fresh copy of the checkout, next to the node_modules kept from last time.
find /work -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -C /src --exclude=./node_modules --exclude=./out --exclude=./.git --exclude=./release \
  --exclude='./test-results*' --exclude='./playwright-report*' --exclude=./coverage \
  --exclude='./.nyc_output*' --exclude=./.kind -cf - . | tar -C /work -xf -
cd /work
lock="$(sha256sum package-lock.json | cut -d' ' -f1) $(node --version)"
if [ "$(cat node_modules/.installed 2>/dev/null)" != "$lock" ]; then
  npm ci
  echo "$lock" > node_modules/.installed
fi
npm run build:coverage
status=0
xvfb-run --auto-servernum npx playwright test "$@" || status=$?
find /results -mindepth 1 -delete
cp -r test-results/. /results/ 2>/dev/null || true
exit $status
`

const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    // Nobody's watching the container's display: draw the windows, as fully transparent
    // ones render slowly on Linux.
    '-e',
    'KUBESTACKS_E2E_OPAQUE=1',
    // Containers run as root, which Chromium's sandbox refuses.
    '-e',
    'ELECTRON_DISABLE_SANDBOX=1',
    '-v',
    `${process.cwd()}:/src:ro`,
    '-v',
    'kubestacks-linux:/work',
    '-v',
    `${results}:/results`,
    image,
    'bash',
    '-c',
    script,
    'test-linux',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
)
process.exit(run.status ?? 1)
