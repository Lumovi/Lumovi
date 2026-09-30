/** Deterministic, realistic-looking container logs for the demo cluster. */
import { random } from '../builders.ts'
import type { KubeObject } from '../types.ts'

type Rng = () => number

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
const hex = (rng: Rng, length: number) =>
  Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join('')
const json = (fields: Record<string, unknown>) => JSON.stringify(fields)

const SHOP_PATHS = [
  '/api/products',
  '/api/products?page=2',
  '/api/products/sku-1042',
  '/api/products/sku-2231',
  '/api/cart',
  '/api/cart/items',
  '/api/recommendations',
  '/api/session',
  '/healthz',
  '/static/app.8f3c1d.js',
]

function storefront(rng: Rng, count: number): string[] {
  const lines = [
    json({ level: 'info', msg: 'starting storefront', version: 'v3.8.2', commit: '9c41e7b' }),
    json({ level: 'info', msg: 'loaded configuration', source: '/etc/storefront/config.yaml' }),
    json({ level: 'info', msg: 'connected to cache', addr: 'cart.shop.svc.cluster.local:6379' }),
    json({ level: 'info', msg: 'http server listening', addr: ':8080' }),
  ]
  for (let i = 0; i < count; i++) {
    const roll = rng()
    const path = pick(rng, SHOP_PATHS)
    const method = path === '/api/cart/items' && rng() > 0.5 ? 'POST' : 'GET'
    const requestId = hex(rng, 12)
    if (roll < 0.01) {
      lines.push(
        json({
          level: 'error',
          msg: 'upstream request failed',
          upstream: 'checkout.shop.svc.cluster.local:8080',
          status: 503,
          error: 'no healthy upstream',
          request_id: requestId,
        }),
      )
    } else if (roll < 0.04) {
      lines.push(
        json({
          level: 'warn',
          msg: 'slow request',
          method,
          path,
          duration_ms: 900 + Math.floor(rng() * 1800),
          request_id: requestId,
        }),
      )
    } else {
      const status = roll < 0.06 ? 404 : method === 'POST' ? 201 : roll < 0.12 ? 304 : 200
      lines.push(
        json({
          level: 'info',
          msg: 'request completed',
          method,
          path,
          status,
          duration_ms: 3 + Math.floor(rng() * 60),
          request_id: requestId,
        }),
      )
    }
  }
  return lines
}

function envoy(rng: Rng, count: number): string[] {
  return Array.from({ length: count }, () => {
    const path = pick(rng, SHOP_PATHS)
    const probe = path === '/healthz'
    const agent = probe
      ? 'kube-probe/1.34'
      : pick(rng, ['Mozilla/5.0 (Macintosh)', 'Mozilla/5.0 (iPhone)', 'curl/8.9.1'])
    const bytes = probe ? 2 : 400 + Math.floor(rng() * 9000)
    const duration = 1 + Math.floor(rng() * 40)
    return `"GET ${path} HTTP/1.1" 200 - 0 ${bytes} ${duration} ${duration - 1} "10.244.${Math.floor(rng() * 3)}.${Math.floor(rng() * 200)}" "${agent}" "${hex(rng, 8)}-${hex(rng, 4)}" "storefront.shop:8080" "127.0.0.1:8080"`
  })
}

const MIGRATE = [
  'migrate: connecting to postgres://storefront@postgres.data.svc.cluster.local:5432/storefront',
  'migrate: current schema version 41',
  'migrate: applying 042_add_wishlist_table.sql',
  'migrate: applying 043_backfill_wishlist_owner.sql',
  'migrate: applying 044_index_products_on_category.sql',
  'migrate: schema is up to date (version 44)',
]

function checkoutCrash(rng: Rng, attempts: number): string[] {
  const lines = [
    json({ level: 'info', msg: 'starting checkout service', version: 'v1.14.0' }),
    json({ level: 'info', msg: 'loading config', path: '/etc/checkout/config.yaml' }),
    json({
      level: 'info',
      msg: 'connecting to postgres',
      host: 'postgres.data.svc.cluster.local:5432',
    }),
  ]
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lines.push(
      json({
        level: 'warn',
        msg: 'database connection failed, retrying',
        attempt,
        backoff_ms: 250 * 2 ** attempt,
        error: 'dial tcp 10.96.201.14:5432: connect: connection refused',
      }),
    )
  }
  lines.push(
    json({
      level: 'error',
      msg: 'payments client not initialised',
      provider: 'stripe',
      error: 'missing PAYMENTS_API_KEY',
    }),
    'panic: runtime error: invalid memory address or nil pointer dereference',
    `[signal SIGSEGV: segmentation violation code=0x1 addr=0x28 pc=0x${hex(rng, 6)}]`,
    '',
    'goroutine 1 [running]:',
    `github.com/acme/checkout/internal/payments.(*Client).Authorize(0x0, {0x1a2b3c0, 0xc0001${hex(rng, 5)}})`,
    '\t/src/internal/payments/client.go:88 +0x3b',
    'github.com/acme/checkout/internal/server.New(...)',
    '\t/src/internal/server/server.go:41 +0x1c5',
    'main.main()',
    '\t/src/cmd/checkout/main.go:64 +0x412',
  )
  return lines
}

function checkoutHealthy(rng: Rng, count: number): string[] {
  const lines = [
    json({ level: 'info', msg: 'starting checkout service', version: 'v1.13.2' }),
    json({ level: 'info', msg: 'connected to postgres', pool_size: 20 }),
  ]
  for (let i = 0; i < count; i++) {
    const order = `ord_${hex(rng, 10)}`
    lines.push(
      rng() < 0.08
        ? json({
            level: 'warn',
            msg: 'payment declined',
            order,
            reason: pick(rng, ['insufficient_funds', 'card_expired']),
          })
        : json({
            level: 'info',
            msg: 'order placed',
            order,
            items: 1 + Math.floor(rng() * 5),
            total_cents: 999 + Math.floor(rng() * 25000),
          }),
    )
  }
  return lines
}

function postgres(rng: Rng, count: number): string[] {
  const lines = [
    'LOG:  starting PostgreSQL 17.6 on x86_64-pc-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit',
    'LOG:  listening on IPv4 address "0.0.0.0", port 5432',
    'LOG:  database system was shut down at 2025-09-01 03:12:44 UTC',
    'LOG:  database system is ready to accept connections',
  ]
  for (let i = 0; i < count; i++) {
    if (rng() < 0.5) {
      lines.push('LOG:  checkpoint starting: time')
      const buffers = 200 + Math.floor(rng() * 3000)
      lines.push(
        `LOG:  checkpoint complete: wrote ${buffers} buffers (${(buffers / 163.84).toFixed(1)}%); 0 WAL file(s) added, 0 removed, 1 recycled; write=${(rng() * 30).toFixed(3)} s, sync=0.004 s, total=${(rng() * 30 + 0.1).toFixed(3)} s`,
      )
    } else {
      lines.push(
        `LOG:  automatic vacuum of table "storefront.public.${pick(rng, ['orders', 'carts', 'sessions', 'products'])}": index scans: 1`,
      )
    }
  }
  return lines
}

function redis(rng: Rng, count: number): string[] {
  const lines = [
    '1:C * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo',
    '1:C * Redis version=8.2.1, bits=64, commit=00000000, modified=0, pid=1, just started',
    '1:M * Server initialized',
    '1:M * Ready to accept connections tcp',
  ]
  for (let i = 0; i < count; i++) {
    const pid = 40 + i
    lines.push(
      `1:M * ${pick(rng, ['100 changes in 300 seconds', '10000 changes in 60 seconds'])}. Saving...`,
      `1:M * Background saving started by pid ${pid}`,
      `${pid}:C * DB saved on disk`,
      '1:M * Background saving terminated with success',
    )
  }
  return lines
}

function coredns(rng: Rng, count: number): string[] {
  const names = [
    'storefront.shop.svc.cluster.local.',
    'postgres.data.svc.cluster.local.',
    'kubernetes.default.svc.cluster.local.',
    'api.stripe.com.',
  ]
  return [
    '.:53',
    '[INFO] plugin/reload: Running configuration SHA512 = 591cf328cccc12bc490481273e738df59329c62c0b729d94e8b61db9961c2fa5',
    'CoreDNS-1.12.1',
    'linux/amd64, go1.24.1, 707c7c1',
    ...Array.from({ length: count }, () => {
      const name = pick(rng, names)
      const type = rng() < 0.7 ? 'A' : 'AAAA'
      const code = name.startsWith('api.') || type === 'A' ? 'NOERROR' : 'NXDOMAIN'
      return `[INFO] 10.244.${Math.floor(rng() * 3)}.${Math.floor(rng() * 200)}:${40000 + Math.floor(rng() * 20000)} - ${Math.floor(rng() * 65535)} "${type} IN ${name} udp ${40 + name.length} false 512" ${code} qr,aa,rd ${90 + Math.floor(rng() * 60)} 0.000${100 + Math.floor(rng() * 800)}s`
    }),
  ]
}

function logfmt(rng: Rng, count: number, messages: readonly string[], source: string): string[] {
  return Array.from(
    { length: count },
    () => `level=${rng() < 0.05 ? 'WARN' : 'INFO'} source=${source} msg="${pick(rng, messages)}"`,
  )
}

const GRAFANA_PATHS = [
  '/api/dashboards/uid/cluster-overview',
  '/api/search',
  '/api/health',
  '/api/datasources/proxy/uid/prometheus/api/v1/query_range',
]

export function demoLogs(pod: KubeObject, container: string, previous: boolean): string[] {
  const app = pod.metadata.labels?.['app.kubernetes.io/name'] ?? pod.metadata.name
  const rng = random(`${pod.metadata.name}/${container}/${previous}`)
  switch (`${app}/${container}`) {
    case 'storefront/app':
      return storefront(rng, 620)
    case 'storefront/envoy':
      return envoy(rng, 320)
    case 'storefront/migrate':
      return MIGRATE
    case 'checkout/app': {
      const crashing = pod.status?.containerStatuses?.[0]?.restartCount > 0
      if (!crashing) return checkoutHealthy(rng, 240)
      return checkoutCrash(rng, previous ? 4 : 5)
    }
    case 'cart/app':
      return logfmt(
        rng,
        180,
        ['cart updated', 'cart fetched', 'cache hit', 'cache miss', 'session refreshed'],
        'cart.go:77',
      )
    case 'postgres/postgres':
      return postgres(rng, 90)
    case 'redis/redis':
      return redis(rng, 30)
    case 'coredns/coredns':
      return coredns(rng, 260)
    case 'node-exporter/node-exporter':
      return [
        'level=INFO source=node_exporter.go:216 msg="Starting node_exporter" version="(version=1.9.1, branch=HEAD)"',
        'level=INFO source=filesystem_common.go:111 msg="Parsed flag --collector.filesystem.mount-points-exclude"',
        'level=INFO source=node_exporter.go:135 msg="Enabled collectors"',
        'level=INFO source=tls_config.go:347 msg="Listening on" address=[::]:9100',
        'level=INFO source=tls_config.go:350 msg="TLS is disabled." http2=false address=[::]:9100',
      ]
    case 'prometheus/prometheus':
      return logfmt(
        rng,
        160,
        [
          'Head GC completed',
          'Creating checkpoint',
          'WAL checkpoint complete',
          'Compaction completed',
          'Completed loading of configuration file',
        ],
        'head.go:1402',
      )
    case 'grafana/grafana':
      return Array.from(
        { length: 140 },
        () =>
          `logger=context userId=1 orgId=1 uname=admin level=info msg="Request Completed" method=GET path=${pick(rng, GRAFANA_PATHS)} status=200 remote_addr=10.244.1.1 time_ms=${1 + Math.floor(rng() * 90)} duration=${(rng() * 90).toFixed(3)}ms size=${200 + Math.floor(rng() * 40000)}`,
      )
    case 'search-indexer/indexer':
      return Array.from({ length: 120 }, (_, i) => {
        const done = (i + 1) * 380
        return `reindex: ${done}/50000 documents (${((done / 50000) * 100).toFixed(1)}%) rate=${360 + Math.floor(rng() * 90)} docs/s`
      })
    case 'db-migrate/migrator':
      return [
        'migrator: connecting to postgres.data.svc.cluster.local:5432/orders',
        'migrator: found 3 pending migrations',
        'migrator: running 2025_09_12_add_order_index',
        'ERROR: relation "orders_created_at_idx" already exists (SQLSTATE 42P07)',
        'migrator: migration 2025_09_12_add_order_index failed, rolling back',
        'migrator: exiting with code 2',
      ]
    case 'nightly-report/reporter':
      return [
        'reporter: collecting orders for the previous day',
        'reporter: 18,432 orders, 2,107 refunds',
        'reporter: rendering report (pdf, csv)',
        'reporter: uploaded s3://acme-reports/daily/report.pdf',
        'reporter: done in 41.2s',
      ]
    case 'debug-shell/shell':
      return []
    case 'stuck-terminating/nginx':
      return [
        '/docker-entrypoint.sh: Configuration complete; ready for start up',
        ...Array.from(
          { length: 30 },
          () =>
            `10.244.${Math.floor(rng() * 3)}.${Math.floor(rng() * 200)} - - "GET / HTTP/1.1" 200 615 "-" "curl/8.9.1"`,
        ),
        '2025/09/30 09:54:12 [notice] 1#1: signal 3 (SIGQUIT) received, shutting down',
        '2025/09/30 09:54:12 [notice] 29#29: gracefully shutting down',
      ]
    case 'old-task/task':
      return ['task: processing batch 1/1', 'task: finished successfully']
    default:
      return logfmt(
        rng,
        60,
        ['sync completed', 'watch established', 'leader election renewed', 'cache synced'],
        `${container}.go:120`,
      )
  }
}
