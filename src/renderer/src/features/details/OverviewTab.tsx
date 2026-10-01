import type { ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import { isBuiltinKind, kindOf, type BuiltinKind } from '@shared/resources'
import { useMetrics } from '@renderer/hooks/queries'
import { resourceFor, useSchema } from '@renderer/hooks/resources'
import { viewFor, viewLinks } from '@renderer/lib/views'
import { factsFor } from './facts'
import { FieldTree } from './FieldTree'
import { ObjectLink } from './ObjectLink'
import { LAST_APPLIED } from './YamlTab'
import {
  Conditions,
  Containers,
  DataEntries,
  IngressRules,
  KeyValueGrid,
  Labels,
  NodeCapacity,
  Section,
  ServicePorts,
  Taints,
} from './sections'

function PodSections({ object }: { object: KubeObject }) {
  const metrics = useMetrics('pods', object.metadata.namespace)
  const usage = metrics.data?.items.find((s) => s.name === object.metadata.name)
  return (
    <Section title="Containers">
      <Containers pod={object} usage={usage?.containers} />
    </Section>
  )
}

function NodeSections({ object }: { object: KubeObject }) {
  const metrics = useMetrics('nodes')
  const usage = metrics.data?.items.find((s) => s.name === object.metadata.name)
  const taints = object.spec.taints ?? []
  return (
    <>
      <Section title="Capacity">
        <NodeCapacity node={object} usage={usage} />
      </Section>
      {taints.length > 0 && (
        <Section title="Taints">
          <Taints taints={taints} />
        </Section>
      )}
    </>
  )
}

function TemplateSection({ object }: { object: KubeObject }) {
  const template =
    object.kind === 'CronJob' ? object.spec.jobTemplate.spec.template : object.spec.template
  const containers: { name: string; image: string }[] = template.spec.containers
  return (
    <Section title="Pod template">
      <KeyValueGrid
        entries={containers.map((c) => ({
          label: c.name,
          value: <span className="font-mono text-xs">{c.image}</span>,
        }))}
      />
    </Section>
  )
}

function DataSection({ object }: { object: KubeObject }) {
  const data = (object.data ?? {}) as Record<string, string>
  return (
    <Section title="Data">
      {Object.keys(data).length > 0 ? (
        <DataEntries data={data} secret={object.kind === 'Secret'} />
      ) : (
        <p className="text-ink-3">No data.</p>
      )}
    </Section>
  )
}

/** What a custom resource relates to (from its view), and its spec and status as trees. */
function CustomSections({ object }: { object: KubeObject }) {
  const kind = kindOf(object)
  const schema = useSchema(kind).data ?? undefined
  const view = viewFor(kind)
  const links = view ? viewLinks(view, object, (target) => resourceFor(target)?.namespaced) : []
  // Conditions have a section of their own.
  const { conditions: _conditions, ...status } = (object.status ?? {}) as Record<string, unknown>
  const spec = (object.spec ?? {}) as Record<string, unknown>
  // Some kinds keep their fields at the top (a ServiceAccount's, a Role's rules…).
  const {
    apiVersion: _apiVersion,
    kind: _kind,
    metadata: _metadata,
    spec: _spec,
    status: _status,
    ...fields
  } = object
  return (
    <>
      {links.length > 0 && (
        <Section title="Related">
          <KeyValueGrid
            entries={links.map((link) => ({
              label: link.name,
              value: (
                <ObjectLink kind={link.kind} name={link.objectName} namespace={link.namespace} />
              ),
            }))}
          />
        </Section>
      )}
      {Object.keys(spec).length > 0 && (
        <Section title="Spec">
          <FieldTree label="Spec" value={spec} schema={schema?.properties?.spec} />
        </Section>
      )}
      {Object.keys(fields).length > 0 && (
        <Section title="Fields">
          <FieldTree label="Fields" value={fields} schema={schema} />
        </Section>
      )}
      {Object.keys(status).length > 0 && (
        <Section title="Status">
          <FieldTree label="Status" value={status} schema={schema?.properties?.status} />
        </Section>
      )}
    </>
  )
}

const EXTRA_SECTIONS: Partial<Record<BuiltinKind, (props: { object: KubeObject }) => ReactNode>> = {
  Pod: PodSections,
  Node: NodeSections,
  Deployment: TemplateSection,
  StatefulSet: TemplateSection,
  DaemonSet: TemplateSection,
  ReplicaSet: TemplateSection,
  Job: TemplateSection,
  CronJob: TemplateSection,
  Service: ({ object }) => (
    <Section title="Ports">
      <ServicePorts service={object} />
    </Section>
  ),
  Ingress: ({ object }) => (
    <Section title="Rules">
      <IngressRules ingress={object} />
    </Section>
  ),
  ConfigMap: DataSection,
  Secret: DataSection,
}

export function OverviewTab({ object }: { object: KubeObject }) {
  const kind = kindOf(object)
  const Extra = isBuiltinKind(kind) ? EXTRA_SECTIONS[kind] : CustomSections
  const conditions = object.status?.conditions ?? []
  const labels = object.metadata.labels ?? {}
  const annotations = Object.entries(object.metadata.annotations ?? {})
  return (
    <div className="divide-y divide-line pb-6">
      <Section title="Details">
        <KeyValueGrid entries={factsFor(object)} />
      </Section>
      {Extra && <Extra object={object} />}
      {conditions.length > 0 && (
        <Section title="Conditions">
          <Conditions
            conditions={conditions}
            settled={['Succeeded', 'Failed'].includes(object.status?.phase)}
          />
        </Section>
      )}
      {Object.keys(labels).length > 0 && (
        <Section title="Labels">
          <Labels labels={labels} />
        </Section>
      )}
      {annotations.length > 0 && (
        <Section title="Annotations">
          <KeyValueGrid
            entries={annotations.map(([key, value]) => ({
              label: key,
              value:
                kind === 'Secret' && key === LAST_APPLIED ? (
                  // It holds the values: they're revealed in the YAML tab.
                  <span className="text-xs text-ink-3">Hidden: it holds the secret’s values</span>
                ) : (
                  <span className="line-clamp-3 font-mono text-xs text-ink-2" title={value}>
                    {value}
                  </span>
                ),
            }))}
          />
        </Section>
      )}
    </div>
  )
}
