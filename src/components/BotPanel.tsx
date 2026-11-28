import { useMemo } from 'react'
import type { EvaluationTerms } from '../bot/evaluation'
import { BOT_MATE_SCORE, type BotAnalysis, type BotThinking } from '../bot/protocol'
import type { BotDisplay } from '../bot/useBot'
import type { GameState } from '../engine/model'
import { sameAction, simulateAction } from '../engine/rules'

const numberFormat = new Intl.NumberFormat('en')
const sideNames = { white: 'White', black: 'Black' }

const breakdownLabels: readonly [keyof EvaluationTerms, string][] = [
  ['material', 'Material'],
  ['placement', 'Position & Strategy'],
  ['dragonFire', 'Dragon Fire'],
  ['shield', 'Shielder Guard'],
  ['resurrection', 'Necro Reserve'],
  ['kingSafety', 'King Safety'],
]

function searchMoves(position: GameState, analysis: BotAnalysis) {
  let next = position
  const line = analysis.principalVariation.map(action => {
    const { position: after, turn } = simulateAction(next, action)
    next = after
    return turn.description
  })

  const { decision } = analysis
  const best = decision.kind === 'claim-draw'
    ? decision.reason === 'threefold' ? 'Claim threefold repetition' : 'Claim the 50-move draw'
    : line.length && sameAction(analysis.principalVariation[0], decision.action) ? line[0]
    : simulateAction(position, decision.action).turn.description

  return { best, line }
}

function formatScore(score: number) {
  const sign = score < 0 ? '−' : '+'
  if (Math.abs(score) >= BOT_MATE_SCORE - 512) {
    const plies = Math.max(0, BOT_MATE_SCORE - Math.abs(score))
    return plies > 0 ? `${sign}Mate in ${plies} ${plies === 1 ? 'ply' : 'plies'}` : `${sign}Mate`
  }
  return score === 0 ? '0.00' : sign + (Math.abs(score) / 100).toFixed(2)
}

function whiteWinPercent(score: number, currentPlayer: 'white' | 'black'): number {
  const whiteScore = currentPlayer === 'white' ? score : -score
  if (Math.abs(whiteScore) >= BOT_MATE_SCORE - 512) {
    return whiteScore > 0 ? 98 : 2
  }
  const pct = 100 / (1 + Math.exp(-whiteScore / 360))
  return Math.max(3, Math.min(97, Math.round(pct)))
}

interface BotPanelProps {
  display: BotDisplay | null
  ponder?: { position: GameState; thinking: BotThinking | null; analysis: BotAnalysis | null } | null
  hint?: {
    position: GameState
    status: 'thinking' | 'complete' | 'failed'
    thinking: BotThinking | null
    analysis: BotAnalysis | null
    error?: string
  } | null
  onRetry: () => void
}

export function BotPanel({ display, ponder, hint, onRetry }: BotPanelProps) {
  const activeHint = hint && hint.status !== 'failed' ? hint : null
  const shownPosition = activeHint ? activeHint.position : display?.position
  const analysis = activeHint
    ? activeHint.analysis
    : display && 'analysis' in display
      ? display.analysis
      : null
  const searched = useMemo(
    () => (analysis && shownPosition ? searchMoves(shownPosition, analysis) : null),
    [analysis, shownPosition],
  )

  if (hint?.status === 'failed') {
    return <div className="bot-panel"><p role="alert">{hint.error}</p></div>
  }

  if (!activeHint && display?.kind === 'failed') {
    return <div className="bot-panel">
      <p role="alert">{display.message}</p>
      <button type="button" className="control-button bot-retry" onClick={onRetry}>Retry AI turn</button>
    </div>
  }

  if (!activeHint && display?.kind === 'paused') {
    return <div className="bot-panel"><p role="status">AI paused</p></div>
  }

  if (!shownPosition || (!activeHint && !display)) return null

  const depth = analysis?.depth ?? 0
  const selDepth = analysis?.selDepth ?? 0
  const thinking = activeHint
    ? activeHint.thinking
    : display?.kind === 'thinking'
      ? display.thinking
      : null
  const nodes = Math.max(analysis?.nodes ?? 0, thinking?.nodes ?? 0)
  const elapsed = Math.max(analysis?.elapsedMs ?? 0, thinking?.elapsedMs ?? 0)
  const nps = analysis?.nps ?? thinking?.nps ?? (elapsed > 0 ? Math.round((nodes * 1000) / elapsed) : 0)
  const isThinking = activeHint ? activeHint.status === 'thinking' : display?.kind === 'thinking'
  const whitePct = analysis && depth > 0 ? whiteWinPercent(analysis.score, shownPosition.currentPlayer) : 50

  const statusLabel = activeHint
    ? (isThinking ? 'Analyzing hint…' : 'AI Hint')
    : isThinking
      ? 'AI thinking…'
      : analysis?.bookMove
        ? 'Opening book move'
        : 'Last AI search'

  return <div className="bot-panel">
    <div className="bot-status-row">
      <p className="bot-status" role="status">{statusLabel}</p>
      {analysis?.bookMove && <span className="bot-badge">Book</span>}
    </div>

    {ponder && !isThinking && !activeHint && (
      <p className="bot-ponder" role="status">
        Pondering reply… {ponder.analysis?.depth ? `d${ponder.analysis.depth}` : ''} {ponder.thinking ? `(${numberFormat.format(ponder.thinking.nodes)} nodes)` : ''}
      </p>
    )}

    <div className="eval-bar" aria-label={`Position balance: White ${whitePct}%`}>
      <div className="eval-bar-white" style={{ width: `${whitePct}%` }} />
    </div>

    <dl className="bot-metrics">
      <dt>Depth / SelDepth</dt>
      <dd>
        {isThinking ? `${thinking?.currentDepth ?? 0} → ` : ''}
        {depth}{selDepth > depth ? ` / ${selDepth}` : ''} {depth === 1 && selDepth <= 1 ? 'ply' : 'plies'}
      </dd>
      <dt>Nodes (Speed)</dt>
      <dd>{numberFormat.format(nodes)}{nps > 0 ? ` (${numberFormat.format(nps)}/s)` : ''}</dd>
      {analysis?.ttHitRate !== undefined && analysis.ttHitRate > 0 && <>
        <dt>TT hit rate</dt><dd>{analysis.ttHitRate.toFixed(1)}%</dd>
      </>}
      <dt>Thinking time</dt><dd>{(elapsed / 1000).toFixed(2)} s</dd>
      <dt>Evaluation ({sideNames[shownPosition.currentPlayer]})</dt>
      <dd>{analysis && depth > 0 ? (analysis.bookMove ? 'Book (0.00)' : formatScore(analysis.score)) : '—'}</dd>
    </dl>

    <p className="bot-best">
      <strong>{analysis && depth === 0 ? 'Fallback move' : activeHint ? 'Suggested move' : 'Best move'}</strong>
      {searched?.best ?? 'Preparing search'}
    </p>

    <div className="bot-prediction">
      <strong>Predicted principal variation</strong>
      {depth > 0 && searched?.line.length ? <ol aria-label="Predicted principal variation">
        {searched.line.map((description, index) => <li key={index}>{description}</li>)}
      </ol> : <p>Unavailable</p>}
    </div>

    {analysis?.evalBreakdown && <details className="bot-breakdown">
      <summary>Evaluation breakdown</summary>
      <table className="match-stats-table" aria-label="Evaluation breakdown">
        <thead><tr><th scope="col">Factor</th><th scope="col">White</th><th scope="col">Black</th></tr></thead>
        <tbody>
          {breakdownLabels.map(([key, label]) => <tr key={key}>
            <th scope="row">{label}</th>
            <td>{analysis.evalBreakdown!.white[key]}</td>
            <td>{analysis.evalBreakdown!.black[key]}</td>
          </tr>)}
        </tbody>
      </table>
    </details>}
  </div>
}
