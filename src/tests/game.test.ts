import { describe, expect, it } from 'vitest'
import {
  agreeDraw, applyAction, claimDraw, createGame, createSession, evaluateStatus,
  legalActions, startPosition, undo, updateSession,
} from '../engine/game'
import { parseSquare, type Action, type GameState } from '../engine/model'
import { positionKey } from '../engine/rules'
import { position } from './fixture'

const at = (name: string) => parseSquare(name)!
const move = (pieceId: string, to: string): Action => ({ kind: 'move', pieceId, destination: at(to) })

function play(state: GameState, action: Action): GameState {
  const next = applyAction(state, action)
  expect(next).not.toBeNull()
  return next!
}

function cyclePosition() {
  return startPosition(position([
    ['white', 'king', 'A1'],
    ['white', 'knight', 'C2'],
    ['black', 'king', 'L12'],
    ['black', 'knight', 'J11'],
  ]))
}

function cycle(state: GameState) {
  for (const action of [move('white-C2', 'D4'), move('black-J11', 'I9'), move('white-C2', 'C2'), move('black-J11', 'J11')]) {
    state = play(state, action)
  }
  return state
}

describe('game completion', () => {
  const corner = (queen: string) => position([
    ['white', 'king', 'C3'], ['white', 'queen', queen], ['black', 'king', 'A1'],
  ], 'black')

  it('detects checkmate and stalemate and gives both priority over automatic draws', () => {
    const mate = corner('B2')
    const stalemate = corner('B3')
    for (const [state, result] of [
      [mate, { kind: 'checkmate', winner: 'white' }],
      [stalemate, { kind: 'draw', reason: 'stalemate' }],
    ] as const) {
      state.halfMoveClock = 150
      state.repetitionHistory = Array<string>(5).fill(positionKey(state))
      expect(evaluateStatus(state)).toEqual(result)
    }
  })

  it('sets checkmate after the mating move and stops accepting turns', () => {
    const state = startPosition({
      ...corner('B3'),
      currentPlayer: 'white',
    })
    const next = play(state, move('white-B3', 'B2'))
    expect(next.status).toEqual({ kind: 'checkmate', winner: 'white' })
    expect(legalActions(next)).toEqual([])
    expect(applyAction(next, move('black-A1', 'A2'))).toBeNull()
  })

  it('draws automatically for bare kings but not for conventional insufficient material', () => {
    const bare = startPosition(position([['white', 'king', 'A1'], ['black', 'king', 'L12']]))
    expect(bare.status).toEqual({ kind: 'draw', reason: 'bare-kings' })
    const knight = startPosition(position([
      ['white', 'king', 'A1'], ['white', 'knight', 'C2'], ['black', 'king', 'L12'],
    ]))
    expect(knight.status.kind).toBe('active')
  })

  it('allows the third occurrence to be claimed and ends the game on the fifth occurrence', () => {
    let state = cycle(cycle(cyclePosition()))
    expect(claimDraw(state, 'threefold')?.status).toEqual({ kind: 'draw', reason: 'threefold' })
    expect(claimDraw(state, 'fifty-move')).toBeNull()
    state = cycle(cycle(state))
    expect(state.status).toEqual({ kind: 'draw', reason: 'fivefold' })
  })

  it('counts 100 and 150 individual turns for the move-rule draws', () => {
    const state = cyclePosition()
    const action = move('white-C2', 'D4')
    const claim = play({ ...state, halfMoveClock: 99 }, action)
    expect(claim.halfMoveClock).toBe(100)
    expect(claimDraw(claim, 'fifty-move')?.status).toEqual({ kind: 'draw', reason: 'fifty-move' })
    const automatic = play({ ...state, halfMoveClock: 149 }, action)
    expect(automatic.status).toEqual({ kind: 'draw', reason: 'seventy-five-move' })
  })

  it('tracks legal en passant and relevant identity data in repetition', () => {
    const absent = startPosition(position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'],
      ['black', 'pawn', 'E8', 'E10', { hasMoved: true }], ['white', 'pawn', 'D8', 'D3', { hasMoved: true }],
      ['white', 'pawn', null, 'A3'],
    ]))
    const ep = { ...absent, enPassant: { pawnId: 'black-E10', target: at('E9') } }
    expect(positionKey(ep)).not.toBe(positionKey(absent))
    expect(positionKey({ ...ep, halfMoveClock: 137, fullMoveNumber: 78 })).toBe(positionKey(ep))
    const capturedPawn = ep.pieces['white-A3']
    expect(positionKey({
      ...ep, pieces: { ...ep.pieces, [capturedPawn.id]: { ...capturedPawn, hasMoved: true } },
    })).not.toBe(positionKey(ep))
    expect(positionKey({ ...ep, currentPlayer: 'black' })).not.toBe(positionKey(ep))
    expect(positionKey({ ...ep, graveyard: { ...ep.graveyard, white: [] } })).not.toBe(positionKey(ep))
    expect(positionKey({
      ...ep, castlingRights: { ...ep.castlingRights, white: { kingSide: true, queenSide: false } },
    })).not.toBe(positionKey(ep))

    const pinned = position([
      ['white', 'king', 'D1'], ['black', 'king', 'L12'], ['black', 'rook', 'D12'],
      ['black', 'pawn', 'E8', 'E10', { hasMoved: true }], ['white', 'pawn', 'D8', 'D3', { hasMoved: true }],
    ])
    expect(positionKey({ ...pinned, enPassant: ep.enPassant })).toBe(positionKey(pinned))
  })

  it('includes consumed quotas, fire ownership and relative fire duration in repetition', () => {
    const start = cyclePosition()
    const used = { ...start, resurrectionState: {
      ...start.resurrectionState, white: { ...start.resurrectionState.white, pawn: 1 },
    } }
    expect(positionKey(used)).not.toBe(positionKey(start))

    const fire = { id: 'one', owner: 'black' as const, square: at('E5'), createdAtTurn: 6, expiresAfterTurn: 7 }
    const burning = { ...start, fireState: { currentTurnIndex: 7, effects: [fire] } }
    expect(positionKey(burning)).not.toBe(positionKey(start))
    expect(positionKey({ ...burning, fireState: { currentTurnIndex: 6, effects: [fire] } })).not.toBe(positionKey(burning))
    expect(positionKey({ ...burning, fireState: { currentTurnIndex: 7, effects: [{ ...fire, owner: 'white' }] } })).not.toBe(positionKey(burning))
    expect(positionKey({ ...burning, fireState: { currentTurnIndex: 20, effects: [
      { ...fire, id: 'different', createdAtTurn: 19, expiresAfterTurn: 20 },
    ] } })).toBe(positionKey(burning))
  })


  it('records mutual agreement and can start an entirely fresh match afterwards', () => {
    const original = createGame()
    const state = play(original, move('white-A3', 'A5'))
    const over = agreeDraw(state)!
    expect(over.status).toEqual({ kind: 'draw', reason: 'agreement' })
    expect(agreeDraw(over)).toBeNull()
    expect(legalActions(over)).toEqual([])
    expect(createSession()).toEqual({ game: original, past: [] })
  })
})

describe('complete-turn undo', () => {
  it('undoes ignition and expiration separately as complete turns, restoring victims and rook rights', () => {
    const raw = position([
      ['white', 'king', 'A2'], ['black', 'king', 'G12'], ['white', 'dragon', 'K10', 'I1'],
      ['black', 'rook', 'L12'], ['black', 'knight', 'J12'],
      ['black', 'pawn', 'K11', 'K10', { hasMoved: true }], ['black', 'pawn', 'D8', 'D10', { hasMoved: true }],
    ])
    raw.castlingRights.black.kingSide = true
    raw.enPassant = { target: at('D9'), pawnId: 'black-D10' }
    raw.halfMoveClock = 21
    raw.fullMoveNumber = 9
    const start = startPosition(raw)
    const session = createSession(start)
    const action: Action = { kind: 'dragon', pieceId: 'white-I1', destination: at('I9'), fireTiming: 'before' }
    const ignited = updateSession(session, play(start, action))
    expect(ignited.game.moveHistory[0].capturedIds).toEqual([])
    expect(ignited.game.halfMoveClock).toBe(22)
    expect(ignited.game.fireState.effects).toHaveLength(4)
    expect(ignited.game.castlingRights.black.kingSide).toBe(true)
    expect(ignited.game.enPassant).toBeNull()
    const expired = updateSession(ignited, play(ignited.game, move('black-G12', 'G11')))
    expect(expired.game.moveHistory[1].fire.captures.map(({pieceId}) => pieceId)).toEqual(['black-K10', 'black-J12', 'black-L12'])
    expect(expired.game.graveyard.black).toHaveLength(3)
    expect(expired.game.fireState.effects).toEqual([])
    expect(expired.game.castlingRights.black.kingSide).toBe(false)
    expect(expired.game.halfMoveClock).toBe(0)
    expect(expired.game.repetitionHistory).toHaveLength(3)
    expect(undo(expired)).toEqual(ignited)
    expect(undo(ignited)).toEqual(session)
  })


  it('restores a promoted pawn in the graveyard after undoing resurrection', () => {
    const raw = position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'], ['white', 'necromancer', 'C1'],
      ['white', 'pawn', null, 'E3', { type: 'queen', promoted: true, hasMoved: true }],
    ])
    raw.halfMoveClock = 83
    const start = startPosition(raw)
    const session = createSession(start)
    const next = updateSession(session, play(start, {
      kind: 'resurrect', necromancerId: 'white-C1', revivedPieceId: 'white-E3',
    }))
    expect(next.game.pieces['white-E3']).toMatchObject({ type: 'pawn', promoted: false, hasMoved: true })
    expect(next.game.halfMoveClock).toBe(0)
    expect(next.game.resurrectionState.white.pawn).toBe(1)
    expect(undo(next)).toEqual(session)
    expect(undo(session)).toBe(session)
  })

  it('counts empty fire as quiet and reverses the agreement separately', () => {
    const game = startPosition(position([
      ['white', 'king', 'A1'], ['black', 'king', 'L12'], ['black', 'dragon', 'D12'],
    ], 'black'))
    const action: Action = { kind: 'dragon', pieceId: 'black-D12', destination: at('C10'), fireTiming: 'after' }
    const moved = updateSession(createSession(game), play(game, action))
    expect(moved.game.halfMoveClock).toBe(1)
    expect(moved.game.fullMoveNumber).toBe(2)
    const agreed = updateSession(moved, agreeDraw(moved.game))
    expect(undo(agreed)).toEqual(moved)
  })
})
