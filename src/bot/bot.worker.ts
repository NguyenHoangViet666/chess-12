import { SearchHeuristics } from './moveOrder'
import { BOT_PROFILES } from './profiles'
import { normalizeBotTime, type BotDifficulty, type BotRequest, type BotResponse } from './protocol'
import { searchBot } from './search'
import { CorrectionHistory, PawnTable, TranspositionTable } from './tt'

export interface WorkerSearchMessage extends BotRequest {
  searchId?: number
  helperId?: number
}

export type WorkerOutgoing = BotResponse & { searchId?: number }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerSearchMessage>) => void) | null
  postMessage: (message: WorkerOutgoing) => void
}

let tt = new TranspositionTable(20)
const pawnTable = new PawnTable(14)
const corrHist = new CorrectionHistory()
const heuristics = new SearchHeuristics()

function resetEngineMemory() {
  tt.clear()
  pawnTable.clear()
  corrHist.clear()
  heuristics.clear()
}

scope.onmessage = ({ data }) => {
  if (data.kind === 'reset') {
    resetEngineMemory()
    return
  }

  const searchId = data.searchId ?? 0
  const helperId = data.helperId ?? 0

  try {
    if (data.sharedTTBuffer && tt.buffer !== data.sharedTTBuffer) {
      tt = new TranspositionTable(20, data.sharedTTBuffer)
    }

    const difficulty: BotDifficulty = data.difficulty ?? 'max'
    const profile = BOT_PROFILES[difficulty]
    const abortView = data.abortBuffer ? new Int32Array(data.abortBuffer) : undefined
    const timeMs = data.pondering ? 30_000 : normalizeBotTime(data.timeMs)

    const analysis = searchBot(data.position, {
      timeMs,
      difficulty,
      smartTime: data.smartTime ?? profile.smartTime,
      useBook: data.useBook ?? profile.useBook,
      pondering: data.pondering,
      tt,
      pawnTable,
      corrHist,
      heuristics,
      abortView,
      helperId,
      onThinking: helperId === 0
        ? thinking => scope.postMessage({ kind: 'thinking', thinking, searchId })
        : undefined,
      onProgress: helperId === 0
        ? progress => scope.postMessage({ kind: 'progress', analysis: progress, searchId })
        : undefined,
    })

    if (helperId > 0) return

    if (analysis) scope.postMessage({ kind: 'done', analysis, searchId })
    else scope.postMessage({ kind: 'error', message: 'No legal bot move was found.', searchId })
  } catch (error) {
    if (helperId > 0) return
    console.error('Bot search failed', error)
    scope.postMessage({ kind: 'error', message: 'The bot could not finish its turn.', searchId })
  }
}
