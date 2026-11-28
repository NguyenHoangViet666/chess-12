import {
  COLORS, PROMOTION_TYPES, RESURRECTION_TYPES,
  forward, opposite, pieceAt, remainingResurrections, sameSquare, squareName,
  type Action, type Color, type DragonAction, type GameState, type Piece, type Square, type TurnFire, type TurnRecord,
} from './model'
import { attacksSquare, enPassantVictim, moveDestinations } from './movement'
import { expireFire, firePreview, igniteFire, isHostileFire, turnsRemaining } from './fire'

type CastleSide = Extract<Action, { kind: 'castle' }>['side']

const castleFiles = {
  kingSide: { rook: 11, transit: 7, kingTo: 8, clear: [7, 8, 9, 10] },
  queenSide: { rook: 0, transit: 5, kingTo: 4, clear: [1, 2, 3, 4, 5] },
} as const

const colorName: Record<Color, string> = { white: 'White', black: 'Black' }
const pieceName = (piece: Piece['type']) => piece[0].toUpperCase() + piece.slice(1)
const homeRank = (color: Color) => color === 'white' ? 0 : 11

function clonePosition(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map(row => [...row]),
    pieces: { ...state.pieces },
    graveyard: { white: [...state.graveyard.white], black: [...state.graveyard.black] },
    castlingRights: { white: { ...state.castlingRights.white }, black: { ...state.castlingRights.black } },
  }
}

function loseRookRight(state: GameState, piece: Piece) {
  if (piece.baseType !== 'rook' || piece.spawnSquare.rank !== homeRank(piece.color)) return
  if (piece.spawnSquare.file === 0) state.castlingRights[piece.color].queenSide = false
  if (piece.spawnSquare.file === 11) state.castlingRights[piece.color].kingSide = false
}

function capture(state: GameState, victim: Piece, capturedIds: string[]) {
  if (!victim.currentSquare || victim.type === 'king') throw new Error('Invalid capture')
  const { file, rank } = victim.currentSquare
  state.board[rank][file] = null
  state.pieces[victim.id] = { ...victim, currentSquare: null }
  state.graveyard[victim.color].push(victim.id)
  capturedIds.push(victim.id)
  if (state.enPassant?.pawnId === victim.id) state.enPassant = null
  loseRookRight(state, victim)
}

function place(state: GameState, piece: Piece, to: Square, updates: Partial<Piece> = {}) {
  if (piece.currentSquare) state.board[piece.currentSquare.rank][piece.currentSquare.file] = null
  state.board[to.rank][to.file] = piece.id
  state.pieces[piece.id] = { ...piece, ...updates, currentSquare: to }
}

function relocate(state: GameState, piece: Piece, to: Square) {
  place(state, piece, to, { hasMoved: true })
  loseRookRight(state, piece)
  if (piece.type === 'king') state.castlingRights[piece.color] = { kingSide: false, queenSide: false }
}

function movePiece(state: GameState, next: GameState, piece: Piece, to: Square, capturedIds: string[]) {
  const victim = pieceAt(next, to) ?? enPassantVictim(state, piece, to)
  if (victim) capture(next, victim, capturedIds)
  relocate(next, piece, to)
}

function breathe(state: GameState, dragon: Piece, log: TurnFire) {
  const preview = firePreview(state, dragon)
  log.canceledBy = preview.canceledBy
  if (log.canceledBy.length) return
  const { fireState, created } = igniteFire(state.fireState, dragon.color, preview)
  state.fireState = fireState
  log.created = created
}

export function kingOf(state: GameState, color: Color): Piece | undefined {
  return Object.values(state.pieces).find(piece => piece.color === color && piece.type === 'king' && piece.currentSquare)
}

export function isSquareAttacked(state: GameState, square: Square, by: Color): boolean {
  return isHostileFire(state, square, opposite(by)) || Object.values(state.pieces).some(piece =>
    piece.color === by && piece.currentSquare !== null && attacksSquare(state, piece, square),
  )
}

export function isInCheck(state: GameState, color: Color): boolean {
  const square = kingOf(state, color)?.currentSquare
  return square ? isSquareAttacked(state, square, opposite(color)) : true
}

function canCastle(state: GameState, color: Color, side: CastleSide): boolean {
  if (!state.castlingRights[color][side]) return false
  const rank = homeRank(color)
  const files = castleFiles[side]
  const king = pieceAt(state, { file: 6, rank })
  const rook = pieceAt(state, { file: files.rook, rank })
  if (!king || king.color !== color || king.type !== 'king' || king.hasMoved ||
      !rook || rook.color !== color || rook.type !== 'rook' || rook.baseType !== 'rook' ||
      rook.hasMoved || !sameSquare(rook.currentSquare, rook.spawnSquare)) return false
  if (files.clear.some(file => pieceAt(state, { file, rank })) || isInCheck(state, color) ||
      isHostileFire(state, { file: files.kingTo, rank }, color)) return false

  const transit = clonePosition(state)
  place(transit, king, { file: files.transit, rank })
  return !isInCheck(transit, color)
}

export function livingNecromancers(state: GameState, color: Color): Piece[] {
  return Object.values(state.pieces).filter(piece => piece.type === 'necromancer' &&
    piece.color === color && piece.currentSquare !== null)
}

function resurrectionTargetBlock(state: GameState, piece: Piece) {
  if (piece.baseType === 'king' || piece.currentSquare || !state.graveyard[piece.color].includes(piece.id)) return 'ineligible'
  if (remainingResurrections(state, piece.color, piece.baseType) <= 0) return 'quota'
  if (pieceAt(state, piece.spawnSquare)) return 'occupied'
  return null
}

export function resurrectionBlock(state: GameState, piece: Piece) {
  return resurrectionTargetBlock(state, piece) ??
    (livingNecromancers(state, piece.color).length ? null : 'no-necromancer')
}

export interface ActionTransition {
  action: Action
  position: GameState
  capturedIds: string[]
  fire: TurnFire
  actor: Piece
  to: Square
}

function revive(next: GameState, piece: Piece) {
  const { baseType, color } = piece
  if (baseType === 'king') throw new Error('Invalid resurrection')
  place(next, piece, piece.spawnSquare, { type: baseType, promoted: false })
  next.graveyard[color] = next.graveyard[color].filter(id => id !== piece.id)
  const quota = next.resurrectionState[color]
  next.resurrectionState = { ...next.resurrectionState, [color]: { ...quota, [baseType]: quota[baseType] + 1 } }
}

/** Simulate one complete turn before checking the moving King's safety. */
function transition(state: GameState, action: Action): ActionTransition {
  const next = clonePosition(state)
  next.enPassant = null
  const capturedIds: string[] = []
  const fire: TurnFire = { created: [], expired: [], captures: [], canceledBy: [] }
  let actor: Piece
  let to: Square

  if (action.kind === 'resurrect') {
    actor = state.pieces[action.necromancerId]
    const revived = state.pieces[action.revivedPieceId]
    to = revived.spawnSquare
    revive(next, revived)
  } else if (action.kind === 'castle') {
    const rank = homeRank(state.currentPlayer)
    const files = castleFiles[action.side]
    actor = pieceAt(state, { file: 6, rank })!
    const rook = pieceAt(state, { file: files.rook, rank })!
    to = { file: files.kingTo, rank }
    relocate(next, actor, to)
    relocate(next, rook, { file: files.transit, rank })
  } else {
    actor = state.pieces[action.pieceId]
    to = action.destination
    if (action.kind === 'dragon' && action.fireTiming === 'before') breathe(next, actor, fire)
    movePiece(state, next, actor, to, capturedIds)
    if (action.kind === 'move' && action.promotion) {
      next.pieces[actor.id] = { ...next.pieces[actor.id], type: action.promotion, promoted: true }
    }
    if (actor.type === 'pawn' && Math.abs(to.rank - actor.currentSquare!.rank) === 2) {
      next.enPassant = { target: { file: to.file, rank: to.rank - forward(actor.color) }, pawnId: actor.id }
    }
    if (action.kind === 'dragon' && action.fireTiming === 'after') breathe(next, next.pieces[actor.id], fire)
  }

  const expiration = expireFire(next)
  next.fireState = expiration.fireState
  fire.expired = expiration.expired
  fire.captures = expiration.captures
  for (const victim of fire.captures) capture(next, next.pieces[victim.pieceId], capturedIds)

  next.halfMoveClock = actor.type === 'pawn' || capturedIds.length > 0 || action.kind === 'resurrect'
    ? 0 : state.halfMoveClock + 1
  next.fullMoveNumber = state.fullMoveNumber + (state.currentPlayer === 'black' ? 1 : 0)
  next.currentPlayer = opposite(state.currentPlayer)
  return { action, position: next, actor, to, capturedIds, fire }
}

function* candidates(state: GameState): Generator<Action> {
  for (const piece of Object.values(state.pieces)) {
    if (!piece.currentSquare || piece.color !== state.currentPlayer) continue
    for (const destination of moveDestinations(state, piece)) {
      if (piece.type === 'dragon') {
        for (const fireTiming of ['none', 'after', 'before'] as const) {
          yield { kind: 'dragon', pieceId: piece.id, destination, fireTiming }
        }
      } else if (piece.type === 'pawn' && destination.rank === homeRank(opposite(piece.color))) {
        for (const promotion of PROMOTION_TYPES) yield { kind: 'move', pieceId: piece.id, destination, promotion }
      } else {
        yield { kind: 'move', pieceId: piece.id, destination }
      }
    }
    if (piece.type === 'necromancer') {
      for (const id of state.graveyard[piece.color]) {
        if (!resurrectionTargetBlock(state, state.pieces[id])) {
          yield { kind: 'resurrect', necromancerId: piece.id, revivedPieceId: id }
        }
      }
    }
  }
  for (const side of ['kingSide', 'queenSide'] as const) {
    if (canCastle(state, state.currentPlayer, side)) yield { kind: 'castle', side }
  }
}

export function* safeTransitions(
  state: GameState,
  consider?: (action: Action) => boolean,
): Generator<ActionTransition> {
  for (const action of candidates(state)) {
    if (consider && !consider(action)) continue
    const result = transition(state, action)
    if (!isInCheck(result.position, state.currentPlayer)) yield result
  }
}

export function* safeActions(state: GameState): Generator<Action> {
  for (const { action } of safeTransitions(state)) yield action
}

export function describeTurn(state: GameState, result: ActionTransition): TurnRecord {
  const { action, actor, to, capturedIds, fire, position } = result
  const from = actor.currentSquare
  const move = from ? `${squareName(from)} → ${squareName(to)}` : squareName(to)
  let detail = `${pieceName(actor.type)} ${move}`
  if (action.kind === 'resurrect') {
    detail = `Necromancer ${squareName(from!)} resurrects ${pieceName(state.pieces[action.revivedPieceId].baseType)} at ${squareName(to)}`
  } else if (action.kind === 'castle') {
    detail = `Castles ${action.side === 'kingSide' ? 'kingside' : 'queenside'} (${move})`
  } else if (action.kind === 'dragon' && action.fireTiming !== 'none') {
    detail += action.fireTiming === 'before' ? ', fire before moving' : ', fire after moving'
    if (fire.canceledBy.length) {
      const shields = fire.canceledBy.map(id => squareName(state.pieces[id].currentSquare!))
      detail += ` · fire canceled by Shielder at ${shields.join(', ')}`
    } else {
      detail += fire.created.length ? ` · ignites ${fire.created.map(effect => squareName(effect.square)).join(', ')}`
        : ' · no squares ignited'
    }
  } else if (action.kind === 'move' && action.promotion) {
    detail += `, promotes to ${pieceName(action.promotion)}`
  }
  const normal = capturedIds.filter(id => !fire.captures.some(victim => victim.pieceId === id))
  if (normal.length) detail += ` · ${normal.map(id => pieceName(position.pieces[id].type)).join(', ')} captured`
  if (fire.expired.length) detail += ` · fire expires on ${fire.expired.map(effect => squareName(effect.square)).join(', ')}`
  if (fire.captures.length) detail += ` · ${fire.captures.map(({ pieceId }) => {
    const piece = position.pieces[pieceId]
    return `${colorName[piece.color]} ${pieceName(piece.type)}`
  }).join(', ')} destroyed by fire`
  return {
    action, color: state.currentPlayer, fullMoveNumber: state.fullMoveNumber, pieceType: actor.type,
    from, to, capturedIds, fire, description: `${colorName[state.currentPlayer]}: ${detail}`,
  }
}

/** Format a generated turn without modifying the input. */
export function simulateAction(state: GameState, action: Action): { position: GameState; turn: TurnRecord } {
  const result = transition(state, action)
  return { position: result.position, turn: describeTurn(state, result) }
}

export function sameAction(a: Action, b: Action): boolean {
  if (a.kind === 'castle') return b.kind === 'castle' && a.side === b.side
  if (a.kind === 'resurrect') {
    return b.kind === 'resurrect' && a.necromancerId === b.necromancerId && a.revivedPieceId === b.revivedPieceId
  }
  if (!('destination' in b) || a.pieceId !== b.pieceId || !sameSquare(a.destination, b.destination)) return false
  if (a.kind === 'move') return b.kind === 'move' && a.promotion === b.promotion
  return b.kind === 'dragon' && a.fireTiming === b.fireTiming
}

export function dragonPreview(state: GameState, dragon: Piece, action?: DragonAction) {
  if (action?.fireTiming === 'after') {
    const staged = clonePosition(state)
    movePiece(state, staged, dragon, action.destination, [])
    return firePreview(staged, staged.pieces[dragon.id])
  }
  return firePreview(state, dragon)
}

/** True when the acting or revived piece would be lost to an expiring fire effect. */
export function actionFireRisk(state: GameState, action: Action): boolean {
  if (action.kind === 'castle' || !state.fireState.effects.length) return false
  const id = action.kind === 'resurrect' ? action.revivedPieceId : action.pieceId
  return transition(state, action).fire.captures.some(capture => capture.pieceId === id)
}

export function positionKey(state: GameState): string {
  const ep = state.enPassant
  const availableEnPassant = ep && Object.values(state.pieces).some(piece => {
    if (piece.color !== state.currentPlayer || !enPassantVictim(state, piece, ep.target)) return false
    const next = transition(state, { kind: 'move', pieceId: piece.id, destination: ep.target }).position
    return !isInCheck(next, piece.color)
  })
  const activeFire = state.fireState.effects
    .map(effect => [effect.owner, effect.square.file, effect.square.rank, turnsRemaining(effect, state.fireState.currentTurnIndex)] as const)
    .filter(effect => effect[3] > 0).sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0].localeCompare(b[0]))
  return JSON.stringify([
    state.currentPlayer,
    COLORS.map(color => [state.castlingRights[color].kingSide, state.castlingRights[color].queenSide]),
    availableEnPassant && ep ? [ep.target.file, ep.target.rank, ep.pawnId] : null,
    Object.values(state.pieces).sort((a, b) => a.id.localeCompare(b.id)).map(piece => [
      piece.id, piece.color, piece.baseType, piece.type, piece.spawnSquare.file, piece.spawnSquare.rank,
      piece.currentSquare ? [piece.currentSquare.file, piece.currentSquare.rank] : null,
      piece.baseType === 'pawn' && piece.hasMoved,
    ]),
    COLORS.map(color => [...state.graveyard[color]].sort()),
    COLORS.map(color => RESURRECTION_TYPES.map(type => state.resurrectionState[color][type])),
    activeFire,
  ])
}

export function actionLanding(state: GameState, action: Action): { pieceId: string; square: Square; captures: boolean } | null {
  if (action.kind === 'resurrect') return null
  if (action.kind === 'castle') {
    const king = kingOf(state, state.currentPlayer)
    const square = { file: castleFiles[action.side].kingTo, rank: homeRank(state.currentPlayer) }
    return king ? { pieceId: king.id, square, captures: false } : null
  }
  const piece = state.pieces[action.pieceId]
  const square = action.destination
  return {
    pieceId: piece.id,
    square,
    captures: Boolean(pieceAt(state, square) ?? enPassantVictim(state, piece, square)),
  }
}
