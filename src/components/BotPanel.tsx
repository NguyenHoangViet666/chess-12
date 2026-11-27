import type { BotAnalysis } from '../bot/protocol'
import type { BotDisplay } from '../bot/useBot'
import type { GameState } from '../engine/model'
import { sameAction, simulateAction } from '../engine/rules'

function predictedReply(position: GameState, analysis: BotAnalysis): string | null {
  const [choice, reply] = analysis.principalVariation
  if (!choice || !reply || analysis.decision.kind !== 'play' || !sameAction(choice, analysis.decision.action)) {
    return null
  }
  const afterChoice = simulateAction(position, choice).position
  return simulateAction(afterChoice, reply).turn.description
}

export function BotPanel({ display, onRetry }: { display: BotDisplay; onRetry: () => void }) {
  if (display.kind === 'failed') {
    return <div className="bot-panel">
      <p role="alert">{display.message}</p>
      <button type="button" className="control-button bot-retry" onClick={onRetry}>Retry bot turn</button>
    </div>
  }

  if (display.kind === 'paused') {
    return <div className="bot-panel"><p role="status">Bot paused</p></div>
  }

  const depth = display.analysis?.depth ?? 0
  const reply = display.analysis && predictedReply(display.position, display.analysis)
  return <div className="bot-panel" role="status" aria-atomic="true">
    <p className="bot-status">{display.kind === 'thinking' ? 'Bot thinking…' : 'Last bot search'}</p>
    <p>Completed depth <strong>{depth} {depth === 1 ? 'ply' : 'plies'}</strong></p>
    <p className="bot-prediction">Predicted reply <strong>{reply ?? 'Unavailable'}</strong></p>
  </div>
}