/** A line in the server's log (`kubectl logs`): who signed in and out, and what failed. */
export function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`)
}
