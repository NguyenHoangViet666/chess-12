import { describe, expect, it } from 'vitest'
import { fireReport, isFireThreatened, shielderProtection } from '../engine/fire'
import { applyAction, legalActions, startPosition } from '../engine/game'
import { pieceAt, squareName, type Action, type PieceType } from '../engine/model'
import { attacksSquare } from '../engine/movement'
import { isInCheck } from '../engine/rules'
import { position, sq, type Entry } from './fixture'

const distantKings = [
  ['white', 'king', 'A1'],
  ['black', 'king', 'L12'],
] as const satisfies readonly Entry[]

function move(pieceId: string, destination: string): Action {
  return { kind: 'move', pieceId, destination: sq(destination) }
}

describe('Shielder movement', () => {
  it('moves up to three squares on a file or rank and stops at the first piece', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['white', 'pawn', 'D7'],
      ['black', 'pawn', 'D3'],
    ]))
    const destinations = legalActions(state).flatMap(action =>
      action.kind === 'move' && action.pieceId === 'white-D5' ? [squareName(action.destination)] : [],
    )
    expect(destinations.sort()).toEqual(['A5', 'B5', 'C5', 'D3', 'D4', 'D6', 'E5', 'F5', 'G5'])
    for (const illegal of ['E6', 'D8', 'H5', 'D2']) {
      expect(applyAction(state, move('white-D5', illegal))).toBeNull()
    }
    const next = applyAction(state, move('white-D5', 'D3'))!
    expect(pieceAt(next, sq('D3'))?.id).toBe('white-D5')
    expect(next.graveyard.black).toEqual(['black-D3'])
  })

  it('can capture an enemy in front of itself', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['black', 'rook', 'D7'],
    ]))
    const next = applyAction(state, move('white-D5', 'D7'))!
    expect(pieceAt(next, sq('D7'))?.id).toBe('white-D5')
    expect(next.graveyard.black).toEqual(['black-D7'])
  })
})

describe('Shielder frontal guard', () => {
  const frontalAttackers = [
    ['rook', 'D9'],
    ['queen', 'D9'],
    ['shielder', 'D8'],
    ['king', 'D6'],
  ] as const satisfies readonly (readonly [PieceType, string])[]

  it.each(frontalAttackers)('stops a frontal %s from %s', (attacker, from) => {
    const pieces: Entry[] = [
      ['white', 'king', 'A1'],
      ['white', 'shielder', 'D5'],
      ['black', attacker, from],
    ]
    if (attacker !== 'king') pieces.push(['black', 'king', 'L12'])
    const state = startPosition(position(pieces, 'black'))
    expect(attacksSquare(state, state.pieces['black-' + from], sq('D5'))).toBe(false)
    expect(applyAction(state, move('black-' + from, 'D5'))).toBeNull()
  })

  const validAttackers = [
    ['rook', 'F5'],
    ['rook', 'D2'],
    ['bishop', 'F7'],
    ['pawn', 'E6'],
    ['knight', 'F6'],
    ['dragon', 'F6'],
  ] as const satisfies readonly (readonly [PieceType, string])[]

  it.each(validAttackers)('can be captured by a %s from %s', (attacker, from) => {
    const id = 'black-' + from
    const state = startPosition(position([
      ...distantKings,
      ['white', 'shielder', 'D5'],
      ['black', attacker, from],
    ], 'black'))
    expect(attacksSquare(state, state.pieces[id], sq('D5'))).toBe(true)
    const action = attacker === 'dragon'
      ? { kind: 'dragon', pieceId: id, destination: sq('D5'), fireTiming: 'none' } as const
      : move(id, 'D5')
    const next = applyAction(state, action)!
    expect(next.graveyard.white).toEqual(['white-D5'])
    expect(pieceAt(next, sq('D5'))?.id).toBe(id)
  })

  it('uses the Black Shielder’s downward facing and still allows a direct capture from behind', () => {
    const state = startPosition(position([
      ...distantKings,
      ['black', 'shielder', 'D8'],
      ['white', 'rook', 'D4'],
      ['white', 'rook', 'D11'],
    ]))
    expect(applyAction(state, move('white-D4', 'D8'))).toBeNull()
    expect(applyAction(state, move('white-D11', 'D8'))?.graveyard.black).toEqual(['black-D8'])
  })

  it('does not protect a King from a direct sliding check just because it faces the attacker', () => {
    const state = position([
      ['white', 'king', 'D5'],
      ['white', 'shielder', 'E5'],
      ['black', 'rook', 'D9'],
      ['black', 'king', 'L12'],
    ])
    expect(isInCheck(state, 'white')).toBe(true)
  })
})

describe('Shielder fire interception', () => {
  it('protects both Shielders and a King on the center line, leaving the other outer cell exposed', () => {
    const state = startPosition(position([
      ['white', 'king', 'A1'],
      ['white', 'dragon', 'D4'],
      ['black', 'shielder', 'D5'],
      ['black', 'shielder', 'C6'],
      ['black', 'king', 'D6'],
      ['black', 'pawn', 'E6'],
    ]))
    const dragon = state.pieces['white-D4']
    const preview = fireReport(state, dragon)
    expect(Object.fromEntries(preview.map(cell => [squareName(cell.square), cell.effect])))
      .toEqual({ D5: 'protected', C6: 'protected', D6: 'protected-king', E6: 'victim' })
    expect(isFireThreatened(state, dragon, sq('D6'))).toBe(false)
    expect(isFireThreatened(state, dragon, sq('E6'))).toBe(true)
    expect(isInCheck(state, 'black')).toBe(false)

    const next = applyAction(state, {
      kind: 'dragon', pieceId: dragon.id, destination: sq('F3'), fireTiming: 'before',
    })!
    expect(next.graveyard.black).toEqual(['black-E6'])
    expect(pieceAt(next, sq('D5'))?.id).toBe('black-D5')
    expect(pieceAt(next, sq('C6'))?.id).toBe('black-C6')
    expect(pieceAt(next, sq('D6'))?.id).toBe('black-D6')
  })

  it('protects non-King allies directly behind the Shielder as well', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['black', 'shielder', 'D5'],
      ['black', 'bishop', 'D6'],
      ['black', 'knight', 'C6'],
    ]))
    const next = applyAction(state, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })!
    expect(next.graveyard.black).toEqual(['black-C6'])
    expect(pieceAt(next, sq('D6'))?.id).toBe('black-D6')
  })

  it('does not shield an enemy behind a Shielder allied with the firing Dragon', () => {
    const state = startPosition(position([
      ...distantKings,
      ['white', 'dragon', 'D4'],
      ['white', 'shielder', 'D5'],
      ['black', 'bishop', 'D6'],
    ]))
    const next = applyAction(state, {
      kind: 'dragon', pieceId: 'white-D4', destination: sq('F3'), fireTiming: 'before',
    })!
    expect(next.graveyard.black).toEqual(['black-D6'])
    expect(pieceAt(next, sq('D5'))?.id).toBe('white-D5')
  })

  it('rejects moving a shield away from its King and permits capturing the threatening Dragon', () => {
    const state = startPosition(position([
      ['white', 'king', 'D4'],
      ['white', 'shielder', 'D5'],
      ['black', 'dragon', 'D6'],
      ['black', 'king', 'L12'],
    ]))
    expect(isInCheck(state, 'white')).toBe(false)
    const protection = shielderProtection(state, state.pieces['white-D5'])
    expect(protection.axis.map(squareName)).toEqual(['D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12'])
    expect(protection.protectedLine.map(squareName)).toEqual(['D5', 'D4'])
    expect(applyAction(state, move('white-D5', 'C5'))).toBeNull()
    expect(applyAction(state, move('white-D5', 'D6'))?.graveyard.black).toEqual(['black-D6'])
  })

  it('lets a Shielder intercept existing fire check by moving into the central line', () => {
    const state = startPosition(position([
      ['white', 'king', 'D4'],
      ['white', 'shielder', 'C5'],
      ['black', 'dragon', 'D6'],
      ['black', 'king', 'L12'],
    ]))
    expect(isInCheck(state, 'white')).toBe(true)
    expect(shielderProtection(state, state.pieces['white-C5']).protectedLine).toEqual([])
    const next = applyAction(state, move('white-C5', 'D5'))!
    expect(isInCheck(next, 'white')).toBe(false)
  })
})
