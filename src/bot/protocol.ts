import type { Action, ClaimableDrawReason, Color, GameState } from '../engine/model'
import type { EvaluationTerms } from './evaluation'

export const BOT_MIN_MS = 250
export const BOT_TURN_MS = 1500
export const BOT_MAX_MS = 30_000
export const BOT_MATE_SCORE = 100_000

export type BotDifficulty = 'easy' | 'medium' | 'hard' | 'max'
export type SearchProfileId = BotDifficulty | 'classic'

export function normalizeBotTime(timeMs: number): number {
  return Number.isFinite(timeMs) ? Math.max(BOT_MIN_MS, Math.min(BOT_MAX_MS, Math.round(timeMs))) : BOT_TURN_MS
}

export type BotDecision =
  | { kind: 'play'; action: Action }
  | { kind: 'claim-draw'; reason: ClaimableDrawReason }

export interface BotThinking {
  currentDepth: number
  selDepth?: number
  nodes: number
  elapsedMs: number
  nps?: number
  pondering?: boolean
}

export interface BotAnalysis {
  decision: BotDecision
  /** Number of fully searched plies, excluding tactical extensions. */
  depth: number
  selDepth?: number
  principalVariation: Action[]
  /** Score from the root player's perspective, in hundredths of a pawn. */
  score: number
  nodes: number
  elapsedMs: number
  nps?: number
  ttHitRate?: number
  bookMove?: boolean
  pondering?: boolean
  evalBreakdown?: Record<Color, EvaluationTerms>
}

export interface BotRequest {
  kind?: 'search' | 'reset'
  position: GameState
  timeMs: number
  difficulty?: BotDifficulty
  smartTime?: boolean
  useBook?: boolean
  pondering?: boolean
  abortBuffer?: SharedArrayBuffer
  sharedTTBuffer?: SharedArrayBuffer
}

export type BotResponse =
  | { kind: 'thinking'; thinking: BotThinking }
  | { kind: 'progress'; analysis: BotAnalysis }
  | { kind: 'done'; analysis: BotAnalysis }
  | { kind: 'error'; message: string }
