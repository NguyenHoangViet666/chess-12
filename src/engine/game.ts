import {
  createPosition,
  opposite,
  type Action,
  type ClaimableDrawReason,
  type DrawReason,
  type GameState,
  type GameStatus,
} from './model'
import { describeTurn, isInCheck, positionKey, safeActions, safeTransitions, sameAction } from './rules'

export function evaluateStatus(state: GameState): GameStatus {
  const inCheck = isInCheck(state, state.currentPlayer)
  if (safeActions(state).next().done) {
    return inCheck
      ? { kind: 'checkmate', winner: opposite(state.currentPlayer) }
      : { kind: 'draw', reason: 'stalemate' }
  }
  const key = positionKey(state)
  const repetitions = state.repetitionHistory.filter(previous => previous === key).length
  const automatic = automaticDraw(state, repetitions)
  return automatic
    ? { kind: 'draw', reason: automatic }
    : { kind: 'active', inCheck, claimable: claimableDraws(state, repetitions) }
}

export function automaticDraw(state: GameState, repetitions: number): DrawReason | null {
  if (Object.values(state.pieces).every(piece => !piece.currentSquare || piece.type === 'king')) return 'bare-kings'
  if (repetitions >= 5) return 'fivefold'
  if (state.halfMoveClock >= 150) return 'seventy-five-move'
  return null
}

export function claimableDraws(state: GameState, repetitions: number): ClaimableDrawReason[] {
  const claimable: ClaimableDrawReason[] = []
  if (repetitions >= 3) claimable.push('threefold')
  if (state.halfMoveClock >= 100) claimable.push('fifty-move')
  return claimable
}

/** Begin tracking a fresh position, including the initial repetition occurrence. */
export function startPosition(position: GameState): GameState {
  const state = { ...position, repetitionHistory: [positionKey(position)] }
  return { ...state, status: evaluateStatus(state) }
}

export function createGame(): GameState {
  return startPosition(createPosition())
}

export function legalActions(state: GameState): Action[] {
  return state.status.kind === 'active' ? [...safeActions(state)] : []
}

export function applyAction(state: GameState, requested: Action): GameState | null {
  if (state.status.kind !== 'active') return null
  for (const result of safeTransitions(state, action => sameAction(action, requested))) {
    const { position } = result
    position.moveHistory = [...state.moveHistory, describeTurn(state, result)]
    position.repetitionHistory = [...state.repetitionHistory, positionKey(position)]
    position.status = evaluateStatus(position)
    return position
  }
  return null
}

export function claimDraw(state: GameState, reason: ClaimableDrawReason): GameState | null {
  if (state.status.kind !== 'active' || !state.status.claimable.includes(reason)) return null
  return { ...state, status: { kind: 'draw', reason } }
}

export function agreeDraw(state: GameState): GameState | null {
  return state.status.kind === 'active' ? { ...state, status: { kind: 'draw', reason: 'agreement' } } : null
}

export interface Session {
  game: GameState
  past: readonly GameState[]
}

export function createSession(game = createGame()): Session {
  return { game, past: [] }
}

export function updateSession(session: Session, next: GameState | null): Session {
  return next ? { game: next, past: [...session.past, session.game] } : session
}

export function undo(session: Session): Session {
  const last = session.past.at(-1)
  return last ? { game: last, past: session.past.slice(0, -1) } : session
}
