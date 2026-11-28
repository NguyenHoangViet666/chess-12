export const BOARD_SIZE = 12;
export const FILES = "ABCDEFGHIJKL";
export const COLORS = ["white", "black"] as const;
export const PROMOTION_TYPES = ["queen", "rook", "bishop", "knight"] as const;

export type Color = (typeof COLORS)[number];
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export type PieceType =
  | PromotionType
  | "king"
  | "pawn"
  | "necromancer"
  | "dragon"
  | "shielder";

export interface Square {
  file: number;
  rank: number;
}

export const RULESET_VERSION = '0.4';
export const RESURRECTION_LIMIT = {
  queen: 1, rook: 1, bishop: 1, knight: 1, necromancer: 1, dragon: 1, shielder: 1, pawn: 3,
} as const satisfies Record<Exclude<PieceType, "king">, number>;
export type ResurrectableType = keyof typeof RESURRECTION_LIMIT;
export const RESURRECTION_TYPES = Object.keys(RESURRECTION_LIMIT) as ResurrectableType[];
export type ResurrectionQuota = Record<ResurrectableType, number>;

export interface FireEffect {
  id: string;
  owner: Color;
  square: Square;
  createdAtTurn: number;
  expiresAfterTurn: number;
}

export interface FireState {
  effects: FireEffect[];
  /** Index of the next complete action. */
  currentTurnIndex: number;
}

export interface FireCapture {
  pieceId: string;
  owner: Color;
  square: Square;
}

export interface TurnFire {
  created: FireEffect[];
  expired: FireEffect[];
  captures: FireCapture[];
  canceledBy: string[];
}


export interface Piece {
  id: string;
  color: Color;
  baseType: PieceType;
  type: PieceType;
  spawnSquare: Square;
  currentSquare: Square | null;
  hasMoved: boolean;
  promoted: boolean;
}

export type CastleSide = "kingSide" | "queenSide";
export type DragonFireTiming = "none" | "before" | "after";

export interface MoveAction {
  kind: "move";
  pieceId: string;
  destination: Square;
  promotion?: PromotionType;
}

export interface DragonAction {
  kind: "dragon";
  pieceId: string;
  destination: Square;
  fireTiming: DragonFireTiming;
}

export interface CastleAction {
  kind: "castle";
  side: CastleSide;
}

export interface ResurrectionAction {
  kind: "resurrect";
  necromancerId: string;
  revivedPieceId: string;
}

export type Action = MoveAction | DragonAction | CastleAction | ResurrectionAction;
export type ClaimableDrawReason = "threefold" | "fifty-move";
export type DrawReason =
  | ClaimableDrawReason
  | "stalemate"
  | "bare-kings"
  | "fivefold"
  | "seventy-five-move"
  | "agreement";

export type GameStatus =
  | { kind: "active"; inCheck: boolean; claimable: ClaimableDrawReason[] }
  | { kind: "checkmate"; winner: Color }
  | { kind: "draw"; reason: DrawReason };

export interface TurnRecord {
  action: Action;
  color: Color;
  fullMoveNumber: number;
  pieceType: PieceType;
  from: Square | null;
  to: Square;
  capturedIds: string[];
  fire: TurnFire;
  description: string;
}

export interface GameState {
  board: (string | null)[][];
  pieces: Record<string, Piece>;
  graveyard: Record<Color, string[]>;
  currentPlayer: Color;
  resurrectionState: Record<Color, ResurrectionQuota>;
  fireState: FireState;
  castlingRights: Record<Color, Record<CastleSide, boolean>>;
  enPassant: { target: Square; pawnId: string } | null;
  halfMoveClock: number;
  fullMoveNumber: number;
  moveHistory: TurnRecord[];
  repetitionHistory: string[];
  status: GameStatus;
}

const BACK_RANK: readonly PieceType[] = [
  "rook", "knight", "necromancer", "dragon", "bishop", "queen",
  "king", "bishop", "dragon", "necromancer", "knight", "rook",
];

export function squareAt(file: number, rank: number): Square {
  return { file, rank };
}

export function inBounds({ file, rank }: Square): boolean {
  return (
    Number.isInteger(file) &&
    Number.isInteger(rank) &&
    file >= 0 &&
    file < BOARD_SIZE &&
    rank >= 0 &&
    rank < BOARD_SIZE
  );
}

export function sameSquare(a: Square | null | undefined, b: Square | null | undefined): boolean {
  return a != null && b != null && a.file === b.file && a.rank === b.rank;
}

export function squareName(square: Square): string {
  return `${FILES[square.file]}${square.rank + 1}`;
}

export function parseSquare(name: string): Square | null {
  const match = /^([A-L])(1[0-2]|[1-9])$/i.exec(name.trim());
  return match ? squareAt(FILES.indexOf(match[1].toUpperCase()), Number(match[2]) - 1) : null;
}

export function opposite(color: Color): Color {
  return color === "white" ? "black" : "white";
}

export function forward(color: Color): 1 | -1 {
  return color === "white" ? 1 : -1;
}

export function pieceAt(state: Pick<GameState, "board" | "pieces">, square: Square): Piece | undefined {
  if (!inBounds(square)) return undefined;
  const id = state.board[square.rank][square.file];
  return id === null ? undefined : state.pieces[id];
}

export function remainingResurrections(state: GameState, color: Color, type: PieceType): number {
  return type === "king" ? 0 : RESURRECTION_LIMIT[type] - state.resurrectionState[color][type];
}

function unusedQuotas(): ResurrectionQuota {
  return { queen: 0, rook: 0, bishop: 0, knight: 0, necromancer: 0, dragon: 0, shielder: 0, pawn: 0 };
}


export function createPosition(): GameState {
  const board = Array.from({ length: BOARD_SIZE }, () => Array<string | null>(BOARD_SIZE).fill(null));
  const pieces: Record<string, Piece> = {};

  function place(color: Color, type: PieceType, file: number, rank: number) {
    const spawnSquare = squareAt(file, rank);
    const id = `${color}-${squareName(spawnSquare)}`;
    board[rank][file] = id;
    pieces[id] = {
      id,
      color,
      baseType: type,
      type,
      spawnSquare,
      currentSquare: squareAt(file, rank),
      hasMoved: false,
      promoted: false,
    };
  }

  for (const color of COLORS) {
    const homeRank = color === "white" ? 0 : BOARD_SIZE - 1;
    const direction = forward(color);
    for (let file = 0; file < BOARD_SIZE; file += 1) {
      place(color, BACK_RANK[file], file, homeRank);
      place(color, "pawn", file, homeRank + 2 * direction);
    }
    place(color, "shielder", 5, homeRank + direction);
    place(color, "shielder", 6, homeRank + direction);
  }

  return {
    board,
    pieces,
    graveyard: { white: [], black: [] },
    currentPlayer: "white",
    resurrectionState: { white: unusedQuotas(), black: unusedQuotas() },
    fireState: { effects: [], currentTurnIndex: 0 },
    castlingRights: {
      white: { kingSide: true, queenSide: true },
      black: { kingSide: true, queenSide: true },
    },
    enPassant: null,
    halfMoveClock: 0,
    fullMoveNumber: 1,
    moveHistory: [],
    repetitionHistory: [],
    status: { kind: "active", inCheck: false, claimable: [] },
  };
}
