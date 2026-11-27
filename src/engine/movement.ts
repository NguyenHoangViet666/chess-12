import {
  BOARD_SIZE, forward, inBounds, pieceAt, sameSquare, squareAt,
} from "./model";
import type { GameState, Piece, Square } from "./model";

type Offset = readonly [file: number, rank: number];

const ORTHOGONAL: readonly Offset[] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const DIAGONAL: readonly Offset[] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const ADJACENT = [...ORTHOGONAL, ...DIAGONAL];
const KNIGHT: readonly Offset[] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

function shifted(origin: Square, [file, rank]: Offset, distance = 1): Square {
  return squareAt(origin.file + file * distance, origin.rank + rank * distance);
}

function isFrontalAttack(attacker: Piece, target: Piece): boolean {
  const from = attacker.currentSquare;
  const to = target.currentSquare;
  return (
    target.type === "shielder" &&
    from !== null &&
    to !== null &&
    from.file === to.file &&
    (from.rank - to.rank) * forward(target.color) > 0
  );
}

export function canCaptureDirect(attacker: Piece, target: Piece): boolean {
  return (
    attacker.color !== target.color &&
    target.type !== "king" &&
    !isFrontalAttack(attacker, target)
  );
}

export function enPassantVictim(state: GameState, pawn: Piece, target: Square): Piece | undefined {
  const from = pawn.currentSquare;
  const opportunity = state.enPassant;
  if (
    pawn.type !== "pawn" ||
    from === null ||
    !opportunity ||
    !sameSquare(target, opportunity.target) ||
    pieceAt(state, target) ||
    Math.abs(target.file - from.file) !== 1 ||
    target.rank - from.rank !== forward(pawn.color)
  ) {
    return undefined;
  }

  const adjacent = pieceAt(state, squareAt(target.file, from.rank));
  return adjacent?.id === opportunity.pawnId && adjacent.type === "pawn" && adjacent.color !== pawn.color
    ? adjacent
    : undefined;
}

function pawnDestinations(state: GameState, pawn: Piece, origin: Square): Square[] {
  const direction = forward(pawn.color);
  const result: Square[] = [];
  const oneStep = shifted(origin, [0, direction]);
  if (inBounds(oneStep) && !pieceAt(state, oneStep)) {
    result.push(oneStep);
    const twoSteps = shifted(origin, [0, direction], 2);
    if (!pawn.hasMoved && sameSquare(origin, pawn.spawnSquare) && inBounds(twoSteps) && !pieceAt(state, twoSteps)) {
      result.push(twoSteps);
    }
  }

  for (const file of [-1, 1]) {
    const destination = shifted(origin, [file, direction]);
    if (!inBounds(destination)) continue;
    const target = pieceAt(state, destination);
    if (target ? canCaptureDirect(pawn, target) : enPassantVictim(state, pawn, destination)) {
      result.push(destination);
    }
  }
  return result;
}

function* piecePaths(piece: Piece, origin: Square): Generator<Generator<Square>> {
  let offsets: readonly Offset[];
  let range: number;

  switch (piece.type) {
    case "king":
    case "necromancer":
      offsets = ADJACENT;
      range = 1;
      break;
    case "knight":
    case "dragon":
      offsets = KNIGHT;
      range = 1;
      break;
    case "queen":
      offsets = ADJACENT;
      range = BOARD_SIZE - 1;
      break;
    case "rook":
      offsets = ORTHOGONAL;
      range = BOARD_SIZE - 1;
      break;
    case "bishop":
      offsets = DIAGONAL;
      range = BOARD_SIZE - 1;
      break;
    case "shielder":
      offsets = ORTHOGONAL;
      range = 3;
      break;
    case "pawn":
      return;
  }

  for (const offset of offsets) {
    yield path(origin, offset, range);
  }
}

function* path(origin: Square, offset: Offset, range: number): Generator<Square> {
  for (let distance = 1; distance <= range; distance += 1) {
    const square = shifted(origin, offset, distance);
    if (!inBounds(square)) return;
    yield square;
  }
}

export function moveDestinations(state: GameState, piece: Piece): Square[] {
  const origin = piece.currentSquare;
  if (!origin) return [];
  if (piece.type === "pawn") return pawnDestinations(state, piece, origin);

  const result: Square[] = [];
  for (const ray of piecePaths(piece, origin)) {
    for (const square of ray) {
      const target = pieceAt(state, square);
      if (!target || canCaptureDirect(piece, target)) result.push(square);
      if (target) break;
    }
  }
  return result;
}

export function attacksSquare(state: GameState, piece: Piece, square: Square): boolean {
  const origin = piece.currentSquare;
  if (!origin || !inBounds(square) || sameSquare(origin, square)) return false;

  const fileDelta = square.file - origin.file;
  const rankDelta = square.rank - origin.rank;
  const files = Math.abs(fileDelta);
  const ranks = Math.abs(rankDelta);
  const distance = Math.max(files, ranks);
  if (piece.type === "pawn") return files === 1 && rankDelta === forward(piece.color);
  if (piece.type === "knight" || piece.type === "dragon") return files * ranks === 2;

  // Pinned pieces still attack squares for King movement and castling.
  const straight = files === 0 || ranks === 0;
  const diagonal = files === ranks;
  switch (piece.type) {
    case "king":
    case "necromancer":
      if (distance !== 1) return false;
      break;
    case "rook":
      if (!straight) return false;
      break;
    case "shielder":
      if (!straight || distance > 3) return false;
      break;
    case "bishop":
      if (!diagonal) return false;
      break;
    case "queen":
      if (!straight && !diagonal) return false;
      break;
  }

  if (files === 0) {
    const target = pieceAt(state, square);
    if (target && target.color !== piece.color && isFrontalAttack(piece, target)) return false;
  }
  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);
  for (let step = 1; step < distance; step += 1) {
    if (state.board[origin.rank + rankStep * step][origin.file + fileStep * step] !== null) return false;
  }
  return true;
}
