import type { Action, ClaimableDrawReason, GameState } from '../engine/model'

export const BOT_TURN_MS = 1500

export type BotDecision =
  | { kind: 'play'; action: Action }
  | { kind: 'claim-draw'; reason: ClaimableDrawReason }

export interface BotAnalysis {
  decision: BotDecision
  /** Number of fully searched plies, excluding tactical extensions. */
  depth: number
  principalVariation: Action[]
  /** Score from the root player's perspective, in hundredths of a pawn. */
  score: number
  nodes: number
  elapsedMs: number
}

export interface BotRequest {
  position: GameState
  timeMs: number
}

export type BotResponse =
  | { kind: 'progress' | 'done'; analysis: BotAnalysis }
  | { kind: 'error'; message: string }
