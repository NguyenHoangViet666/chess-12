import { describe, expect, it } from "vitest";
import { applyAction, createSession, legalActions, startPosition, undo, updateSession } from "../engine/game";
import { pieceAt, squareName } from "../engine/model";
import type { Action, GameState, MoveAction, ResurrectionAction } from "../engine/model";
import { moveDestinations } from "../engine/movement";
import { isInCheck } from "../engine/rules";
import { position, sq } from "./fixture";

const KINGS = [["white", "king", "A1"], ["black", "king", "L12"]] as const;
const NECRO = ["white", "necromancer", "C1"] as const;

function move(pieceId: string, to: string, promotion?: MoveAction["promotion"]): MoveAction {
  return { kind: "move", pieceId, destination: sq(to), promotion };
}

function resurrect(revivedPieceId: string, necromancerId = "white-C1"): ResurrectionAction {
  return { kind: "resurrect", revivedPieceId, necromancerId };
}

function play(state: GameState, action: Action): GameState {
  const next = applyAction(state, action);
  expect(next, "Expected legal action " + JSON.stringify(action)).not.toBeNull();
  return next!;
}

describe("Necromancer and resurrection", () => {
  it("takes one step in any direction and can capture normally", () => {
    const state = position([...KINGS, ["white", "necromancer", "F6"], ["black", "pawn", "G7"],
      ["white", "pawn", "F7"]]);
    const destinations = moveDestinations(state, state.pieces["white-F6"]).map(squareName).sort();
    expect(destinations).toEqual(["E5", "E6", "E7", "F5", "G5", "G6", "G7"]);
    expect(play(state, move("white-F6", "G7")).graveyard.black).toEqual(["black-G7"]);
  });

  it("revives one allied piece on its exact original square as an atomic turn", () => {
    const state = startPosition(position([...KINGS, NECRO,
      ["white", "pawn", null, "L3"], ["white", "dragon", null, "I1"],
      ["black", "pawn", null, "L10"],
    ]));
    state.halfMoveClock = 27;
    const next = play(state, resurrect("white-L3"));

    expect(next.pieces["white-C1"].currentSquare).toEqual(sq("C1"));
    expect(pieceAt(next, sq("L3"))).toMatchObject({ id: "white-L3", type: "pawn", color: "white", hasMoved: false });
    expect(next.graveyard).toEqual({ white: ["white-I1"], black: ["black-L10"] });
    expect(next.currentPlayer).toBe("black");
    expect(next.halfMoveClock).toBe(0);
    expect(next.moveHistory).toHaveLength(1);
    expect(next.moveHistory[0]).toMatchObject({ action: resurrect("white-L3"), from: sq("C1"), to: sq("L3") });
    expect(next.moveHistory[0].description).toContain("resurrects Pawn at L3");
    expect(next.repetitionHistory).toHaveLength(2);
    expect(applyAction(next, resurrect("white-I1"))).toBeNull();
    expect(applyAction(next, move("white-L3", "L4"))).toBeNull();
    expect(state.graveyard.white).toEqual(["white-L3", "white-I1"]);
    expect(undo(updateSession(createSession(state), next)).game).toEqual(state);

    const nextWhiteTurn = play(next, move("black-L12", "K12"));
    expect(play(nextWhiteTurn, move("white-L3", "L5")).enPassant?.pawnId).toBe("white-L3");
    const dragon = play(nextWhiteTurn, resurrect("white-I1"));
    expect(pieceAt(dragon, sq("I1"))).toMatchObject({ id: "white-I1", type: "dragon" });
  });

  it("rejects occupied spawns, enemy pieces, and a King in the graveyard", () => {
    const state = position([...KINGS, NECRO, ["white", "pawn", null, "E3"],
      ["black", "pawn", null, "F10"], ["white", "king", null, "G1"], ["black", "knight", "E3"],
    ]);
    expect(applyAction(state, resurrect("white-E3"))).toBeNull();
    expect(applyAction(state, resurrect("black-F10"))).toBeNull();
    expect(applyAction(state, resurrect("white-G1"))).toBeNull();
  });

  it("lets either living Necromancer revive the other and fails when both are captured", () => {
    for (const [live, dead] of [["C1", "J1"], ["J1", "C1"]]) {
      const state = position([...KINGS, ["white", "necromancer", live], ["white", "necromancer", null, dead]]);
      const next = play(state, resurrect("white-" + dead, "white-" + live));
      expect(pieceAt(next, sq(dead))).toMatchObject({ id: "white-" + dead, type: "necromancer" });
      expect(next.graveyard.white).toEqual([]);
    }
    const state = position([...KINGS, ["white", "necromancer", null, "C1"],
      ["white", "necromancer", null, "J1"], ["white", "pawn", null, "E3"], ["white", "bishop", "D1"],
    ]);
    expect(legalActions(state).some((action) => action.kind === "resurrect")).toBe(false);
    expect(applyAction(state, resurrect("white-J1"))).toBeNull();
  });

  it("permits successive recapture and revival cycles of the same identity", () => {
    let state = startPosition(position([...KINGS, NECRO, ["white", "pawn", null, "E3"], ["black", "rook", "E8"]]));
    for (const destination of ["C2", "C1", "C2"]) {
      state = play(state, resurrect("white-E3"));
      expect(pieceAt(state, sq("E3"))?.id).toBe("white-E3");
      state = play(state, move("black-E8", "E3"));
      expect(state.graveyard.white).toEqual(["white-E3"]);
      state = play(state, move("white-C1", destination));
      state = play(state, move("black-E8", "E8"));
    }
    expect(state.moveHistory.filter((turn) => turn.action.kind === "resurrect")).toHaveLength(3);
  });

  it("restores a captured promoted unit to a Pawn that has already moved", () => {
    const state = position([...KINGS, NECRO, ["white", "pawn", "F11", "F3", { hasMoved: true }],
      ["black", "rook", "G12"],
    ]);
    const promotion = play(state, move("white-F3", "F12", "bishop"));
    const capture = play(promotion, move("black-G12", "F12"));
    expect(capture.pieces["white-F3"]).toMatchObject({ type: "bishop", promoted: true, currentSquare: null });
    const revived = play(capture, resurrect("white-F3"));
    expect(pieceAt(revived, sq("F3"))).toMatchObject({
      id: "white-F3", baseType: "pawn", type: "pawn", promoted: false, hasMoved: true,
    });
    expect(moveDestinations(revived, revived.pieces["white-F3"]).map(squareName)).toEqual(["F4"]);
  });

  it("keeps an original Rook's lost castling right after capture and resurrection", () => {
    const state = position([
      ["white", "king", "G1"], ["black", "king", "L12"], NECRO,
      ["white", "rook", "A1"], ["black", "rook", "A4"],
    ], "black");
    state.castlingRights.white.queenSide = true;
    const captured = play(state, move("black-A4", "A1"));
    expect(captured.castlingRights.white.queenSide).toBe(false);
    const answered = play(captured, move("white-C1", "D1"));
    const vacated = play(answered, move("black-A4", "A4"));
    const revived = play(vacated, resurrect("white-A1"));
    expect(pieceAt(revived, sq("A1"))?.id).toBe("white-A1");
    expect(revived.castlingRights.white.queenSide).toBe(false);
    const nextWhiteTurn = play(revived, move("black-L12", "K12"));
    const clearPath = play(nextWhiteTurn, move("white-C1", "D2"));
    const whiteAgain = play(clearPath, move("black-L12", "L12"));
    expect(applyAction(whiteAgain, { kind: "castle", side: "queenSide" })).toBeNull();
  });

  it("only allows a resurrection under check if the returned piece resolves it", () => {
    const state = startPosition(position([
      ["white", "king", "G1"], ["black", "king", "L12"], ["black", "rook", "A1"],
      ["white", "necromancer", "C2"], ["white", "pawn", null, "L3"], ["white", "bishop", null, "D1"],
    ]));
    expect(isInCheck(state, "white")).toBe(true);
    expect(applyAction(state, resurrect("white-L3", "white-C2"))).toBeNull();
    const rescued = play(state, resurrect("white-D1", "white-C2"));
    expect(pieceAt(rescued, sq("D1"))?.type).toBe("bishop");
    expect(isInCheck(rescued, "white")).toBe(false);
  });

  it("can resurrect a Shielder into the same file to intercept a checking Dragon", () => {
    const state = startPosition(position([
      ["white", "king", "E5"], ["black", "king", "L12"], NECRO,
      ["white", "shielder", null, "E6"], ["black", "dragon", "E7"],
    ]));
    expect(isInCheck(state, "white")).toBe(true);
    expect(isInCheck(play(state, resurrect("white-E6")), "white")).toBe(false);
  });
});
