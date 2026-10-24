/**
 * Where a search is run on the logs: apart from the page, which stops this worker if it takes too
 * long (`LineSearch`). Given a search and lines, it says of each whether it matches, and where.
 */
import {
  matcherOf,
  matchLine,
  type Matched,
  type Runnable,
  type ToMatch,
} from '@renderer/lib/log-search'

export interface MatchRequest {
  id: number
  search: Runnable
  lines: ToMatch[]
}

export interface MatchAnswer {
  id: number
  matched: Matched[]
}

// (Only what the page that made it sends, through the worker's own port: a message with no origin.
// Any other is dropped.)
self.onmessage = ({ data, origin }: MessageEvent<MatchRequest>) => {
  if (origin !== '') return
  const matcher = matcherOf(data.search)
  const answer: MatchAnswer = {
    id: data.id,
    matched: data.lines.map((line) => matchLine(line, matcher)),
  }
  self.postMessage(answer)
}
