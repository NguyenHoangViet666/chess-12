import { BOARD_SIZE } from '../engine/model'
import {
  NUM_PIECE_TYPES, NUM_SQUARES, PT_BISHOP, PT_DRAGON, PT_KING, PT_KNIGHT,
  PT_NECROMANCER, PT_PAWN, PT_QUEEN, PT_ROOK, PT_SHIELDER, WHITE,
} from './zobrist'

export const MG_VALUES = new Int32Array([
  100,  // pawn
  325,  // knight
  375,  // bishop
  545,  // rook
  1075, // queen
  0,    // king
  415,  // necromancer (higher MG base so bot respects quota/revival carrier)
  635,  // dragon
  395,  // shielder
])

export const EG_VALUES = new Int32Array([
  125,  // pawn
  315,  // knight
  385,  // bishop
  595,  // rook
  1120, // queen
  0,    // king
  375,  // necromancer
  585,  // dragon
  385,  // shielder
])

export const PHASE_WEIGHTS = new Int32Array([
  0,  // pawn
  3,  // knight
  3,  // bishop
  5,  // rook
  10, // queen
  0,  // king
  4,  // necromancer
  6,  // dragon
  3,  // shielder
])

// Total starting non-pawn phase weight per side:
// 2N(6) + 2B(6) + 2R(10) + 1Q(10) + 2Nec(8) + 2Drg(12) + 2Shd(6) = 58 per side -> 116 total.
export const MAX_GAME_PHASE = 116

// 144-square MG and EG PSTs for [color][type][sq]
export const PST_MG = new Int32Array(2 * NUM_PIECE_TYPES * NUM_SQUARES)
export const PST_EG = new Int32Array(2 * NUM_PIECE_TYPES * NUM_SQUARES)

const CENTER = (BOARD_SIZE - 1) / 2 // 5.5

function fileDistCenter(file: number): number {
  return Math.abs(file - CENTER) // 0.5 at F/G, 5.5 at A/L
}

function rankDistCenter(rank: number): number {
  return Math.abs(rank - CENTER)
}

function centrality(file: number, rank: number): number {
  // 0 at corners, 10 at central 4 squares (F6, G6, F7, G7)
  return 11 - fileDistCenter(file) - rankDistCenter(rank)
}

function buildTables() {
  for (let rank = 0; rank < BOARD_SIZE; rank++) {
    for (let file = 0; file < BOARD_SIZE; file++) {
      const sqWhite = rank * BOARD_SIZE + file
      const sqBlack = (BOARD_SIZE - 1 - rank) * BOARD_SIZE + file
      const cent = centrality(file, rank) // 0..10
      const fDist = fileDistCenter(file)
      const edgeFile = Math.min(file, BOARD_SIZE - 1 - file) // 0..5
      const edgeRank = Math.min(rank, BOARD_SIZE - 1 - rank) // 0..5
      const centerFileBonus = Math.round((5.5 - fDist) * 2.5) // 0..12

      // PAWN (starts at rank 2, promotes at rank 11)
      let pawnMg = 0
      let pawnEg = 0
      if (rank >= 2 && rank <= 10) {
        const adv = rank - 2 // 0..8
        const fileBias = file >= 4 && file <= 7 ? 10 : file >= 2 && file <= 9 ? 4 : -4
        pawnMg = adv * 4 + fileBias + (rank === 4 || rank === 5 ? 6 : 0)
        pawnEg = adv * 7 + (adv >= 6 ? (adv - 5) * 14 : 0) + (file >= 3 && file <= 8 ? 4 : 0)
      }
      setPst(PT_PAWN, sqWhite, sqBlack, pawnMg, pawnEg)

      // KNIGHT
      const knightEdgePenalty = (edgeFile === 0 ? -18 : edgeFile === 1 ? -6 : 0) + (edgeRank === 0 ? -14 : 0)
      const knightMg = Math.round(cent * 4.5) + knightEdgePenalty + (rank >= 3 && rank <= 8 ? 6 : 0)
      const knightEg = Math.round(cent * 3.5) + knightEdgePenalty
      setPst(PT_KNIGHT, sqWhite, sqBlack, knightMg, knightEg)

      // BISHOP
      const onLongDiag = Math.abs(file - rank) <= 1 || Math.abs(file + rank - 11) <= 1 ? 6 : 0
      const bishopMg = Math.round(cent * 2.8) + onLongDiag + (rank === 0 ? -8 : 0)
      const bishopEg = Math.round(cent * 3.0) + onLongDiag
      setPst(PT_BISHOP, sqWhite, sqBlack, bishopMg, bishopEg)

      // ROOK
      const rookMg = centerFileBonus + (rank === 9 || rank === 10 ? 18 : rank === 1 ? 4 : 0)
      const rookEg = Math.round(cent * 1.4) + (rank >= 8 ? 16 : 0)
      setPst(PT_ROOK, sqWhite, sqBlack, rookMg, rookEg)

      // QUEEN
      const queenMg = Math.round(cent * 2.0) + (rank === 0 ? -4 : rank >= 2 && rank <= 7 ? 5 : 0)
      const queenEg = Math.round(cent * 3.2)
      setPst(PT_QUEEN, sqWhite, sqBlack, queenMg, queenEg)

      // DRAGON: Knight mover + forward 2-rank cone. Best on ranks 4..8 and central files, bad stuck on rank 10..11!
      const dragonRankBonus =
        rank === 0 ? -10 :
        rank <= 2 ? 2 :
        rank <= 4 ? 12 :
        rank <= 7 ? 20 :
        rank === 8 ? 10 :
        rank === 9 ? -6 : -26
      const dragonMg = Math.round(cent * 3.8) + dragonRankBonus + (edgeFile === 0 ? -16 : edgeFile === 1 ? -4 : 0)
      const dragonEg = Math.round(cent * 3.2) + (rank >= 3 && rank <= 8 ? 10 : rank >= 10 ? -22 : 0)
      setPst(PT_DRAGON, sqWhite, sqBlack, dragonMg, dragonEg)

      // SHIELDER: slides orthogonally 1..3, cancels cones, blocks frontal attacks
      const shielderMg = Math.round(cent * 2.5) + (rank >= 1 && rank <= 5 ? 8 : 0) + (file >= 3 && file <= 8 ? 6 : -4)
      const shielderEg = Math.round(cent * 2.6)
      setPst(PT_SHIELDER, sqWhite, sqBlack, shielderMg, shielderEg)

      // NECROMANCER: 1-step king mover; vital to stay sheltered in MG!
      const necroMg =
        rank === 0 ? (file >= 2 && file <= 9 ? 14 : 4) :
        rank === 1 ? (file >= 2 && file <= 9 ? 16 : 6) :
        rank === 2 ? 4 :
        -Math.round(advPenalty(rank) * 8)
      const necroEg = Math.round(cent * 2.2) - (rank >= 9 ? 10 : 0)
      setPst(PT_NECROMANCER, sqWhite, sqBlack, necroMg, necroEg)

      // KING: MG strongly rewards castled wings (C1..E1 or I1..K1) and punishes uncastled center or advancing;
      // EG rewards centralization!
      let kingMg = -rank * 16
      if (rank === 0) {
        if (file === 8 || file === 9 || file === 4 || file === 3) kingMg = 38
        else if (file === 10 || file === 2) kingMg = 24
        else if (file === 6) kingMg = -12
        else if (file === 5 || file === 7) kingMg = -16
        else kingMg = 6
      } else if (rank === 1) {
        if (file >= 8 && file <= 10 || file >= 2 && file <= 4) kingMg = 12
        else kingMg = -24
      }
      const kingEg = Math.round(cent * 6.5) - (edgeFile === 0 || edgeRank === 0 ? 18 : 0)
      setPst(PT_KING, sqWhite, sqBlack, kingMg, kingEg)
    }
  }
}

function advPenalty(rank: number): number {
  return Math.max(0, rank - 2)
}

function setPst(type: number, sqWhite: number, sqBlack: number, mg: number, eg: number) {
  PST_MG[type * NUM_SQUARES + sqWhite] = mg
  PST_MG[(NUM_PIECE_TYPES + type) * NUM_SQUARES + sqBlack] = mg
  PST_EG[type * NUM_SQUARES + sqWhite] = eg
  PST_EG[(NUM_PIECE_TYPES + type) * NUM_SQUARES + sqBlack] = eg
}

buildTables()

export function pstMg(color: number, type: number, sq: number): number {
  return PST_MG[(color * NUM_PIECE_TYPES + type) * NUM_SQUARES + sq]
}

export function pstEg(color: number, type: number, sq: number): number {
  return PST_EG[(color * NUM_PIECE_TYPES + type) * NUM_SQUARES + sq]
}
