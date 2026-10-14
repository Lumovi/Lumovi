/**
 * A change a plugin's page proposes, on its way to Lumovi's own dialog: one at a time in all of
 * Lumovi. One is refused while another confirmation or approval is open, while Lumovi's window
 * isn't the one in front, on a phone, or where the backend says its plugin may not propose it;
 * otherwise it's shown (`ProposalDialog`) and the page is told only what became of it.
 */
import { create } from 'zustand'
import {
  PROPOSALS_OFF,
  type PageProposal,
  type PluginChangeRequest,
  type ProposalOutcome,
} from '@shared/plugin-changes'
import { mayStart } from '@shared/plugin-presses'
import { whose, type Harm } from '@shared/plugins'
import { api } from '@renderer/lib/api'
import type { Layout } from '@renderer/lib/layout'
import { useActionsUi } from '@renderer/state/actions'
import { useApprovals } from '@renderer/features/assistants/approvals'
import { toast } from '@renderer/state/toasts'

/** Whose page proposed it, as the dialog says it and the backend is asked. */
export interface ProposedBy {
  /** The plugin's name (its box's address), and its label and version as a person reads them. */
  plugin: string
  label: string
  version: string
  /** What its page was handed: its file's digest and its code's, as its reads name them. */
  digest: string
  codeDigest: string
  /** The cluster its page is open on. */
  context: string
  /** The namespace the person is looking at: where a create that names no object's goes. */
  namespace?: string
  /** What its file says it changes, each kind with what of a change does harm there. */
  changes?: readonly { kind: string; harm?: readonly Harm[] }[]
}

export interface ShownProposal {
  by: ProposedBy
  proposal: PageProposal
  /** Tells the page what became of it: once. */
  settle: (outcome: ProposalOutcome) => void
}

export const useProposals = create<{ shown: ShownProposal | null }>(() => ({ shown: null }))

/** What every call of this proposal asks the backend with, whatever its step. */
export function requestBase(
  by: ProposedBy,
  proposal: PageProposal,
): Omit<PluginChangeRequest, 'step'> {
  const { proposed, target, within } = proposal
  return {
    plugin: by.plugin,
    digest: by.digest,
    codeDigest: by.codeDigest,
    context: by.context,
    action: proposed.action,
    ...(target && { target }),
    ...(proposed.kind !== undefined && { kind: proposed.kind }),
    ...(proposed.action === 'create' && (within?.namespace ?? by.namespace)
      ? { namespace: within?.namespace ?? by.namespace }
      : {}),
  }
}

/** Whether something of Lumovi's own is asking the person already: a dialog, an approval. */
function asking(): boolean {
  return (
    useProposals.getState().shown !== null ||
    useActionsUi.getState().active !== null ||
    useApprovals.getState().shown !== undefined ||
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
  )
}

/**
 * Opens Lumovi's dialog for a page's proposal, where it may be: what became of it. (Refused,
 * nothing is shown but on a phone, where the person is told it isn't done there.)
 */
export async function proposeChange(
  by: ProposedBy,
  proposal: PageProposal,
  layout: Layout,
): Promise<ProposalOutcome> {
  if (mayStart('changes', layout) !== true) {
    const where = proposal.target?.name ?? proposal.within?.name
    toast({
      tone: 'info',
      title: `This isn’t done from a phone. Open Lumovi on a larger screen to ${proposal.proposed.action === 'delete' ? 'delete' : 'change'}${where ? ` ${where}` : ' it'}.`,
    })
    return 'refused'
  }
  if (asking() || !document.hasFocus()) return 'refused'
  // Asked first: one its plugin may not propose, or on a read-only cluster, opens nothing.
  const checked = await api.kube.pluginChange({ step: 'check', ...requestBase(by, proposal) })
  if (!checked.ok) {
    // (What the person can do something about is said; what only its author can isn't.)
    const kind = (proposal.target?.kind ?? proposal.proposed.kind ?? '')
      .replace(/^.*\//, '')
      .replace(/\..*$/, '')
    const said =
      checked.refused === 'read-only'
        ? `This cluster is read-only in Lumovi: ${whose(by.label)} change isn’t made here.`
        : checked.refused === 'no-namespace'
          ? `Pick one namespace to make the new ${kind} in, then try again.`
          : checked.refused === 'not-allowed'
            ? `You may not make ${whose(by.label)} change here.`
            : checked.refused === 'off-by-policy'
              ? PROPOSALS_OFF
              : undefined
    if (said) toast({ tone: 'info', title: said })
    return 'refused'
  }
  if (asking() || !document.hasFocus()) return 'refused'
  return new Promise((resolve) => {
    let settled = false
    useProposals.setState({
      shown: {
        by,
        proposal,
        settle: (outcome) => {
          if (settled) return
          settled = true
          useProposals.setState({ shown: null })
          resolve(outcome)
        },
      },
    })
  })
}
