import {
  forward, inBounds, pieceAt, sameSquare,
  type Color, type FireCapture, type FireEffect, type FireState, type GameState, type Piece, type Square,
} from './model'

export interface FireCell {
  square: Square
  pieceId: string | null
  effect: 'empty' | 'ally' | 'threatened' | 'king' | 'shielder'
  refresh: boolean
}

export interface FirePreview {
  cells: FireCell[]
  canceledBy: string[]
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

export function turnsRemaining(effect: FireEffect, turnIndex: number): number {
  if (turnIndex < effect.createdAtTurn) return 0
  return Math.max(0, effect.expiresAfterTurn - turnIndex + 1)
}

export function isBurnable(piece: Piece, owner: Color): boolean {
  return piece.color !== owner && piece.type !== 'king' && piece.type !== 'shielder'
}

export function isHostileFire(state: GameState, square: Square, color: Color): boolean {
  const { currentTurnIndex, effects } = state.fireState
  return effects.some(effect =>
    effect.owner !== color &&
    turnsRemaining(effect, currentTurnIndex) > 0 &&
    sameSquare(effect.square, square),
  )
}

export function firePreview(state: GameState, dragon: Piece): FirePreview {
  if (!dragon.currentSquare) return { cells: [], canceledBy: [] }

  const targets = fireCone(dragon.currentSquare, dragon.color).map(square => ({ square, piece: pieceAt(state, square) }))
  const canceledBy = targets.flatMap(({ piece }) => piece?.type === 'shielder' ? [piece.id] : [])
  const { currentTurnIndex, effects } = state.fireState
  const cells = targets.map(({ square, piece }): FireCell => {
    let effect: FireCell['effect'] = 'empty'
    if (piece?.type === 'shielder') effect = 'shielder'
    else if (piece?.color === dragon.color) effect = 'ally'
    else if (piece?.type === 'king') effect = 'king'
    else if (piece) effect = 'threatened'

    const refresh = canceledBy.length === 0 && effects.some(active =>
      active.owner === dragon.color &&
      turnsRemaining(active, currentTurnIndex) > 0 &&
      sameSquare(active.square, square),
    )
    return { square, pieceId: piece?.id ?? null, effect, refresh }
  })
  return { cells, canceledBy }
}

export function igniteFire(
  fireState: FireState, owner: Color, preview: FirePreview,
): { fireState: FireState; created: FireEffect[] } {
  if (preview.canceledBy.length || !preview.cells.length) return { fireState, created: [] }

  const { currentTurnIndex } = fireState
  const effects = [...fireState.effects]
  const created: FireEffect[] = []
  const expiresAfterTurn = currentTurnIndex + 1
  for (const { square } of preview.cells) {
    const index = effects.findIndex(effect =>
      effect.owner === owner && turnsRemaining(effect, currentTurnIndex) > 0 && sameSquare(effect.square, square),
    )
    if (index >= 0) {
      const refreshed = { ...effects[index], expiresAfterTurn }
      effects[index] = refreshed
      created.push(refreshed)
    } else {
      const effect = {
        id: [owner, square.file, square.rank, currentTurnIndex].join(':'),
        owner, square, createdAtTurn: currentTurnIndex, expiresAfterTurn,
      }
      effects.push(effect)
      created.push(effect)
    }
  }
  return { fireState: { currentTurnIndex, effects }, created }
}

export function expireFire(
  state: GameState,
): { fireState: FireState; expired: FireEffect[]; captures: FireCapture[] } {
  const { currentTurnIndex, effects } = state.fireState
  const remaining: FireEffect[] = []
  const expired: FireEffect[] = []
  const captures: FireCapture[] = []

  for (const effect of effects) {
    if (effect.expiresAfterTurn > currentTurnIndex) {
      remaining.push(effect)
      continue
    }
    expired.push(effect)
    if (effect.expiresAfterTurn !== currentTurnIndex || turnsRemaining(effect, currentTurnIndex) === 0) continue
    const piece = pieceAt(state, effect.square)
    if (piece && isBurnable(piece, effect.owner) && !captures.some(capture => capture.pieceId === piece.id)) {
      captures.push({ pieceId: piece.id, owner: effect.owner, square: effect.square })
    }
  }

  return { fireState: { currentTurnIndex: currentTurnIndex + 1, effects: remaining }, expired, captures }
}

export function shielderAxis(shielder: Piece): Square[] {
  const origin = shielder.currentSquare
  if (!origin) return []

  const direction = forward(shielder.color)
  const axis: Square[] = []
  for (let rank = origin.rank + direction; inBounds({ file: origin.file, rank }); rank += direction) {
    axis.push({ file: origin.file, rank })
  }
  return axis
}
