/**
 * The rows a person has ticked on a plugin's page, by the objects they open: Lumovi's alone, and
 * never told to the plugin. Lumovi's own bar offers its file's actions for them (`bulk`), and the
 * plugin's code neither picks rows nor starts a change to several.
 */
import { createContext } from 'react'
import type { ObjectRef } from '@shared/kit/declare'

export interface Ticks {
  ticked: ReadonlyMap<string, ObjectRef>
  set: (next: ReadonlyMap<string, ObjectRef>) => void
}

/** Where a page keeps its ticks: none, and no table ticks. */
export const TickedRows = createContext<Ticks | undefined>(undefined)

/** An object's key among the ticked: its kind, namespace and name. */
export const tickKey = (object: ObjectRef) =>
  `${object.kind}\n${object.namespace ?? ''}\n${object.name}`
