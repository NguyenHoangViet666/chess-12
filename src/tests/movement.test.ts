import { describe, expect, it } from "vitest";
import { applyAction, createGame, legalActions, startPosition } from "../engine/game";
import { attacksSquare, moveDestinations } from "../engine/movement";
import { COLORS, RESURRECTION_TYPES, forward, pieceAt, remainingResurrections, squareName } from "../engine/model";
import type { Action, GameState, MoveAction } from "../engine/model";
import { isInCheck } from "../engine/rules";
import { position, sq } from "./fixture";
import type { Entry } from "./fixture";

const KINGS = [["white", "king", "A1"], ["black", "king", "L12"]] as const;

function movement(pieceId: string, to: string, promotion?: MoveAction["promotion"]): MoveAction {
  return { kind: "move", pieceId, destination: sq(to), promotion };
}

function play(state: GameState, action: Action): GameState {
  const next = applyAction(state, action);
  expect(next, "Expected legal action " + JSON.stringify(action)).not.toBeNull();
  return next!;
}

function names(state: GameState, id: string): string[] {
  return moveDestinations(state, state.pieces[id]).map(squareName);
}

describe("initial 12×12 formation", () => {
  it("places all 52 pieces at the required coordinates and tracks their original identities", () => {
    const state = createGame();
    expect(state.board).toHaveLength(12);
    for (const rank of state.board) expect(rank).toHaveLength(12);
    expect(state.board.flat().filter(Boolean)).toHaveLength(52);

    const expected = ["rook", "knight", "necromancer", "dragon", "bishop", "queen",
      "king", "bishop", "dragon", "necromancer", "knight", "rook"];
    for (const color of COLORS) {
      const white = color === "white";
      const back = white ? 1 : 12;
      const pawn = white ? 3 : 10;
      const shield = white ? 2 : 11;
      expect(forward(color)).toBe(white ? 1 : -1);
      expect(Object.values(state.pieces).filter((piece) => piece.color === color)).toHaveLength(26);
      for (const [file, type] of expected.entries()) {
        const name = String.fromCharCode(65 + file);
        expect(pieceAt(state, sq(name + back))).toMatchObject({ type, color, hasMoved: false });
        expect(pieceAt(state, sq(name + pawn))).toMatchObject({ type: "pawn", color });
      }
      expect(pieceAt(state, sq("F" + shield))).toMatchObject({ type: "shielder", color });
      expect(pieceAt(state, sq("G" + shield))).toMatchObject({ type: "shielder", color });
      expect(state.castlingRights[color]).toEqual({ kingSide: true, queenSide: true });
      expect(state.graveyard[color]).toEqual([]);
      for (const type of RESURRECTION_TYPES) {
        expect(state.resurrectionState[color][type]).toBe(0);
        expect(remainingResurrections(state, color, type)).toBe(type === "pawn" ? 3 : 1);
      }
      expect(remainingResurrections(state, color, "king")).toBe(0);
    }
    for (const piece of Object.values(state.pieces)) {
      expect(piece.currentSquare).toEqual(piece.spawnSquare);
      expect(piece.id).toBe(piece.color + "-" + squareName(piece.spawnSquare));
    }

    expect(state.currentPlayer).toBe("white");
    expect(state.repetitionHistory).toHaveLength(1);
    expect(state.enPassant).toBeNull();
    expect(state.fireState.effects).toEqual([]);
    expect(state.status).toEqual({ kind: "active", inCheck: false, claimable: [] });
    expect(names(state, "white-A3")).toEqual(["A4", "A5"]);
    expect(names(state, "black-A10")).toEqual(["A9", "A8"]);
  });
});

describe("traditional moves", () => {
  it("handles long rook rays, friendly obstructions, and enemy capture", () => {
    const state = position([...KINGS, ["white", "rook", "A6"], ["white", "pawn", "A8"], ["black", "bishop", "E6"]]);
    expect(names(state, "white-A6")).toEqual(["A7", "B6", "C6", "D6", "E6", "A5", "A4", "A3", "A2"]);
    const next = play(state, movement("white-A6", "E6"));
    expect(pieceAt(next, sq("E6"))?.id).toBe("white-A6");
    expect(next.graveyard.black).toEqual(["black-E6"]);
    expect(next.pieces["black-E6"].currentSquare).toBeNull();
    expect(pieceAt(state, sq("E6"))?.id).toBe("black-E6");
    expect(state.graveyard.black).toEqual([]);
  });

  it("lets bishops and queens slide on the correct axes across the larger board", () => {
    const bishop = position([...KINGS, ["white", "bishop", "A2"], ["black", "knight", "G8"]]);
    expect(names(bishop, "white-A2")).toEqual(["B3", "C4", "D5", "E6", "F7", "G8", "B1"]);
    const queen = position([...KINGS, ["white", "queen", "L1"]]);
    const moves = names(queen, "white-L1");
    expect(moves).toContain("A12");
    expect(moves).toContain("L11");
    expect(moves).toContain("B1");
    expect(moves).not.toContain("L12");
    expect(moves).not.toContain("A1");
    expect(moves).not.toContain("K3");
  });

  it("lets knights jump and clips their destinations at edges", () => {
    const knight = position([...KINGS, ["white", "knight", "A12"], ["white", "pawn", "A11"],
      ["white", "pawn", "B12"], ["black", "bishop", "B10"]]);
    expect(names(knight, "white-A12").sort()).toEqual(["B10", "C11"]);
    expect(play(knight, movement("white-A12", "B10")).graveyard.black).toEqual(["black-B10"]);
  });

  it("restricts Kings to one square and never offers a King capture", () => {
    const state = position([...KINGS, ["white", "rook", "L1"]]);
    expect(names(state, "white-A1").sort()).toEqual(["A2", "B1", "B2"]);
    expect(names(state, "white-L1")).not.toContain("L12");
    expect(applyAction(state, movement("white-L1", "L12"))).toBeNull();
    expect(attacksSquare(state, state.pieces["white-L1"], sq("L12"))).toBe(true);

    const neighboringKings = position([["white", "king", "A1"], ["black", "king", "C2"], ["black", "pawn", "L10"]]);
    expect(applyAction(neighboringKings, movement("white-A1", "B1"))).toBeNull();
  });

  it("rejects exposing a pinned piece's King while keeping its geometric attack", () => {
    const state = startPosition(position([
      ["white", "king", "E1"], ["black", "king", "L12"],
      ["white", "rook", "E2"], ["black", "rook", "E12"],
    ]));
    const pinned = state.pieces["white-E2"];
    expect(attacksSquare(state, pinned, sq("D2"))).toBe(true);
    expect(applyAction(state, movement(pinned.id, "D2"))).toBeNull();
    expect(play(state, movement(pinned.id, "E3")).pieces[pinned.id].currentSquare).toEqual(sq("E3"));
  });

  it("detects sliding and jumping checks and rejects an unrelated response", () => {
    const slider = startPosition(position([
      ...KINGS, ["black", "rook", "A8"], ["white", "pawn", "D3"],
    ]));
    expect(slider.status).toMatchObject({ kind: "active", inCheck: true });
    expect(applyAction(slider, movement("white-D3", "D4"))).toBeNull();
    const jumper = startPosition(position([
      ...KINGS, ["black", "knight", "B3"], ["white", "pawn", "B2"],
    ]));
    expect(isInCheck(jumper, "white")).toBe(true);
    expect(legalActions(jumper).length).toBeGreaterThan(0);
  });
});

describe("pawn movement, en passant, and promotion", () => {
  it("blocks forward movement and allows only forward diagonal captures", () => {
    const state = position([...KINGS, ["white", "pawn", "F3"], ["black", "rook", "F4"],
      ["black", "bishop", "E4"], ["white", "knight", "G4"], ["black", "pawn", "E2"]]);
    expect(names(state, "white-F3")).toEqual(["E4"]);
    expect(applyAction(state, movement("white-F3", "F5"))).toBeNull();
    expect(attacksSquare(state, state.pieces["white-F3"], sq("F4"))).toBe(false);
    expect(attacksSquare(state, state.pieces["white-F3"], sq("G4"))).toBe(true);
  });

  it("supports both en passant directions and removes the actual Pawn", () => {
    const whiteStart = position([...KINGS, ["white", "pawn", "D3"], ["black", "pawn", "E5", "E10", { hasMoved: true }]]);
    const whiteDouble = play(whiteStart, movement("white-D3", "D5"));
    expect(whiteDouble.enPassant).toEqual({ target: sq("D4"), pawnId: "white-D3" });
    const blackCapture = play(whiteDouble, movement("black-E10", "D4"));
    expect(blackCapture.graveyard.white).toEqual(["white-D3"]);
    expect(pieceAt(blackCapture, sq("D5"))).toBeUndefined();
    expect(pieceAt(blackCapture, sq("D4"))?.id).toBe("black-E10");
    expect(blackCapture.halfMoveClock).toBe(0);
    expect(blackCapture.enPassant).toBeNull();

    const blackStart = position([...KINGS, ["black", "pawn", "E10"], ["white", "pawn", "F8", "F3", { hasMoved: true }]], "black");
    const blackDouble = play(blackStart, movement("black-E10", "E8"));
    const whiteCapture = play(blackDouble, movement("white-F3", "E9"));
    expect(whiteCapture.graveyard.black).toEqual(["black-E10"]);
    expect(pieceAt(whiteCapture, sq("E8"))).toBeUndefined();
    expect(pieceAt(whiteCapture, sq("E9"))?.id).toBe("white-F3");
  });

  it("expires en passant after a different action and rejects one that exposes check", () => {
    const state = position([...KINGS, ["white", "pawn", "D3"], ["black", "pawn", "E5", "E10", { hasMoved: true }]]);
    const afterDouble = play(state, movement("white-D3", "D5"));
    const afterBlackKing = play(afterDouble, movement("black-L12", "K12"));
    const afterWhiteKing = play(afterBlackKing, movement("white-A1", "B1"));
    expect(afterBlackKing.enPassant).toBeNull();
    expect(applyAction(afterWhiteKing, movement("black-E10", "D4"))).toBeNull();

    const pinned = position([
      ["white", "king", "A8"], ["black", "king", "L12"], ["black", "rook", "L8"],
      ["white", "pawn", "F8", "F3", { hasMoved: true }], ["black", "pawn", "E10"],
    ], "black");
    const afterBlackDouble = play(pinned, movement("black-E10", "E8"));
    expect(isInCheck(afterBlackDouble, "white")).toBe(false);
    expect(names(afterBlackDouble, "white-F3")).toContain("E9");
    expect(applyAction(afterBlackDouble, movement("white-F3", "E9"))).toBeNull();
  });

  it("requires one of four immediate promotion choices and keeps the Pawn identity", () => {
    const state = position([...KINGS, ["white", "pawn", "F11", "F3", { hasMoved: true }], ["black", "rook", "G12"]]);
    const options = legalActions(state).filter((action) => action.kind === "move" &&
      action.pieceId === "white-F3" && squareName(action.destination) === "G12");
    expect(options.map((action) => action.kind === "move" && action.promotion).sort()).toEqual(["bishop", "knight", "queen", "rook"]);
    expect(applyAction(state, movement("white-F3", "G12"))).toBeNull();
    const forbidden = { ...movement("white-F3", "G12"), promotion: "dragon" } as unknown as Action;
    expect(applyAction(state, forbidden)).toBeNull();
    const promoted = play(state, movement("white-F3", "G12", "knight"));
    expect(pieceAt(promoted, sq("G12"))).toMatchObject({
      id: "white-F3", baseType: "pawn", type: "knight", promoted: true, spawnSquare: sq("F3"),
    });
    expect(promoted.graveyard.black).toEqual(["black-G12"]);

    const blackState = position([...KINGS, ["black", "pawn", "F2", "F10", { hasMoved: true }]], "black");
    const blackPromotion = play(blackState, movement("black-F10", "F1", "bishop"));
    expect(pieceAt(blackPromotion, sq("F1"))).toMatchObject({ type: "bishop", baseType: "pawn" });
  });
});

describe("castling", () => {
  const roster = [
    ["white", "king", "G1"], ["white", "rook", "A1"], ["white", "rook", "L1"],
    ["black", "king", "G12"], ["black", "rook", "A12"], ["black", "rook", "L12"],
  ] as const;

  function ready(extras: readonly Entry[] = [], turn: "white" | "black" = "white") {
    const state = position([...roster, ...extras], turn);
    for (const color of COLORS) state.castlingRights[color] = { kingSide: true, queenSide: true };
    return state;
  }

  it("uses the exact 12×12 destinations for both castling sides", () => {
    for (const color of COLORS) {
      const rank = color === "white" ? 1 : 12;
      for (const [side, kingFile, rookFile, startFile] of [
        ["kingSide", "I", "H", "L"], ["queenSide", "E", "F", "A"],
      ] as const) {
        const next = play(ready([], color), { kind: "castle", side });
        expect(pieceAt(next, sq(kingFile + rank))?.id).toBe(color + "-G" + rank);
        expect(pieceAt(next, sq(rookFile + rank))?.id).toBe(color + "-" + startFile + rank);
        expect(next.castlingRights[color]).toEqual({ kingSide: false, queenSide: false });
        expect(next.moveHistory).toHaveLength(1);
        expect(next.moveHistory[0].action.kind).toBe("castle");
      }
    }
  });

  it("requires all intervening squares to be empty", () => {
    const state = ready([["white", "knight", "B1"], ["white", "pawn", "K1"]]);
    expect(applyAction(state, { kind: "castle", side: "queenSide" })).toBeNull();
    expect(applyAction(state, { kind: "castle", side: "kingSide" })).toBeNull();
  });

  it("cannot start in check, cross check, or finish in check", () => {
    for (const attacker of ["G5", "H5", "I5"]) {
      const state = ready([["black", "rook", attacker]]);
      expect(applyAction(state, { kind: "castle", side: "kingSide" })).toBeNull();
    }
  });

  it("allows an inactive cone but forbids castling through a zone that is burning at the start of the turn", () => {
    const inactive = ready([["black", "dragon", "H2"]]);
    expect(isInCheck(inactive, "white")).toBe(false);
    expect(attacksSquare(inactive, inactive.pieces["black-H2"], sq("H1"))).toBe(false);
    expect(applyAction(inactive, { kind: "castle", side: "kingSide" })).not.toBeNull();

    const burning = play({ ...inactive, currentPlayer: "black" }, {
      kind: "dragon", pieceId: "black-H2", destination: sq("I4"), fireTiming: "before",
    });
    expect(burning.fireState.effects.map((effect) => squareName(effect.square))).toEqual(["H1"]);
    expect(isInCheck(burning, "white")).toBe(false);
    expect(applyAction(burning, { kind: "castle", side: "kingSide" })).toBeNull();

    const normalKingMove = play(burning, movement("white-G1", "H1"));
    expect(pieceAt(normalKingMove, sq("H1"))?.id).toBe("white-G1");
    expect(normalKingMove.fireState.effects).toHaveLength(0);
  });

  it("forbids castling when the King starts on or would land on active hostile fire", () => {
    for (const [square, startsInCheck] of [["G1", true], ["I1", false]] as const) {
      const state = ready();
      state.fireState = {
        currentTurnIndex: 5,
        effects: [{ id: "test-burning-" + square, owner: "black", square: sq(square), createdAtTurn: 4, expiresAfterTurn: 5 }],
      };
      expect(isInCheck(state, "white")).toBe(startsInCheck);
      expect(applyAction(state, { kind: "castle", side: "kingSide" })).toBeNull();
    }
  });

  it("permanently loses rights when a Rook moves or the King moves", () => {
    const rookMoves = play(ready(), movement("white-A1", "A2"));
    expect(rookMoves.castlingRights.white).toEqual({ kingSide: true, queenSide: false });
    const kingMoves = play(ready(), movement("white-G1", "F1"));
    expect(kingMoves.castlingRights.white).toEqual({ kingSide: false, queenSide: false });
  });
});
