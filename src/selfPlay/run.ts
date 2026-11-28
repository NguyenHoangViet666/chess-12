import { applyAction, claimDraw, createGame, legalActions } from '../engine/game'
import { pieceAt, type Action, type GameState, type TurnRecord } from '../engine/model'
import { SearchHeuristics } from '../bot/moveOrder'
import { BOT_PROFILES } from '../bot/profiles'
import { searchBot } from '../bot/search'
import type { BotAnalysis, SearchProfileId } from '../bot/protocol'
import { CorrectionHistory, PawnTable, TranspositionTable } from '../bot/tt'
import { enPassantVictim } from '../engine/movement'
import { createMatchStats, recordAction, type MatchSummaryInput } from './stats'

export { summarizeMatches } from './stats'
export { RULESET_VERSION } from '../engine/model'

export interface MatchOptions {
  maxPlies: number
  openingPlies: number
  maxNodes: number
  maxDepth: number
  includeHistory: boolean
  whiteProfile?: SearchProfileId
  blackProfile?: SearchProfileId
  timeMs?: number
  useBook?: boolean
}

interface SearchTrace {
  ply: number
  color: GameState['currentPlayer']
  depth: number
  nodes: number
  score: number
  decision: BotAnalysis['decision']
}

export interface SelfPlayResult extends MatchSummaryInput {
  seed: number
  opening: Action[]
  searches: SearchTrace[]
  fallbackSearches: number
  depthCounts: Record<number, number>
  history?: TurnRecord[]
}

function mix32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return (value ^ (value >>> 15)) >>> 0
}

export function deriveMatchSeed(seed: number, index: number): number {
  return mix32((seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0)
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x9e3779b9) >>> 0
    return mix32(value) / 0x100000000
  }
}

function openingCandidates(game: GameState): Action[] {
  const quiet = legalActions(game).filter(action => {
    if (action.kind !== 'move' && action.kind !== 'dragon') return false
    if (action.kind === 'dragon' && action.fireTiming !== 'none') return false
    if (action.kind === 'move' && action.promotion) return false
    return !pieceAt(game, action.destination) &&
      !enPassantVictim(game, game.pieces[action.pieceId], action.destination)
  })
  const development = quiet.filter(action => action.kind === 'move' &&
    ['pawn', 'knight', 'bishop'].includes(game.pieces[action.pieceId].type))
  return development.length ? development : quiet
}

function outcomeOf(game: GameState): MatchSummaryInput['outcome'] {
  if (game.status.kind === 'checkmate') return { kind: 'win', winner: game.status.winner }
  if (game.status.kind === 'draw') return { kind: 'draw', reason: game.status.reason }
  return { kind: 'capped' }
}

export function runMatch(seed: number, options: MatchOptions): SelfPlayResult {
  const nextRandom = seededRandom(seed)
  const stats = createMatchStats()
  const opening: Action[] = []
  const searches: SearchTrace[] = []
  const depthCounts: Record<number, number> = {}
  let fallbackSearches = 0
  let game = createGame()

  while (opening.length < Math.min(options.openingPlies, options.maxPlies) && game.status.kind === 'active') {
    const candidates = openingCandidates(game)
    if (!candidates.length) break
    const action = candidates[Math.floor(nextRandom() * candidates.length)]
    const next = applyAction(game, action)
    if (!next) throw new Error(`Opening generated an illegal action at ply ${opening.length + 1}`)
    opening.push(action)
    game = next
  }

  const engineMemory = {
    white: {
      tt: new TranspositionTable(17),
      pawnTable: new PawnTable(13),
      corrHist: new CorrectionHistory(),
      heuristics: new SearchHeuristics(),
    },
    black: {
      tt: new TranspositionTable(17),
      pawnTable: new PawnTable(13),
      corrHist: new CorrectionHistory(),
      heuristics: new SearchHeuristics(),
    },
  }

  while (game.moveHistory.length < options.maxPlies && game.status.kind === 'active') {
    const ply = game.moveHistory.length + 1
    const side = game.currentPlayer
    const profile = side === 'white' ? options.whiteProfile : options.blackProfile
    const mem = engineMemory[side]
    const hasTimeLimit = options.timeMs !== undefined && Number.isFinite(options.timeMs)
    const analysis = searchBot(game, {
      timeMs: hasTimeLimit ? options.timeMs : Infinity,
      maxNodes: hasTimeLimit ? Infinity : options.maxNodes,
      maxDepth: profile ? Math.min(options.maxDepth, BOT_PROFILES[profile].maxDepth) : options.maxDepth,
      difficulty: profile,
      useBook: options.useBook ?? false,
      smartTime: false,
      tt: mem.tt,
      pawnTable: mem.pawnTable,
      corrHist: mem.corrHist,
      heuristics: mem.heuristics,
      seed: seed + ply,
    })
    if (!analysis) throw new Error(`Bot returned no decision at ply ${ply} for seed ${seed}`)
    const { decision, depth, nodes, score } = analysis
    searches.push({ ply, color: game.currentPlayer, decision, depth, nodes, score })
    depthCounts[depth] = (depthCounts[depth] ?? 0) + 1
    if (depth === 0) fallbackSearches++

    const next = decision.kind === 'play'
      ? applyAction(game, decision.action)
      : claimDraw(game, decision.reason)
    if (!next) throw new Error(`Bot returned an illegal decision at ply ${ply} for seed ${seed}: ${JSON.stringify(decision)}`)
    if (decision.kind === 'play') recordAction(stats, game, next)
    game = next
  }

  const result: SelfPlayResult = {
    seed,
    outcome: outcomeOf(game),
    plies: game.moveHistory.length,
    stats,
    opening,
    searches,
    depthCounts,
    fallbackSearches,
  }
  if (options.whiteProfile || options.blackProfile) {
    result.profiles = {
      white: options.whiteProfile ?? 'max',
      black: options.blackProfile ?? 'max',
    }
  }
  if (options.includeHistory) result.history = game.moveHistory
  return result
}
