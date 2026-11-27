import { fireReport, isFireThreatened, type FireCell } from '../engine/fire'
import {
  BOARD_SIZE, COLORS, forward, opposite, pieceAt, sameSquare,
  type Color, type GameState, type Piece, type PieceType, type Square,
} from '../engine/model'
import { attacksSquare, moveDestinations } from '../engine/movement'

const values: Record<PieceType, number> = {
  king: 0,
  pawn: 100,
  knight: 320,
  bishop: 370,
  rook: 555,
  queen: 1060,
  necromancer: 365,
  dragon: 610,
  shielder: 385,
}

export function pieceValue(type: PieceType): number {
  return values[type]
}

export interface EvaluationTerms {
  material: number
  placement: number
  dragonFire: number
  shield: number
  resurrection: number
  kingSafety: number
}

interface Side {
  color: Color
  pieces: Piece[]
  dragons: Piece[]
  king?: Piece
  material: number
  pawnFiles: number[]
  firstPawnRank: number[]
  necromancers: number
}

const lastRank = BOARD_SIZE - 1
const center = lastRank / 2
const relativeRank = (color: Color, rank: number) => color === 'white' ? rank : lastRank - rank
const centrality = (square: Square) => lastRank - Math.abs(square.file - center) - Math.abs(square.rank - center)
const distance = (a: Square, b: Square) => Math.max(Math.abs(a.file - b.file), Math.abs(a.rank - b.rank))

function makeSide(color: Color): Side {
  return {
    color, pieces: [], dragons: [],
    material: 0, necromancers: 0,
    pawnFiles: Array<number>(BOARD_SIZE).fill(0),
    firstPawnRank: Array<number>(BOARD_SIZE).fill(BOARD_SIZE),
  }
}

function placement(state: GameState, own: Side, enemy: Side, endgame: number): number {
  let score = 0
  for (const piece of own.pieces) {
    const square = piece.currentSquare!
    const { file, rank } = square
    const centered = centrality(square)
    const advance = relativeRank(own.color, rank)
    switch (piece.type) {
      case 'pawn': {
        const enemyRank = relativeRank(enemy.color, rank)
        const left = file > 0 ? enemy.firstPawnRank[file - 1] : BOARD_SIZE
        const right = file < lastRank ? enemy.firstPawnRank[file + 1] : BOARD_SIZE
        const passed = Math.min(left, enemy.firstPawnRank[file], right) >= enemyRank
        const steps = Math.max(0, advance - 2)
        score += steps * (3 + endgame * 2) + centered * (1 - endgame)
        if (passed) score += 8 + steps * (2 + endgame * 5) + Math.max(0, advance - 8) ** 2 * 7
        if (!(own.pawnFiles[file - 1] || own.pawnFiles[file + 1])) score -= 9
        if (pieceAt(state, { file, rank: rank + forward(own.color) })) score -= 5
        break
      }
      case 'knight':
        score += centered * 4
        break
      case 'bishop':
        score += centered * 2 + (sameSquare(square, piece.spawnSquare) ? 0 : 6 * (1 - endgame))
        break
      case 'rook':
        score += centered + (own.pawnFiles[file] ? 0 : enemy.pawnFiles[file] ? 7 : 15)
        break
      case 'queen':
        score += centered * 1.5
        break
      case 'dragon':
        score += centered * 3.5 + Math.min(6, advance) - Math.max(0, advance - 9) * 8
        break
      case 'shielder':
        score += centered * 2
        break
      case 'necromancer':
        score += centered + advance * 1.2
        break
      case 'king':
        score += centered * (endgame * 5 - 2)
        break
    }
  }
  for (const count of own.pawnFiles) score -= Math.max(0, count - 1) * 12
  return score
}

// Cheap range filter for testing control of a square or its immediately adjacent window.
function nearAttack(piece: Piece, target: Square, padding: number): boolean {
  const origin = piece.currentSquare!
  const files = Math.abs(origin.file - target.file)
  const ranks = Math.abs(origin.rank - target.rank)
  switch (piece.type) {
    case 'queen':
      return Math.min(files, ranks) <= padding || Math.abs(files - ranks) <= 2 * padding
    case 'rook':
      return Math.min(files, ranks) <= padding
    case 'bishop':
      return Math.abs(files - ranks) <= 2 * padding
    case 'shielder':
      return Math.min(files, ranks) <= padding && Math.max(files, ranks) <= 3 + padding
    case 'dragon':
    case 'knight':
      return Math.max(files, ranks) <= 2 + padding
    default:
      return Math.max(files, ranks) <= 1 + padding
  }
}

function attacksKing(state: GameState, attacker: Piece, square: Square): boolean {
  return nearAttack(attacker, square, 0) &&
    (attacksSquare(state, attacker, square) ||
      (attacker.type === 'dragon' && isFireThreatened(state, attacker, square)))
}

function kingDanger(state: GameState, own: Side, enemy: Side, endgame: number): number {
  const king = own.king
  if (!king?.currentSquare) return 0
  const origin = king.currentSquare
  const attackers = enemy.pieces.filter(piece => nearAttack(piece, origin, 1))
  const inCheck = attackers.some(piece => attacksKing(state, piece, origin))

  // While evading check the King's departure can uncover sliding attacks past its old square.
  let escapeState = state
  if (inCheck) {
    const board = [...state.board]
    board[origin.rank] = [...board[origin.rank]]
    board[origin.rank][origin.file] = null
    escapeState = { ...state, board }
  }

  let safe = 0
  let covered = 0
  for (const square of moveDestinations(state, king)) {
    if (attackers.some(piece => attacksKing(escapeState, piece, square))) covered++
    else safe++
  }
  let danger = inCheck ? 34 : 0
  if (inCheck || covered > 0) danger += covered * 7 + Math.max(0, 3 - safe) * 9

  // Material ahead can be converted by driving a bare King toward the rim and bringing support.
  const enemyKing = enemy.king?.currentSquare
  if (enemyKing && enemy.material >= own.material + 300 && endgame > 0.45) {
    const edge = Math.min(origin.file, lastRank - origin.file, origin.rank, lastRank - origin.rank)
    const pursuit = lastRank - distance(origin, enemyKing)
    const closestForce = enemy.pieces.reduce((closest, piece) =>
      pieceValue(piece.type) >= values.knight
        ? Math.min(closest, distance(origin, piece.currentSquare!)) : closest, lastRank)
    danger += endgame * ((5 - edge) * 7 + pursuit * 3 + (lastRank - closestForce) * 2)
  }
  return danger
}

function reserve(state: GameState, side: Side): number {
  if (side.necromancers === 0) return 0
  let best = 0
  let alternatives = 0
  for (const id of state.graveyard[side.color]) {
    const piece = state.pieces[id]
    if (piece.baseType === 'king' || pieceAt(state, piece.spawnSquare)) continue
    const value = pieceValue(piece.baseType)
    if (value > best) {
      alternatives += best
      best = value
    } else {
      alternatives += value
    }
  }
  return best * 0.52 + Math.min(85, alternatives * 0.09) + (best > 0 && side.necromancers > 1 ? 24 : 0)
}

interface Burn {
  value: number
  victims: string[]
}

function burnValue(state: GameState, cells: FireCell[], checkingBonus = false): Burn {
  let value = 0
  const victims: string[] = []
  for (const cell of cells) {
    if (cell.effect === 'victim' && cell.pieceId) {
      victims.push(cell.pieceId)
      value += pieceValue(state.pieces[cell.pieceId].type)
    } else if (checkingBonus && cell.effect === 'king') {
      value += 65
    }
  }
  return { value, victims }
}

function exposedLanding(state: GameState, enemy: Side, square: Square, victims: string[]): boolean {
  const landingVictim = pieceAt(state, square)?.id
  return enemy.pieces.some(piece =>
    piece.id !== landingVictim && !victims.includes(piece.id) &&
    nearAttack(piece, square, 0) && attacksSquare(state, piece, square),
  )
}

function dragonOpportunity(
  state: GameState, dragon: Piece, enemy: Side, currentReport: FireCell[],
): number {
  const destinations = moveDestinations(state, dragon)
  if (!destinations.length) return 0

  const current = burnValue(state, currentReport)
  const safeBefore = current.value > 0 &&
    destinations.some(square => !exposedLanding(state, enemy, square, current.victims))
  const exchangeCost = values.dragon * 0.7
  const before = Math.max(0, current.value - (safeBefore ? 0 : exchangeCost)) * 0.16

  let after = 0
  for (const destination of destinations) {
    // The landing capture is outside the cone. A still-present old Dragon is a harmless ally.
    const report = fireReport(state, { ...dragon, currentSquare: destination })
    const burn = burnValue(state, report, true)
    if (burn.value * 0.095 <= after) continue
    const risk = exposedLanding(state, enemy, destination, burn.victims) ? exchangeCost : 0
    after = Math.max(after, (burn.value - risk) * 0.095)
  }
  return Math.min(180, Math.max(before, after))
}

export function evaluatePositionBreakdown(state: GameState): Record<Color, EvaluationTerms> {
  const sides = { white: makeSide('white'), black: makeSide('black') }
  let nonPawnMaterial = 0
  for (const piece of Object.values(state.pieces)) {
    const square = piece.currentSquare
    if (!square) continue
    const side = sides[piece.color]
    side.pieces.push(piece)
    side.material += pieceValue(piece.type)
    if (piece.type === 'pawn') {
      side.pawnFiles[square.file]++
      const rank = relativeRank(side.color, square.rank)
      side.firstPawnRank[square.file] = Math.min(side.firstPawnRank[square.file], rank)
    } else {
      nonPawnMaterial += pieceValue(piece.type)
      if (piece.type === 'king') side.king = piece
      if (piece.type === 'dragon') side.dragons.push(piece)
      if (piece.type === 'necromancer') side.necromancers++
    }
  }

  const endgame = 1 - Math.min(1, nonPawnMaterial / 10_500)
  const intercepted = new Set<string>()
  const exposed = new Set<string>()
  const fire = { white: 0, black: 0 }
  for (const color of COLORS) {
    for (const dragon of sides[color].dragons) {
      const report = fireReport(state, dragon)
      for (const cell of report) {
        if (!cell.pieceId) continue
        if (cell.effect === 'protected' || cell.effect === 'protected-king') intercepted.add(cell.pieceId)
        if (cell.effect === 'victim' || cell.effect === 'king') exposed.add(cell.pieceId)
      }
      // A side can activate only one Dragon on its turn.
      const opportunity = dragonOpportunity(state, dragon, sides[opposite(color)], report)
      fire[color] = Math.max(fire[color], opportunity)
    }
  }

  const shield = { white: 0, black: 0 }
  for (const id of intercepted) {
    if (exposed.has(id)) continue
    const piece = state.pieces[id]
    shield[piece.color] += piece.type === 'king' ? 50 : piece.type === 'shielder'
      ? 10 : Math.min(45, 8 + pieceValue(piece.type) * 0.045)
  }

  function score(color: Color): EvaluationTerms {
    const own = sides[color]
    const enemy = sides[opposite(color)]
    return {
      material: own.material,
      placement: Math.round(placement(state, own, enemy, endgame)),
      dragonFire: Math.round(fire[color]),
      shield: Math.round(shield[color]),
      resurrection: Math.round(reserve(state, own)),
      kingSafety: -Math.round(kingDanger(state, own, enemy, endgame)),
    }
  }
  return { white: score('white'), black: score('black') }
}

function total(terms: EvaluationTerms): number {
  return terms.material + terms.placement + terms.dragonFire + terms.shield + terms.resurrection + terms.kingSafety
}

export function evaluatePosition(state: GameState): number {
  const scores = evaluatePositionBreakdown(state)
  return total(scores[state.currentPlayer]) - total(scores[opposite(state.currentPlayer)])
}
