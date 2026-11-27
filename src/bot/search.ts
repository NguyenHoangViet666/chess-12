import { automaticDraw, claimableDraws } from '../engine/game'
import { pieceAt, type Action, type GameState } from '../engine/model'
import { enPassantVictim } from '../engine/movement'
import { isInCheck, positionKey, safeTransitions, sameAction, type ActionTransition } from '../engine/rules'
import { evaluatePosition, pieceValue } from './evaluation'
import { BOT_TURN_MS, type BotAnalysis } from './protocol'

const MATE_SCORE = 100_000
const QUIESCENCE_PLIES = 3
const EXTRA_CHECK_PLIES = 2
const MAX_TT_SIZE = 24_000
const timedOut = Symbol('search deadline')

export interface SearchOptions {
  timeMs?: number
  maxDepth?: number
  now?: () => number
  onProgress?: (analysis: BotAnalysis) => void
}

interface Line {
  score: number
  moves: Action[]
}

interface Entry {
  depth: number
  bound: 'exact' | 'lower' | 'upper'
  context: string
  line: Line
}

interface Move extends ActionTransition {
  checking: boolean
  priority: number
}

function tacticalCandidate(state: GameState, action: Action): boolean {
  if (action.kind === 'castle') return false
  if (action.kind === 'resurrect') return true
  if (action.kind === 'dragon' && action.fireTiming !== 'none') return true
  if (action.kind === 'move' && action.promotion) return true
  return Boolean(pieceAt(state, action.destination) ||
    enPassantVictim(state, state.pieces[action.pieceId], action.destination))
}

function tacticalResult(move: ActionTransition): boolean {
  return move.capturedIds.length > 0 || move.action.kind === 'resurrect' ||
    (move.action.kind === 'move' && move.action.promotion !== undefined)
}

function equivalentMove(move: ActionTransition): string | null {
  const { action, capturedIds } = move
  if (action.kind === 'resurrect') return `r:${action.revivedPieceId}`
  if (action.kind !== 'dragon') return null
  // A different fire timing that reaches the same square with the same victims has no lasting effect.
  const { file, rank } = action.destination
  return `d:${action.pieceId}:${file}:${rank}:${[...capturedIds].sort().join(',')}`
}

function movePriority(state: GameState, move: ActionTransition, checking: boolean): number {
  const { action, actor, to, capturedIds } = move
  let priority = checking ? 3200 : 0
  for (const id of capturedIds) priority += pieceValue(state.pieces[id].type) * 12
  if (capturedIds.length) priority -= pieceValue(actor.type)
  if (action.kind === 'dragon' && action.fireTiming !== 'none') priority += 150
  if (action.kind === 'move' && action.promotion) priority += pieceValue(action.promotion) * 8
  if (action.kind === 'resurrect') priority += pieceValue(state.pieces[action.revivedPieceId].baseType) * 4
  if (action.kind === 'castle') priority += 110
  return priority - Math.abs(to.file - 5.5) - Math.abs(to.rank - 5.5)
}

function line(score: number): Line {
  return { score, moves: [] }
}

export function searchBot(position: GameState, options: SearchOptions = {}): BotAnalysis | null {
  if (position.status.kind !== 'active') return null
  const now = options.now ?? (() => performance.now())
  const start = now()
  const timeMs = options.timeMs ?? BOT_TURN_MS
  const deadline = start + (Number.isFinite(timeMs) ? Math.max(0, timeMs) : BOT_TURN_MS)
  const maxDepth = options.maxDepth ?? 64
  const first = safeTransitions(position).next()
  if (first.done) return null

  let nodes = 0
  let best: BotAnalysis = {
    decision: { kind: 'play', action: first.value.action },
    depth: 0, principalVariation: [first.value.action], score: 0, nodes: 0, elapsedMs: 0,
  }
  const keys = new WeakMap<GameState, string>()
  const keyIds = new Map<string, number>()
  const repetitions = new Map<string, number>()
  const table = new Map<string, Entry>()
  for (const previous of position.repetitionHistory) {
    repetitions.set(previous, (repetitions.get(previous) ?? 0) + 1)
  }
  const rootKey = keyOf(position)
  const rootRepetitions = repetitions.get(rootKey) ?? 1
  repetitions.set(rootKey, rootRepetitions)
  if (automaticDraw(position, rootRepetitions)) return null
  const rootClaim = claimableDraws(position, rootRepetitions)[0]
  let rootMoves: Move[] | undefined

  function checkTime() {
    if (now() >= deadline) throw timedOut
  }

  function keyOf(state: GameState) {
    let key = keys.get(state)
    if (key === undefined) {
      key = positionKey(state)
      keys.set(state, key)
    }
    return key
  }

  function withMove(move: Move, visit: (state: GameState, key: string, count: number) => Line): Line {
    checkTime()
    const state = move.position
    const key = keyOf(state)
    const prior = repetitions.get(key) ?? 0
    repetitions.set(key, prior + 1)
    try {
      return visit(state, key, prior + 1)
    } finally {
      if (prior) repetitions.set(key, prior)
      else repetitions.delete(key)
    }
  }

  function childContext(parent: readonly number[], key: string): number[] {
    let id = keyIds.get(key)
    if (id === undefined) {
      id = keyIds.size
      keyIds.set(key, id)
    }
    // The fixed pre-search history is shared by all nodes. Record only the
    // search's additional occurrences, which matter by count, not by order.
    const result = [...parent, id]
    result.sort((a, b) => a - b)
    return result
  }

  function ordered(state: GameState, source: Iterable<ActionTransition>, tacticalOnly = false): Move[] {
    const moves: Move[] = []
    const seen = new Set<string>()
    for (const transition of source) {
      checkTime()
      if (tacticalOnly && !tacticalResult(transition)) continue
      const equivalent = equivalentMove(transition)
      if (equivalent !== null) {
        if (seen.has(equivalent)) continue
        seen.add(equivalent)
      }
      const checking = isInCheck(transition.position, transition.position.currentPlayer)
      moves.push({ ...transition, checking, priority: movePriority(state, transition, checking) })
    }
    return moves.sort((a, b) => b.priority - a.priority)
  }

  function tryPreferred(moves: Move[], action?: Action): Iterable<Move> {
    if (!action) return moves
    const index = moves.findIndex(move => sameAction(move.action, action))
    if (index <= 0) return moves
    return [moves[index], ...moves.slice(0, index), ...moves.slice(index + 1)]
  }

  function quiescence(
    state: GameState, repetitionsHere: number, inCheck: boolean, ply: number,
    remaining: number, alpha: number, beta: number,
  ): Line {
    checkTime()
    nodes++
    const all = safeTransitions(state)
    const firstMove = all.next()
    if (firstMove.done) return line(inCheck ? ply - MATE_SCORE : 0)
    if (automaticDraw(state, repetitionsHere)) return line(0)

    const claim = claimableDraws(state, repetitionsHere).length > 0
    const atCheckLimit = remaining <= -EXTRA_CHECK_PLIES
    let bestLine = line(inCheck && !atCheckLimit ? -Infinity : evaluatePosition(state))
    if (claim && bestLine.score < 0) bestLine = line(0)
    if ((!inCheck && remaining <= 0) || atCheckLimit || bestLine.score >= beta) return bestLine
    alpha = Math.max(alpha, bestLine.score)

    const source = inCheck
      ? (function* () { yield firstMove.value; yield* all })()
      : safeTransitions(state, action => tacticalCandidate(state, action))
    for (const move of ordered(state, source, !inCheck)) {
      const reply = withMove(move, (next, _key, count) =>
        quiescence(next, count, move.checking, ply + 1, remaining - 1, -beta, -alpha))
      const score = -reply.score
      if (score > bestLine.score) bestLine = { score, moves: [move.action, ...reply.moves] }
      alpha = Math.max(alpha, score)
      if (alpha >= beta) break
    }
    return bestLine
  }

  function negamax(
    state: GameState, key: string, count: number, path: readonly number[], inCheck: boolean,
    depth: number, ply: number, alpha: number, beta: number,
  ): Line {
    if (depth === 0) return quiescence(state, count, inCheck, ply, QUIESCENCE_PLIES, alpha, beta)
    checkTime()
    nodes++
    const tableKey = `${state.halfMoveClock}:${key}`
    const context = path.join(',')
    const cached = table.get(tableKey)
    // Use a cached move across transpositions. Score bounds also require the same
    // repetition path, since arriving at a board via a different line can change a draw.
    if (cached?.context === context && cached.depth >= depth) {
      if (cached.bound === 'exact' || (cached.bound === 'lower' && cached.line.score >= beta) ||
          (cached.bound === 'upper' && cached.line.score <= alpha)) return cached.line
    }
    const initialAlpha = alpha
    const moves = ply === 0
      ? (rootMoves ??= ordered(state, safeTransitions(state)))
      : ordered(state, safeTransitions(state))
    if (!moves.length) return line(inCheck ? ply - MATE_SCORE : 0)
    if (automaticDraw(state, count)) return line(0)

    let bestLine = line(claimableDraws(state, count).length ? 0 : -Infinity)
    if (bestLine.score >= beta) return bestLine
    alpha = Math.max(alpha, bestLine.score)
    for (const move of tryPreferred(moves, cached?.line.moves[0])) {
      const reply = withMove(move, (next, nextKey, nextCount) =>
        negamax(next, nextKey, nextCount, depth > 1 ? childContext(path, nextKey) : path, move.checking,
          depth - 1, ply + 1, -beta, -alpha))
      const score = -reply.score
      if (score > bestLine.score) bestLine = { score, moves: [move.action, ...reply.moves] }
      alpha = Math.max(alpha, score)
      if (alpha >= beta) break
    }

    if (table.size < MAX_TT_SIZE || cached) {
      if (!cached || cached.context !== context || depth >= cached.depth) {
        const bound = bestLine.score >= beta ? 'lower' : bestLine.score <= initialAlpha ? 'upper' : 'exact'
        table.set(tableKey, { depth, context, bound, line: bestLine })
      }
    }
    return bestLine
  }

  try {
    const inCheck = isInCheck(position, position.currentPlayer)
    for (let depth = 1; depth <= maxDepth; depth++) {
      checkTime()
      const result = negamax(position, rootKey, rootRepetitions, [], inCheck, depth, 0, -Infinity, Infinity)
      const action = result.moves[0]
      best = {
        decision: action ? { kind: 'play', action } : rootClaim
          ? { kind: 'claim-draw', reason: rootClaim } : best.decision,
        depth,
        principalVariation: result.moves,
        score: result.score,
        nodes,
        elapsedMs: Math.round(now() - start),
      }
      options.onProgress?.(best)
      if (result.score >= MATE_SCORE - 256) break
    }
  } catch (error) {
    if (error !== timedOut) throw error
  }
  return { ...best, nodes, elapsedMs: Math.round(now() - start) }
}
