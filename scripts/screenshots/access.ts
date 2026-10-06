/**
 * Who may do what, for the Access screenshots: what the chart says (the
 * platform team runs everything), what the team's admins set on the page
 * (developers, on-call, contractors, and the limits that hold them back),
 * and who signed in lately, with the groups their sign-in sent.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditActor, AuditInput } from '../../src/shared/audit.ts'

/** What the chart says (LUMOVI_ACCESS): admins see it, and change it only there. */
export const ACCESS_BASE = JSON.stringify({
  groups: [
    {
      id: 'platform',
      name: 'Platform team',
      description: 'Runs the clusters',
      provider: ['platform'],
      people: [],
    },
  ],
  profiles: [
    {
      id: 'platform',
      name: 'Platform',
      values: {
        changes: 'write',
        shells: 'on',
        nodeShells: 'on',
        logs: 'on',
        secrets: 'values',
        helm: 'install',
        assistants: 'self',
        audit: 'all',
      },
    },
  ],
  grants: [
    {
      id: 'platform',
      name: 'The platform team runs everything',
      who: ['platform'],
      profile: 'platform',
    },
  ],
})

const SECURITY = '61e0b4d7-8a2f-4c95-9d3e-7b1a5f2c4e80'

/** What the admins set on the Access page, as Lumovi keeps it. */
const KEPT = {
  everyone: {
    changes: 'read',
    shells: 'off',
    nodeShells: 'off',
    logs: 'on',
    secrets: 'keys',
    helm: 'off',
    assistants: 'ask',
    audit: 'own',
  },
  groups: [
    {
      id: 'developers',
      name: 'Developers',
      description: 'Build and run their teams’ services',
      provider: ['developers'],
      people: [],
    },
    {
      id: 'oncall',
      name: 'On-call SRE',
      description: 'Whoever’s on call this week',
      provider: ['on-call'],
      people: [],
    },
    { id: 'security', name: 'Security & audit', provider: [SECURITY], people: [] },
    {
      id: 'contractors',
      name: 'Contractors',
      description: 'Acme’s team, until the migration ends',
      provider: ['contractors-acme'],
      people: ['rik@acme.dev'],
    },
  ],
  profiles: [
    {
      id: 'developer',
      name: 'Developer',
      values: {
        changes: 'write',
        shells: 'on',
        nodeShells: 'off',
        logs: 'on',
        secrets: 'keys',
        helm: 'upgrade',
        assistants: 'ask',
        audit: 'own',
      },
    },
    {
      id: 'operator',
      name: 'Operator',
      values: {
        changes: 'write',
        shells: 'on',
        nodeShells: 'on',
        logs: 'on',
        secrets: 'values',
        helm: 'install',
        assistants: 'self',
        audit: 'own',
      },
    },
    {
      id: 'auditor',
      name: 'Auditor',
      values: {
        changes: 'read',
        shells: 'off',
        nodeShells: 'off',
        logs: 'on',
        secrets: 'keys',
        helm: 'off',
        assistants: 'ask',
        audit: 'all',
      },
    },
  ],
  grants: [
    {
      id: 'dev',
      name: 'Developers build outside production',
      who: ['developers'],
      profile: 'developer',
      clusters: ['env=staging', 'env=test'],
      namespaces: [],
    },
    {
      id: 'dev-prod',
      name: 'Developers release their teams’ services',
      who: ['developers'],
      profile: 'developer',
      clusters: ['env=production'],
      namespaces: ['shop', 'batch'],
    },
    {
      id: 'oncall',
      name: 'On-call fixes production',
      who: ['oncall'],
      profile: 'operator',
      clusters: ['env=production'],
      namespaces: ['!kube-*'],
    },
    {
      id: 'audit',
      name: 'Security reads the audit log',
      who: ['security'],
      profile: 'auditor',
      clusters: [],
      namespaces: [],
    },
  ],
  limits: [
    {
      id: 'production',
      name: 'Production',
      who: [],
      clusters: ['env=production'],
      namespaces: [],
      caps: { nodeShells: 'off', helm: 'upgrade' },
    },
    {
      id: 'pci',
      name: 'Card data (PCI)',
      who: [],
      clusters: [],
      namespaces: ['data', 'pay-*'],
      caps: { secrets: 'keys', assistants: 'off' },
    },
    {
      id: 'contractors',
      name: 'Contractors look, and don’t touch',
      who: ['contractors'],
      clusters: [],
      namespaces: [],
      caps: {
        changes: 'read',
        shells: 'off',
        nodeShells: 'off',
        secrets: 'hidden',
        helm: 'off',
        assistants: 'off',
      },
    },
  ],
  names: {},
}

/** A folder holding what the admins set, as LUMOVI_DATA_DIR. */
export function accessData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-screenshots-access-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ version: 1, policy: KEPT }))
  return dir
}

const signedIn = (user: string, groups: string[]): AuditInput => ({
  action: 'session.sign-in',
  outcome: 'success',
  actor: { user, groups, via: 'ui', address: '10.42.0.17' } satisfies AuditActor,
  summary: 'Signed in through the proxy',
  details: { method: 'proxy' },
})

/** Who signed in that day, with the groups their sign-in sent. */
export const SIGN_INS: [string, AuditInput][] = [
  ['07:58:10', signedIn('ana@example.com', ['payments', 'developers'])],
  ['08:12:44', signedIn('dan@example.com', ['developers', 'on-call'])],
  ['08:20:05', signedIn('hugo@example.com', ['developers'])],
  ['08:31:51', signedIn('iris@example.com', ['developers'])],
  ['08:44:02', signedIn('mara@example.com', [SECURITY])],
  ['08:47:30', signedIn('rik@acme.dev', ['contractors-acme'])],
  ['08:55:16', signedIn('build-bot@example.com', [])],
]
