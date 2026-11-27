import { searchBot } from './search'
import type { BotRequest, BotResponse } from './protocol'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<BotRequest>) => void) | null
  postMessage: (message: BotResponse) => void
}

scope.onmessage = ({ data }) => {
  try {
    const analysis = searchBot(data.position, {
      timeMs: data.timeMs,
      onProgress: progress => scope.postMessage({ kind: 'progress', analysis: progress }),
    })
    if (analysis) scope.postMessage({ kind: 'done', analysis })
    else scope.postMessage({ kind: 'error', message: 'No legal bot move was found.' })
  } catch (error) {
    console.error('Bot search failed', error)
    scope.postMessage({ kind: 'error', message: 'The bot could not finish its turn.' })
  }
}
