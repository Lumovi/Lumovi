/** Runs at most `max` tasks at a time; the rest wait their turn. */
export class Limiter {
  #active = 0
  readonly #waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) await new Promise<void>((resolve) => this.#waiting.push(resolve))
    this.#active++
    try {
      return await task()
    } finally {
      this.#active--
      this.#waiting.shift()?.()
    }
  }
}
