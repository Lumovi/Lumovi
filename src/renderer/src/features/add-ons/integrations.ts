import type { ComponentType } from 'react'
import { KarpenterPage } from './KarpenterPage'

/**
 * Add-ons KubeStacks knows more about than their views say: their page is an
 * overview of their own, in the first tab, instead of every object in a list.
 */
export const ADD_ON_PAGES: Partial<Record<string, { label: string; Page: ComponentType }>> = {
  karpenter: { label: 'Overview', Page: KarpenterPage },
}
