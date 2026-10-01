import { CircleCheck, CircleX, FilePlus2 } from 'lucide-react'
import { useState } from 'react'
import { parseAllDocuments } from 'yaml'
import type { KubeObject } from '@shared/api'
import { kindFor, kindOf, type ResourceKind } from '@shared/resources'
import { CodeEditor } from '@renderer/components/CodeEditor'
import { useChange } from '@renderer/hooks/change'
import { useOpenObject } from '@renderer/hooks/open-object'
import { resourceFor, useResources } from '@renderer/hooks/resources'
import { useReadOnly } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { kubectl } from '@renderer/lib/kubectl'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'
import { useUi } from '@renderer/state/ui'
import { ActionDialog } from './ActionDialog'

/** Starting points, in the namespace the objects go to. */
const TEMPLATES: Record<string, (namespace: string) => string> = {
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

type Outcome = { label: string } & ({ ok: true } | { ok: false; error: string })

const labelOf = (object: KubeObject) =>
  `${object.kind}/${object.metadata?.name ?? object.metadata?.generateName ?? '…'}`

/**
 * Reads the YAML's documents into objects to create, or explains what's
 * wrong with them. Objects without a namespace go to `namespace`; kinds must
 * be ones `context` serves.
 */
function plan(
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

/** "Create from YAML": one or more objects, checked by the cluster before any is created. */
export function CreateDialog() {
  const open = useUi((ui) => ui.create)
  const setOpen = useUi((ui) => ui.setCreate)
  return open ? <Create onClose={() => setOpen(false)} /> : null
}

function Create({ onClose }: { onClose: () => void }) {
  const { context, namespace } = useCluster()
  const change = useChange()
  const openObject = useOpenObject()
  const { readOnly } = useReadOnly()
  const target = namespace ?? 'default'
  // What the cluster serves decides what can be created.
  useResources()
  const [text, setText] = useState(() => TEMPLATES.Deployment!(target))
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [pending, setPending] = useState(false)
  const command = kubectl(context, target, 'create', '-f', 'objects.yaml')

  const create = async () => {
    const { planned, problems } = plan(text, target, context)
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
        : [{ label: labelOf(planned[i]!.object), ok: false as const, error: result.error.message }],
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
          : { label: labelOf(p.object), ok: false, error: result.error.message },
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
      onClose()
    } else {
      setOutcomes(results)
    }
  }

  return (
    <ActionDialog
      icon={FilePlus2}
      title="Create from YAML"
      subject={`New objects go to ${target} unless they name a namespace`}
      command={command}
      confirmLabel="Create"
      wide
      ready={!readOnly}
      pending={pending}
      error={readOnly ? 'Changes are turned off for this cluster.' : undefined}
      onClose={onClose}
      onSubmit={() => void create()}
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Templates">
        {Object.entries(TEMPLATES).map(([kind, template]) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setText(template(target))
              setOutcomes([])
            }}
            className="h-6 rounded-md border border-line px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1"
          >
            {kind}
          </button>
        ))}
      </div>
      <div className="h-[40vh] overflow-hidden rounded-xl border border-line bg-surface-2/60">
        <CodeEditor
          value={text}
          onChange={(next) => {
            setText(next)
            setOutcomes([])
          }}
          onSave={() => void create()}
          label="YAML to create"
        />
      </div>
      <p className="text-xs text-ink-3">
        Several objects can be created at once: separate them with a line of <code>---</code>.
      </p>
      {outcomes.length > 0 && (
        <ul aria-label="Results" className="divide-y divide-line rounded-xl border border-line">
          {outcomes.map((outcome, i) => (
            <li key={i} className="flex gap-2.5 px-3 py-2 text-xs">
              {outcome.ok ? (
                <CircleCheck className="mt-px size-3.5 shrink-0 text-good-text" />
              ) : (
                <CircleX className="mt-px size-3.5 shrink-0 text-critical-text" />
              )}
              <span className="min-w-0">
                <span className="block font-mono text-ink-1">{outcome.label}</span>
                {!outcome.ok && (
                  <span className={cn('block break-words text-critical-text selectable')}>
                    {outcome.error}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ActionDialog>
  )
}
