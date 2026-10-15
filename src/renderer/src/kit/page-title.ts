/**
 * The title of the plugin's page that's open, as its tab and the bar say it: a page's Header that
 * names it again doesn't (`PageHeader`). Lumovi's, from the plugin's file, never its code's.
 */
import { createContext } from 'react'

export const PageTitle = createContext<string | undefined>(undefined)
