import {
  createPosition, parseSquare, pieceAt, squareName,
} from "../engine/model";
import type {
  Color, GameState, PieceType, Square,
} from "../engine/model";

export type Entry = readonly [
  color: Color,
  baseType: PieceType,
  currentName: string | null,
  spawnName?: string,
  options?: { type?: PieceType; hasMoved?: boolean; promoted?: boolean },
];

export function sq(name: string): Square {
  const square = parseSquare(name);
  if (square === null) throw new Error("Invalid test square " + name);
  return square;
}

export function position(entries: readonly Entry[], turn: Color = "white"): GameState {
  const state = createPosition();
  state.currentPlayer = turn;
  state.board.forEach((rank) => rank.fill(null));
  state.pieces = {};
  state.castlingRights.white = { kingSide: false, queenSide: false };
  state.castlingRights.black = { kingSide: false, queenSide: false };

  for (const [color, baseType, currentName, spawnName = currentName, options] of entries) {
    if (spawnName === null) throw new Error("Captured test pieces need a spawn square");
    const spawnSquare = sq(spawnName);
    const currentSquare = currentName === null ? null : sq(currentName);
    const id = color + "-" + squareName(spawnSquare);
    if (state.pieces[id]) throw new Error("Duplicate test piece " + id);
    if (currentSquare && pieceAt(state, currentSquare)) {
      throw new Error("Overlapping test piece at " + currentName);
    }

    state.pieces[id] = {
      id, color, baseType, spawnSquare, currentSquare,
      type: options?.type ?? baseType,
      hasMoved: options?.hasMoved ?? false,
      promoted: options?.promoted ?? false,
    };
    if (currentSquare) state.board[currentSquare.rank][currentSquare.file] = id;
    else state.graveyard[color].push(id);
  }

  return state;
}
