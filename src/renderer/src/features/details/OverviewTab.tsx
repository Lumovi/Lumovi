import type { ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { useMetrics } from '@renderer/hooks/queries'
import { factsFor } from './facts'
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

const EXTRA_SECTIONS: Partial<Record<ResourceKind, (props: { object: KubeObject }) => ReactNode>> =
  {
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
  const Extra = EXTRA_SECTIONS[object.kind as ResourceKind]
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
              value: (
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
