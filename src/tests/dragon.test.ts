import { describe, expect, it } from 'vitest'
import { expireFire, fireCone, firePreview, igniteFire, isHostileFire, turnsRemaining, type FirePreview } from '../engine/fire'
import { applyAction, createSession, legalActions, startPosition, undo, updateSession } from '../engine/game'
import { pieceAt, squareName, type DragonAction, type DragonFireTiming, type FireEffect } from '../engine/model'
import { dragonPreview, isInCheck, isSquareAttacked } from '../engine/rules'
import { position, sq, type Entry } from './fixture'

const distantKings = [
  ['white', 'king', 'A1'],
  ['black', 'king', 'L12'],
] as const satisfies readonly Entry[]

const names = (effects: FireEffect[]) => effects.map(effect => squareName(effect.square)).sort()

function dragonTurn(destination: string, fireTiming: DragonFireTiming, pieceId = 'white-D4'): DragonAction {
  return { kind: 'dragon', pieceId, destination: sq(destination), fireTiming }
}

function oneSquarePreview(name: string): FirePreview {
  return { cells: [{ square: sq(name), pieceId: null, effect: 'empty', refresh: false }], canceledBy: [] }
}

describe('Dragon movement and fire geometry', () => {
  it('jumps over nearby pieces, moves without firing and takes a landing target normally', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['white', 'pawn', 'D5'],
      ['black', 'bishop', 'E6'],
      ['black', 'pawn', 'D6'],
    ]))
    const destinations = legalActions(state).flatMap(action =>
      action.kind === 'dragon' && action.fireTiming === 'none' ? [squareName(action.destination)] : [],
    )
    expect(destinations.sort()).toEqual(['B3', 'B5', 'C2', 'C6', 'E2', 'E6', 'F3', 'F5'])

    const next = applyAction(state, dragonTurn('E6', 'none'))!
    expect(pieceAt(next, sq('E6'))?.id).toBe('white-D4')
    expect(next.graveyard.black).toEqual(['black-E6'])
    expect(next.fireState.effects).toEqual([])
    expect(next.moveHistory.at(-1)?.fire.captures).toEqual([])
  })

  it('cannot use either fire timing without a legal Knight move', () => {
    const state = startPosition(position([
      ['white', 'king', 'L1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'A1'],
      ['white', 'pawn', 'B3'],
      ['white', 'pawn', 'C2'],
      ['black', 'pawn', 'A2'],
    ]))
    expect(legalActions(state).some(action => action.kind === 'dragon')).toBe(false)
    for (const timing of ['before', 'after'] as const) {
      expect(applyAction(state, dragonTurn('A1', timing, 'white-A1'))).toBeNull()
      expect(applyAction(state, dragonTurn('B3', timing, 'white-A1'))).toBeNull()
    }
    expect(pieceAt(state, sq('A2'))?.id).toBe('black-A2')
  })

  it('projects four cells forward for each side and clips at both board dimensions', () => {
    const cone = (name: string, color: 'white' | 'black') => fireCone(sq(name), color).map(squareName).sort()
    expect(cone('D4', 'white')).toEqual(['C6', 'D5', 'D6', 'E6'])
    expect(cone('D4', 'black')).toEqual(['C2', 'D2', 'D3', 'E2'])
    expect(cone('A4', 'white')).toEqual(['A5', 'A6', 'B6'])
    expect(cone('L4', 'black')).toEqual(['K2', 'L2', 'L3'])
    expect(cone('L11', 'white')).toEqual(['L12'])
    expect(cone('D1', 'black')).toEqual([])
  })
})

describe('Dragon activation and expiration', () => {
  it('creates the origin cone without removing occupants or making an allied landing possible', () => {
    const raw = position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['white', 'pawn', 'C6'],
      ['black', 'pawn', 'D5'],
      ['black', 'queen', 'D6'],
      ['black', 'rook', 'E6'],
    ])
    raw.halfMoveClock = 8
    const state = startPosition(raw)
    expect(applyAction(state, dragonTurn('C6', 'before'))).toBeNull()

    const action = dragonTurn('E6', 'before')
    const preview = dragonPreview(state, state.pieces['white-D4'], action)
    expect(Object.fromEntries(preview.cells.map(cell => [squareName(cell.square), cell.effect])))
      .toEqual({ D5: 'threatened', C6: 'ally', D6: 'threatened', E6: 'threatened' })
    const next = applyAction(state, action)!
    expect(names(next.fireState.effects)).toEqual(['C6', 'D5', 'D6', 'E6'])
    expect(next.fireState.currentTurnIndex).toBe(state.fireState.currentTurnIndex + 1)
    expect(next.fireState.effects.every(effect => turnsRemaining(effect, state.fireState.currentTurnIndex) === 2)).toBe(true)
    expect(next.fireState.effects.every(effect => turnsRemaining(effect, next.fireState.currentTurnIndex) === 1)).toBe(true)
    expect(next.graveyard.black).toEqual(['black-E6'])
    expect(pieceAt(next, sq('D5'))?.id).toBe('black-D5')
    expect(pieceAt(next, sq('D6'))?.id).toBe('black-D6')
    expect(pieceAt(next, sq('E6'))?.id).toBe('white-D4')
    expect(next.moveHistory).toHaveLength(1)
    expect(next.moveHistory[0]).toMatchObject({
      action, from: sq('D4'), to: sq('E6'), capturedIds: ['black-E6'],
      fire: { created: next.fireState.effects, expired: [], captures: [], canceledBy: [] },
    })
    expect(next.currentPlayer).toBe('black')
    expect(applyAction(next, dragonTurn('B5', 'after'))).toBeNull()
    expect(undo(updateSession(createSession(state), next)).game).toEqual(state)
  })

  it('uses the destination cone after movement and destroys only enemies that remain when it expires', () => {
    const raw = position([
      ['white', 'king', 'A1'],
      ['black', 'king', 'L12'],
      ['white', 'dragon', 'D4'],
      ['white', 'pawn', 'E7'],
      ['black', 'pawn', 'D5'],
      ['black', 'rook', 'F6'],
      ['black', 'knight', 'G7'],
    ])
    raw.halfMoveClock = 9
    const state = startPosition(raw)
    const action = dragonTurn('F5', 'after')
    const preview = dragonPreview(state, state.pieces['white-D4'], action)
    expect(Object.fromEntries(preview.cells.map(cell => [squareName(cell.square), cell.effect])))
      .toEqual({ F6: 'threatened', E7: 'ally', F7: 'empty', G7: 'threatened' })

    const active = applyAction(state, action)!
    expect(active.graveyard.black).toEqual([])
    expect(active.halfMoveClock).toBe(10)
    expect(names(active.fireState.effects)).toEqual(['E7', 'F6', 'F7', 'G7'])
    const expired = applyAction(active, { kind: 'move', pieceId: 'black-F6', destination: sq('F8') })!
    expect(expired.graveyard.black).toEqual(['black-G7'])
    expect(pieceAt(expired, sq('F8'))?.id).toBe('black-F6')
    expect(pieceAt(expired, sq('E7'))?.id).toBe('white-E7')
    expect(pieceAt(expired, sq('D5'))?.id).toBe('black-D5')
    expect(expired.fireState.effects).toEqual([])
    expect(expired.halfMoveClock).toBe(0)
    expect(expired.moveHistory.at(-1)?.fire).toMatchObject({
      created: [], expired: active.fireState.effects,
      captures: [{ pieceId: 'black-G7', owner: 'white', square: sq('G7') }],
    })

    const session = updateSession(updateSession(createSession(state), active), expired)
    expect(undo(session).game).toEqual(active)
    expect(undo(undo(session)).game).toEqual(state)
  })

  it('lets a piece pass through fire but destroys it if it lands on a square that expires', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'rook', 'D7'],
    ]))
    const active = applyAction(state, dragonTurn('F3', 'before'))!
    const passed = applyAction(active, { kind: 'move', pieceId: 'black-D7', destination: sq('D4') })!
    expect(pieceAt(passed, sq('D4'))?.id).toBe('black-D7')
    expect(passed.graveyard.black).toEqual([])

    const burned = applyAction(active, { kind: 'move', pieceId: 'black-D7', destination: sq('D6') })!
    expect(pieceAt(burned, sq('D6'))).toBeUndefined()
    expect(burned.graveyard.black).toEqual(['black-D7'])
    expect(burned.moveHistory.at(-1)?.fire.captures).toEqual([
      { pieceId: 'black-D7', owner: 'white', square: sq('D6') },
    ])
  })

  it('clears the en passant opportunity if the double-stepping Pawn burns at the end of its own turn', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'E6'],
      ['white', 'pawn', 'D8'],
      ['black', 'pawn', 'E10'],
    ]))
    const active = applyAction(state, dragonTurn('G5', 'before', 'white-E6'))!
    const expired = applyAction(active, { kind: 'move', pieceId: 'black-E10', destination: sq('E8') })!
    expect(expired.graveyard.black).toEqual(['black-E10'])
    expect(expired.enPassant).toBeNull()
    expect(applyAction(expired, { kind: 'move', pieceId: 'white-D8', destination: sq('E9') })).toBeNull()
  })

  it('keeps fire active if its Dragon is captured before expiration resolves', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'rook', 'F9'],
      ['black', 'pawn', 'D5'],
    ]))
    const active = applyAction(state, dragonTurn('F5', 'before'))!
    const expired = applyAction(active, { kind: 'move', pieceId: 'black-F9', destination: sq('F5') })!
    expect(expired.graveyard.white).toEqual(['white-D4'])
    expect(expired.graveyard.black).toEqual(['black-D5'])
    expect(expired.moveHistory.at(-1)?.fire.captures).toMatchObject([{ pieceId: 'black-D5', owner: 'white' }])
  })

  it('removes castling rights and resets the half-move clock when an original Rook burns', () => {
    const raw = position([
      ['white', 'king', 'A1'],
      ['white', 'dragon', 'L10'],
      ['black', 'king', 'G12'],
      ['black', 'rook', 'L12'],
      ['black', 'knight', 'J12'],
    ])
    raw.castlingRights.black.kingSide = true
    raw.halfMoveClock = 19
    const active = applyAction(startPosition(raw), dragonTurn('J9', 'before', 'white-L10'))!
    expect(active.castlingRights.black.kingSide).toBe(true)
    expect(active.halfMoveClock).toBe(20)
    const expired = applyAction(active, { kind: 'move', pieceId: 'black-J12', destination: sq('H11') })!
    expect(expired.castlingRights.black.kingSide).toBe(false)
    expect(expired.halfMoveClock).toBe(0)
    expect(expired.graveyard.black).toEqual(['black-L12'])
  })
})

describe('Overlapping fire effects', () => {
  it('refreshes same-owner fire and retains separate opposing fire on the same square', () => {
    const baseState = position([...distantKings, ['white', 'dragon', 'D4']])
    const initial = igniteFire(baseState.fireState, 'white', oneSquarePreview('D5'))
    const original = initial.created[0]
    const nextTurn = { ...initial.fireState, currentTurnIndex: 1 }
    const opposed = igniteFire(nextTurn, 'black', oneSquarePreview('D5'))
    const state = { ...baseState, fireState: opposed.fireState }
    expect(firePreview(state, state.pieces['white-D4']).cells.find(cell => squareName(cell.square) === 'D5')?.refresh)
      .toBe(true)
    const refreshed = igniteFire(opposed.fireState, 'white', oneSquarePreview('D5'))
    expect(refreshed.fireState.effects).toHaveLength(2)
    expect(refreshed.created[0]).toEqual({ ...original, expiresAfterTurn: 2 })
    expect(refreshed.fireState.effects).toContainEqual(opposed.created[0])
    expect(turnsRemaining(refreshed.created[0], 1)).toBe(2)
    expect(turnsRemaining(original, 1)).toBe(1)
    expect(turnsRemaining(original, 2)).toBe(0)
    expect(turnsRemaining(opposed.created[0], 0)).toBe(0)
  })

  it('continues the later effect independently and captures an exposed piece only once', () => {
    const state = position([...distantKings, ['black', 'pawn', 'D5']])
    const white = igniteFire(state.fireState, 'white', oneSquarePreview('D5'))
    const black = igniteFire({ ...white.fireState, currentTurnIndex: 1 }, 'black', oneSquarePreview('D5'))
    const duplicateDue = { ...white.created[0], id: 'duplicate-test-effect' }
    const overlapped = { ...state, fireState: { ...black.fireState, effects: [...black.fireState.effects, duplicateDue] } }
    const resolved = expireFire(overlapped)
    expect(resolved.expired).toEqual([white.created[0], duplicateDue])
    expect(resolved.captures).toEqual([{ pieceId: 'black-D5', owner: 'white', square: sq('D5') }])
    expect(resolved.fireState).toEqual({ currentTurnIndex: 2, effects: black.created })
    expect(overlapped.fireState.effects).toHaveLength(3)
    expect(pieceAt(overlapped, sq('D5'))?.id).toBe('black-D5')
  })
})

describe('Fire and King safety', () => {
  it('only checks with active fire and never destroys a King even without an evasive move', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'],
      ['white', 'dragon', 'D4'],
      ['black', 'king', 'D6'],
      ['black', 'pawn', 'L10'],
    ]))
    expect(isInCheck(state, 'black')).toBe(false)
    const active = applyAction(state, dragonTurn('F3', 'before'))!
    expect(isInCheck(active, 'black')).toBe(true)
    expect(active.status).toMatchObject({ kind: 'active', inCheck: true })
    const resolved = applyAction(active, { kind: 'move', pieceId: 'black-L10', destination: sq('L9') })!
    expect(isInCheck(resolved, 'black')).toBe(false)
    expect(pieceAt(resolved, sq('D6'))?.id).toBe('black-D6')
    expect(resolved.moveHistory.at(-1)?.fire.captures).toEqual([])
  })

  it('continues to detect the Dragon’s ordinary Knight attack outside a cone', () => {
    const state = position([
      ['white', 'king', 'F5'],
      ['black', 'dragon', 'D4'],
      ['black', 'king', 'L12'],
    ])
    expect(fireCone(sq('D4'), 'black').map(squareName)).not.toContain('F5')
    expect(isInCheck(state, 'white')).toBe(true)
  })

  it('forbids a King landing in fire that survives the action, despite overlapping friendly fire', () => {
    const raw = position([...distantKings, ['white', 'bishop', 'A3']])
    const hostile = igniteFire(raw.fireState, 'black', oneSquarePreview('B1'))
    const overlapping = igniteFire(hostile.fireState, 'white', oneSquarePreview('B1'))
    raw.fireState = overlapping.fireState
    const state = startPosition(raw)
    expect(isHostileFire(state, sq('B1'), 'white')).toBe(true)
    expect(isHostileFire(state, sq('B1'), 'black')).toBe(true)
    expect(applyAction(state, { kind: 'move', pieceId: 'white-A1', destination: sq('B1') })).toBeNull()
  })

  it('prevents castling through active fire on the transit square with safe endpoints', () => {
    const raw = position([
      ['white', 'king', 'G1'],
      ['white', 'rook', 'L1'],
      ['black', 'king', 'G12'],
    ])
    raw.castlingRights.white.kingSide = true
    raw.fireState = igniteFire(raw.fireState, 'black', oneSquarePreview('H1')).fireState
    const state = startPosition(raw)
    expect(isInCheck(state, 'white')).toBe(false)
    expect(isSquareAttacked(state, sq('H1'), 'black')).toBe(true)
    expect(isSquareAttacked(state, sq('I1'), 'black')).toBe(false)
    expect(applyAction(state, { kind: 'castle', side: 'kingSide' })).toBeNull()
  })
})
