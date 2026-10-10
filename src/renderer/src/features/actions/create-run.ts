/**
 * Creating objects from YAML, whichever way the YAML was written (by hand, or by Create's
 * form): reading it into objects, having the cluster check them all before any is made, and
 * making them.
 */
import { useState } from 'react'
import { parseAllDocuments } from 'yaml'
import type { KubeErrorCause, KubeObject } from '@shared/api'
import { kindFor, kindOf, type ResourceKind } from '@shared/resources'
import { useChange } from '@renderer/hooks/change'
import { useOpenObject } from '@renderer/hooks/open-object'
import { resourceFor } from '@renderer/hooks/resources'
import { api } from '@renderer/lib/api'
import { kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'

/** Starting points, in the namespace the objects go to. */
export const TEMPLATES: Record<string, (namespace: string) => string> = {
  Deployment: (ns) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: ${ns}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
`,
  Service: (ns) => `apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: ${ns}
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
`,
  ConfigMap: (ns) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: ${ns}
data:
  LOG_LEVEL: info
`,
  Secret: (ns) => `apiVersion: v1
kind: Secret
metadata:
  name: credentials
  namespace: ${ns}
type: Opaque
stringData:
  password: change-me
`,
  Job: (ns) => `apiVersion: batch/v1
kind: Job
metadata:
  name: hello
  namespace: ${ns}
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: hello
          image: busybox:1.37
          command: [sh, -c, echo hello]
`,
  CronJob: (ns) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
  namespace: ${ns}
spec:
  schedule: "*/15 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: hello
              image: busybox:1.37
              command: [sh, -c, date]
`,
  Namespace: () => `apiVersion: v1
kind: Namespace
metadata:
  name: playground
`,
}

interface Planned {
  kind: ResourceKind
  name: string
  namespace?: string
  object: KubeObject
}

/** What an object came to: created, or not and why (with the fields the cluster names). */
export type Outcome = { label: string } & (
  { ok: true } | { ok: false; error: string; causes?: KubeErrorCause[] }
)

const labelOf = (object: KubeObject) =>
  `${object.kind}/${object.metadata?.name ?? object.metadata?.generateName ?? '…'}`

/**
 * Reads the YAML's documents into objects to create, or explains what's
 * wrong with them. Objects without a namespace go to `namespace`; kinds must
 * be ones `context` serves.
 */
export function plan(
  text: string,
  namespace: string,
  context: string,
): { planned: Planned[]; problems: Outcome[] } {
  const planned: Planned[] = []
  const problems: Outcome[] = []
  for (const document of parseAllDocuments(text)) {
    if (document.errors.length) {
      problems.push({ label: 'YAML', ok: false, error: document.errors[0]!.message })
      continue
    }
    const object = document.toJS() as KubeObject | null
    // Empty documents, like one after a trailing ---, are fine.
    if (object === null) continue
    if (typeof object !== 'object' || typeof object.kind !== 'string') {
      problems.push({
        label: 'YAML',
        ok: false,
        error: 'Each object needs a kind, like Deployment.',
      })
      continue
    }
    const kind = kindFor(object.apiVersion, object.kind)
    const resource = resourceFor(kind)
    if (!resource) {
      problems.push({
        label: labelOf(object),
        ok: false,
        error: object.apiVersion
          ? `${context} doesn’t serve ${object.kind} in ${object.apiVersion}. If its CustomResourceDefinition is in this YAML too, create that first.`
          : `Add its apiVersion, like example.com/v1: ${context} serves no ${object.kind} without one.`,
      })
      continue
    }
    const ns = resource.namespaced ? (object.metadata?.namespace ?? namespace) : undefined
    const metadata = { ...object.metadata, ...(ns ? { namespace: ns } : {}) }
    planned.push({
      kind,
      name: metadata.name ?? metadata.generateName,
      namespace: ns,
      object: { ...object, metadata },
    })
  }
  return { planned, problems }
}

/** The command that does the same, for objects that go to `namespace` unless they say. */
export const createCommand = (context: string, namespace: string) =>
  kubectl(context, namespace, 'create', '-f', 'objects.yaml')

/**
 * Creates what a YAML text holds, in `namespace` where an object names none: checked by the
 * cluster first, so nothing is made when something is wrong. `outcomes` is what each object
 * came to when not all went well; when all did, a toast offers to open the first and
 * `onDone` is called.
 */
export function useCreating(namespace: string, onDone: () => void) {
  const { context } = useCluster()
  const change = useChange()
  const openObject = useOpenObject()
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [pending, setPending] = useState(false)
  const command = createCommand(context, namespace)

  const create = async (text: string) => {
    const { planned, problems } = plan(text, namespace, context)
    if (problems.length || planned.length === 0) {
      setOutcomes(
        problems.length
          ? problems
          : [{ label: 'YAML', ok: false, error: 'There’s nothing to create.' }],
      )
      return
    }
    setPending(true)
    // The cluster checks everything first, so nothing is created when something is wrong.
    const checks = await Promise.all(
      planned.map((p) =>
        api.kube.change({
          context,
          kind: p.kind,
          namespace: p.namespace,
          change: { action: 'create', object: p.object },
          dryRun: true,
        }),
      ),
    )
    const refused = checks.flatMap((result, i) =>
      result.ok
        ? []
        : [
            {
              label: labelOf(planned[i]!.object),
              ok: false as const,
              error: result.error.message,
              ...(result.error.causes ? { causes: result.error.causes } : {}),
            },
          ],
    )
    if (refused.length) {
      setPending(false)
      setOutcomes(refused)
      return
    }
    const results: Outcome[] = []
    let first: KubeObject | undefined
    for (const p of planned) {
      const result = await change(
        { kind: p.kind, namespace: p.namespace, change: { action: 'create', object: p.object } },
        { title: `Created ${p.object.kind!.toLowerCase()} ${p.name}`, command, silent: true },
      )
      // The server names objects that only have a generateName.
      if (result.ok) first ??= result.data!
      results.push(
        result.ok
          ? { label: labelOf(result.data!), ok: true }
          : {
              label: labelOf(p.object),
              ok: false,
              error: result.error.message,
              ...(result.error.causes ? { causes: result.error.causes } : {}),
            },
      )
    }
    setPending(false)
    if (results.every((r) => r.ok)) {
      const { metadata } = first!
      toast({
        tone: 'success',
        title:
          planned.length === 1
            ? `Created ${first!.kind!.toLowerCase()} ${metadata.name}`
            : `Created ${planned.length} objects`,
        action: {
          label: 'Open',
          run: () => openObject(kindOf(first!), metadata.name, metadata.namespace),
        },
      })
      onDone()
    } else {
      setOutcomes(results)
    }
  }

  return { outcomes, setOutcomes, pending, command, create }
}
