/**
 * What's shown by reference, with the cases that break it first, on the tests' build's page
 * for the kit's parts (KitPage.tsx). The page stands in for the door: it hands the parts the
 * references a door would have made from tokens, to the demo cluster's own Secrets.
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import type { By } from '@shared/kit/shown'
import { Stack } from './Arrangements'
import { EventsShown, LogsShown, SecretShown } from './Shown'

/** Whose page it is, as the door would say it. */
const BY: By = { name: 'Sample plugin', version: '1.0.0' }

export function KitShown() {
  // (A pod's name is the cluster's to make up: the tests say which, in the address.)
  const pod = useSearchParams()[0].get('pod') ?? 'storefront'
  const [elsewhere, setElsewhere] = useState(false)
  return (
    <div className="p-8 phone:p-4">
      <Stack>
        {/* A Secret of the cluster's, with a key it has no such key for. */}
        {/* The plugin points the same card at another Secret with the same keys: as a door would
            hand it a new description. */}
        <button
          type="button"
          onClick={() => setElsewhere(!elsewhere)}
          className="self-start text-xs text-ink-3 underline phone:flex phone:h-11 phone:items-center"
        >
          {elsewhere ? 'Point the first card back' : 'Point the first card elsewhere'}
        </button>
        <SecretShown
          by={BY}
          shown={{
            title: 'Storefront certificate',
            secret: {
              namespace: 'shop',
              name: elsewhere ? 'registry-pull' : 'storefront-tls',
              keys: ['tls.crt', 'tls.key', 'token'],
            },
          }}
        />
        {/* The description narrows the file's keys, and can't add to them. */}
        <SecretShown
          by={BY}
          shown={{
            title: 'Only the certificate',
            secret: { namespace: 'shop', name: 'storefront-tls', keys: ['tls.crt', 'tls.key'] },
            keys: ['tls.crt', 'ca.crt'],
          }}
        />
        <SecretShown
          by={BY}
          shown={{
            title: 'Database password',
            secret: { namespace: 'data', name: 'postgres-credentials', keys: ['password'] },
          }}
        />
        <SecretShown
          by={BY}
          shown={{
            title: 'Gone',
            secret: { namespace: 'shop', name: 'no-such-secret', keys: ['token'] },
          }}
        />
        <SecretShown
          by={BY}
          off
          shown={{
            title: 'Not on this server',
            secret: { namespace: 'shop', name: 'storefront-tls', keys: ['tls.crt'] },
          }}
        />
        <SecretShown by={BY} from="Certificate" shown={{ title: 'Names none' }} />
        {/* The description asks for a key the file doesn't allow: none is left to show. */}
        <SecretShown
          by={BY}
          shown={{
            title: 'No keys left',
            secret: { namespace: 'shop', name: 'storefront-tls', keys: ['tls.crt'] },
            keys: ['ca.crt'],
          }}
        />
        {/* What a plugin pointed at is gone by the time the page is drawn. */}
        <LogsShown by={BY} shown={{ title: 'Logs of nothing' }} />
        <EventsShown by={BY} shown={{ title: 'Events of nothing' }} />
        {/* Logs and events stand below the fold: nothing of them is read until they're in view. */}
        <LogsShown
          by={BY}
          shown={{ title: 'Logs', pod: { kind: 'Pod', name: pod, namespace: 'shop' } }}
        />
        <LogsShown
          by={BY}
          shown={{
            title: 'Logs of a pod that’s gone',
            pod: { kind: 'Pod', name: 'gone-pod', namespace: 'shop' },
          }}
        />
        <EventsShown
          by={BY}
          shown={{
            title: 'Events',
            of: { kind: 'Deployment', name: 'storefront', namespace: 'shop' },
          }}
        />
      </Stack>
    </div>
  )
}
