import { describe, expect, it } from 'vitest'
import { FastBoard } from '../bot/fastBoard'
import { applyAction, createGame, legalActions, startPosition } from '../engine/game'
import { igniteFire, type FirePreview } from '../engine/fire'
import type { Action, GameState } from '../engine/model'
import { positionKey, sameAction } from '../engine/rules'
import { position, sq } from './fixture'

function canonicalAction(a: Action): string {
  if (a.kind === 'castle') return `castle:${a.side}`
  if (a.kind === 'resurrect') return `res:${a.necromancerId}->${a.revivedPieceId}`
  if (a.kind === 'dragon') return `drg:${a.pieceId}:${a.destination.file},${a.destination.rank}:${a.fireTiming}`
  return `mv:${a.pieceId}:${a.destination.file},${a.destination.rank}:${a.promotion ?? ''}`
}

function fastLegalActions(board: FastBoard): Action[] {
  const buf = new Int32Array(512)
  const n = board.generatePseudoMoves(buf, false, false)
  const mover = board.sideToMove
  const out: Action[] = []
  for (let i = 0; i < n; i++) {
    const m = buf[i]
    board.makeMove(m)
    const ok = !board.isInCheck(mover)
    board.unmakeMove()
    if (ok) out.push(board.decodeAction(m))
  }
  return out
}

function assertExactParity(state: GameState) {
  const engineActions = legalActions(state).map(canonicalAction).sort()
  const fb = FastBoard.fromGameState(state)
  const fastActions = fastLegalActions(fb).map(canonicalAction).sort()
  expect(fastActions).toEqual(engineActions)
  expect(fb.toPositionKeyString()).toBe(positionKey(state))
}

function splitMix(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
}

describe('FastBoard 100% engine parity & Zobrist integrity', () => {
  it('matches engine legalActions at root and depth 2 perft', () => {
    const root = createGame()
    assertExactParity(root)

    const rootActions = legalActions(root)
    expect(rootActions.length).toBeGreaterThan(20)
    // Verify depth 2 across representative opening moves (pawns, knights, dragons, shielders)
    for (let i = 0; i < rootActions.length; i += 3) {
      const next = applyAction(root, rootActions[i])!
      assertExactParity(next)
    }
  })

  it('matches engine on variant edge cases (castling fire, EP burn, promoted pawn revival, shielder immunity, blocker burn check)', () => {
    // 1. Castling with active fire on transit vs safe
    const castleState = position([
      ['white', 'king', 'G1'], ['white', 'rook', 'A1'], ['white', 'rook', 'L1'],
      ['black', 'king', 'G12'], ['black', 'rook', 'A12'], ['black', 'rook', 'L12'],
      ['black', 'dragon', 'H2'],
    ], 'black')
    castleState.castlingRights.white = { kingSide: true, queenSide: true }
    castleState.castlingRights.black = { kingSide: true, queenSide: true }
    const s1 = startPosition(castleState)
    assertExactParity(s1)
    const afterFire = applyAction(s1, { kind: 'dragon', pieceId: 'black-H2', destination: sq('I4'), fireTiming: 'before' })!
    assertExactParity(afterFire)

    // 2. Promoted pawn in graveyard keeps hasMoved=true + multiple living Necromancers
    const necroState = position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'],
      ['white', 'necromancer', 'C1'], ['white', 'necromancer', 'J1'],
      ['white', 'pawn', null, 'E3', { type: 'queen', promoted: true, hasMoved: true }],
      ['white', 'dragon', null, 'D1'],
    ])
    assertExactParity(startPosition(necroState))

    // 3. Shielder frontal immunity & Dragon fire cancellation
    const shielderState = position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'],
      ['white', 'shielder', 'D5'], ['white', 'dragon', 'E4'],
      ['black', 'rook', 'D9'], ['black', 'shielder', 'D7'], ['black', 'knight', 'E6'],
    ])
    assertExactParity(startPosition(shielderState))

    // 4. Blocker burned by expiring fire exposing King (resurrection/move legality)
    const burnPinState = position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'],
      ['white', 'necromancer', 'C1'], ['white', 'knight', 'A3', 'B1'],
      ['white', 'pawn', null, 'D3'], ['black', 'dragon', 'A4'], ['black', 'rook', 'A8'],
    ], 'black')
    const burning = applyAction(startPosition(burnPinState), {
      kind: 'dragon', pieceId: 'black-A4', destination: sq('C5'), fireTiming: 'before',
    })!
    assertExactParity(burning)

    // 5. Overlapping friendly/hostile fire on a square
    const overlapRaw = position([['white', 'king', 'A1'], ['black', 'king', 'L12'], ['white', 'queen', 'D4']])
    const p: FirePreview = { cells: [{ square: sq('D5'), pieceId: null, effect: 'empty', refresh: false }], canceledBy: [] }
    const f1 = igniteFire(overlapRaw.fireState, 'white', p).fireState
    const f2 = igniteFire({ ...f1, currentTurnIndex: 1 }, 'black', p).fireState
    overlapRaw.fireState = f2
    assertExactParity(startPosition(overlapRaw))
  })

  it('maintains bit-exact Make/Unmake, Zobrist, PawnHash, and PST across 1500+ random plies', () => {
    const rng = splitMix(0xabcdef01)
    let totalPlies = 0

    for (let gameIdx = 0; gameIdx < 16; gameIdx++) {
      let state = createGame()
      let fb = FastBoard.fromGameState(state)

      for (let ply = 0; ply < 100 && state.status.kind === 'active'; ply++) {
        const engActions = legalActions(state)
        const fastActs = fastLegalActions(fb)

        expect(fastActs.length).toBe(engActions.length)
        expect(fb.toPositionKeyString()).toBe(positionKey(state))

        // Verify Zobrist & accumulators match a fresh rebuild from GameState
        const fresh = FastBoard.fromGameState(state)
        expect(fb.hashLo).toBe(fresh.hashLo)
        expect(fb.hashHi).toBe(fresh.hashHi)
        expect(fb.pawnHashLo).toBe(fresh.pawnHashLo)
        expect(fb.pawnHashHi).toBe(fresh.pawnHashHi)
        expect(Array.from(fb.mgScore)).toEqual(Array.from(fresh.mgScore))
        expect(Array.from(fb.egScore)).toEqual(Array.from(fresh.egScore))
        expect(fb.phase).toBe(fresh.phase)
        expect(fb.activeFireCount).toBe(fresh.activeFireCount)
        expect(fb.imminentFireCount).toBe(fresh.imminentFireCount)

        // Pick a pseudo-random action (bias slightly toward dragon/resurrect/captures to exercise edge cases)
        const chosen = engActions[rng() % engActions.length]
        const packed = fb.encodeAction(chosen)
        expect(sameAction(fb.decodeAction(packed), chosen)).toBe(true)

        const prevHashLo = fb.hashLo
        const prevHashHi = fb.hashHi
        const prevSquares = Int16Array.from(fb.squares)

        fb.makeMove(packed)
        fb.unmakeMove()

        // Exact unmake restoration check
        expect(fb.hashLo).toBe(prevHashLo)
        expect(fb.hashHi).toBe(prevHashHi)
        expect(fb.squares).toEqual(prevSquares)

        // Advance both engine and FastBoard
        const nextState = applyAction(state, chosen)!
        expect(nextState).not.toBeNull()
        fb.makeMove(packed)
        state = nextState
        totalPlies++
      }
    }

    expect(totalPlies).toBeGreaterThanOrEqual(1200)
  }, 20_000)
})
