import { describe, expect, it } from 'vitest'
import { evaluatePositionBreakdown } from '../bot/evaluation'
import { lookupOpeningBook } from '../bot/openingBook'
import { BOT_PROFILES, UI_DIFFICULTIES } from '../bot/profiles'
import { searchBot } from '../bot/search'
import { TranspositionTable } from '../bot/tt'
import { applyAction, createGame, legalActions, startPosition } from '../engine/game'
import type { Action } from '../engine/model'
import { position, sq } from './fixture'

const fixedTime = () => 0

describe('upgraded bot tactical strength & variant intelligence', () => {
  it('resolves deep multi-piece capture sequences (>3 plies) accurately via QSearch + SEE', () => {
    // White Rook on D4 can capture defended Pawn on D8 (defended by Black Rook D12 and Queen H8? Wait: simple x-ray battery)
    // White has Rook D4 + Queen D2 vs Black Knight D8 defended by Rook D10 + Queen D12.
    // D4xD8 (320), D10xD8 (550), D2xD8 (550), D12xD8 (1060): White loses Rook+Queen (1615) for Knight+Rook (870) -> MUST NOT capture!
    const state = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'rook', 'D4'], ['white', 'queen', 'D2'],
      ['black', 'king', 'L12'], ['black', 'knight', 'D8'], ['black', 'rook', 'D10'], ['black', 'queen', 'D12'],
    ]))
    const res = searchBot(state, { maxDepth: 2, now: fixedTime })!
    expect(res.decision.kind).toBe('play')
    if (res.decision.kind === 'play') {
      const badBait: Action = { kind: 'move', pieceId: 'white-D4', destination: sq('D8') }
      expect(res.decision.action).not.toEqual(badBait)
    }
  })

  it('values keeping the last Necromancer alive even when the graveyard is empty', () => {
    const withNecro = evaluatePositionBreakdown(position([
      ['white', 'king', 'G1'], ['white', 'queen', 'F1'], ['white', 'dragon', 'D1'], ['white', 'rook', 'A1'],
      ['white', 'necromancer', 'C1'],
      ['black', 'king', 'G12'], ['black', 'queen', 'F12'], ['black', 'dragon', 'D12'], ['black', 'rook', 'A12'],
    ]))
    expect(withNecro.white.placement).toBeGreaterThan(withNecro.black.placement)
  })

  it('credits enemy Spawn-Camping and penalizes blocking own dead Queen spawn square', () => {
    // Black Queen is dead (spawn F12).
    // Case A: F12 is empty (Black has open revival)
    const open = position([
      ['white', 'king', 'A1'], ['white', 'knight', 'E10'],
      ['black', 'king', 'L12'], ['black', 'necromancer', 'J12'], ['black', 'queen', null, 'F12'],
    ])
    // Case B: White Knight camps on F12!
    const camped = position([
      ['white', 'king', 'A1'], ['white', 'knight', 'F12', 'B1', { hasMoved: true }],
      ['black', 'king', 'L12'], ['black', 'necromancer', 'J12'], ['black', 'queen', null, 'F12'],
    ])
    const evalOpen = evaluatePositionBreakdown(open)
    const evalCamped = evaluatePositionBreakdown(camped)
    expect(evalCamped.white.placement).toBeGreaterThan(evalOpen.white.placement)
    expect(evalCamped.black.resurrection).toBe(0)
  })

  it('detects a pinned enemy piece trapped inside expiring Dragon fire', () => {
    // Black Rook on D6 is pinned to Black King on D12 by White Rook D2, and D6 has expiring White fire!
    const raw = position([
      ['white', 'king', 'A1'], ['white', 'rook', 'D2'],
      ['black', 'king', 'D12'], ['black', 'rook', 'D6'],
    ], 'black')
    raw.fireState = {
      currentTurnIndex: 4,
      effects: [{ id: 'f-d6', owner: 'white', square: sq('D6'), createdAtTurn: 3, expiresAfterTurn: 4 }],
    }
    const pinnedEval = evaluatePositionBreakdown(raw)

    // Compare against same Rook not pinned (Black King moved to E12)
    const unpinnedRaw = position([
      ['white', 'king', 'A1'], ['white', 'rook', 'D2'],
      ['black', 'king', 'E12'], ['black', 'rook', 'D6'],
    ], 'black')
    unpinnedRaw.fireState = raw.fireState
    const unpinnedEval = evaluatePositionBreakdown(unpinnedRaw)

    expect(pinnedEval.white.dragonFire).toBeGreaterThan(unpinnedEval.white.dragonFire)
  })

  it('reuses Transposition Table entries across different move orders', () => {
    const state = createGame()
    const tt = new TranspositionTable(16)
    // Play 1. G3-G5 G10-G8 2. F3-F5 -> store depth 2 search from root's child
    const g5 = applyAction(state, { kind: 'move', pieceId: 'white-G3', destination: sq('G5') })!
    const g8 = applyAction(g5, { kind: 'move', pieceId: 'black-G10', destination: sq('G8') })!
    const first = searchBot(g8, { maxDepth: 2, now: fixedTime, tt })!
    expect(first.depth).toBe(2)

    // Reach the exact same position via a different move order: 1. F3-F5 G10-G8 2. G3-G5?
    // Or search from `state` at depth 3 which caches `g8` and its children, then search `g8` at depth 2:
    const f5 = applyAction(state, { kind: 'move', pieceId: 'white-F3', destination: sq('F5') })!
    const f5g8 = applyAction(f5, { kind: 'move', pieceId: 'black-G10', destination: sq('G8') })!
    const transA = applyAction(f5g8, { kind: 'move', pieceId: 'white-G3', destination: sq('G5') })!
    const transB = applyAction(g8, { kind: 'move', pieceId: 'white-F3', destination: sq('F5') })!
    // transA and transB are identical positions reached via different move orders!
    searchBot(transA, { maxDepth: 2, now: fixedTime, tt })
    const warm = searchBot(transB, { maxDepth: 2, now: fixedTime, tt })!
    expect(warm.ttHitRate).toBeGreaterThan(0)
  })

  it('provides legal Opening Book moves and supports all 4 difficulty profiles', () => {
    const root = createGame()
    const bookMove = lookupOpeningBook(root, true)
    expect(bookMove).not.toBeNull()
    expect(legalActions(root)).toContainEqual(bookMove!)

    for (const diff of UI_DIFFICULTIES) {
      const res = searchBot(root, {
        difficulty: diff,
        maxDepth: Math.min(2, BOT_PROFILES[diff].maxDepth),
        timeMs: 500,
        useBook: false,
      })!
      expect(res.decision.kind).toBe('play')
      if (res.decision.kind === 'play') {
        expect(legalActions(root)).toContainEqual(res.decision.action)
      }
    }
  })
})
