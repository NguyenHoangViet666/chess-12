import { forward, inBounds, pieceAt, sameSquare, type Color, type GameState, type Piece, type Square } from './model'

export interface FireCell {
  square: Square
  effect: 'empty' | 'ally' | 'victim' | 'protected' | 'king' | 'protected-king'
  pieceId: string | null
}

export function fireCone(origin: Square, color: Color): Square[] {
  const direction = forward(color)
  return [
    { file: origin.file, rank: origin.rank + direction },
    { file: origin.file - 1, rank: origin.rank + 2 * direction },
    { file: origin.file, rank: origin.rank + 2 * direction },
    { file: origin.file + 1, rank: origin.rank + 2 * direction },
  ].filter(inBounds)
}

function interceptingShielder(state: GameState, dragon: Piece, square: Square): Piece | null {
  const origin = dragon.currentSquare
  if (!origin || square.file !== origin.file) return null

  const direction = forward(dragon.color)
  if (square.rank !== origin.rank + 2 * direction) return null

  const shield = pieceAt(state, { file: origin.file, rank: origin.rank + direction })
  return shield?.type === 'shielder' && shield.color !== dragon.color ? shield : null
}

export function fireReport(state: GameState, dragon: Piece): FireCell[] {
  if (!dragon.currentSquare) return []

  return fireCone(dragon.currentSquare, dragon.color).map(square => {
    const target = pieceAt(state, square)
    const pieceId = target?.id ?? null
    if (!target) return { square, effect: 'empty', pieceId }
    if (target.color === dragon.color) return { square, effect: 'ally', pieceId }

    const shielded = target.type === 'shielder' || interceptingShielder(state, dragon, square) !== null
    if (target.type === 'king') return { square, effect: shielded ? 'protected-king' : 'king', pieceId }
    return { square, effect: shielded ? 'protected' : 'victim', pieceId }
  })
}

export function fireVictims(state: GameState, dragon: Piece): Piece[] {
  return fireReport(state, dragon).flatMap(cell => {
    if (cell.effect !== 'victim' || cell.pieceId === null) return []
    const victim = state.pieces[cell.pieceId]
    return victim ? [victim] : []
  })
}

export function isFireThreatened(state: GameState, dragon: Piece, square: Square): boolean {
  const origin = dragon.currentSquare
  if (!origin || !inBounds(square)) return false

  const distance = (square.rank - origin.rank) * forward(dragon.color)
  const fileOffset = Math.abs(square.file - origin.file)
  const insideCone = (distance === 1 && fileOffset === 0) || (distance === 2 && fileOffset <= 1)
  return insideCone && interceptingShielder(state, dragon, square) === null
}

export function shielderProtection(state: GameState, shielder: Piece): {
  axis: Square[]
  protectedLine: Square[]
} {
  const origin = shielder.currentSquare
  if (!origin) return { axis: [], protectedLine: [] }

  const direction = forward(shielder.color)
  const axis: Square[] = []
  for (let rank = origin.rank + direction; inBounds({ file: origin.file, rank }); rank += direction) {
    axis.push({ file: origin.file, rank })
  }

  const protectedLine: Square[] = []
  for (const dragon of Object.values(state.pieces)) {
    if (dragon.type !== 'dragon' || dragon.color === shielder.color || !dragon.currentSquare) continue

    for (const square of fireCone(dragon.currentSquare, dragon.color)) {
      const shieldProtects = sameSquare(square, origin) || interceptingShielder(state, dragon, square)?.id === shielder.id
      if (shieldProtects && !protectedLine.some(protectedSquare => sameSquare(protectedSquare, square))) {
        protectedLine.push(square)
      }
    }
  }

  return { axis, protectedLine }
}
