/**
 * A list saved as CSV, as Lumovi saves every list it shows, its own and a plugin's table: written
 * by Lumovi (never by a plugin), with the formula guard of `toCsv`, and said in Lumovi's toast:
 * "Saved <name>", and Show in Finder where the file can be shown.
 */
import { REVEAL } from '@renderer/features/welcome/clusters'
import { api } from '@renderer/lib/api'
import { toCsv } from '@renderer/lib/csv'
import { toast } from '@renderer/state/toasts'

export async function saveCsv(
  name: string,
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): Promise<void> {
  const saved = await api.app.saveFile(name, toCsv(header, rows))
  if (!saved.ok) {
    toast({ tone: 'error', title: `Couldn’t save ${name}`, description: saved.error.message })
  } else if (saved.data) {
    const { token } = saved.data
    toast({
      tone: 'success',
      title: `Saved ${saved.data.name}`,
      ...(token && api.app.showSaved
        ? { action: { label: REVEAL, run: () => void api.app.showSaved!(token) } }
        : {}),
    })
  }
}
