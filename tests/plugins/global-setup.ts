import { runTempFolder } from '../temp-folders.ts'

/** The run's own temp folder, which its end removes (../temp-folders.ts). */
export default function globalSetup(): () => void {
  return runTempFolder()
}
