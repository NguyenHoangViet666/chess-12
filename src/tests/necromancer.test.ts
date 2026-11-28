import { describe, expect, it } from "vitest";
import { applyAction, createSession, legalActions, startPosition, undo, updateSession } from "../engine/game";
import { pieceAt, remainingResurrections, squareName } from "../engine/model";
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
    expect(remainingResurrections(next, "white", "pawn")).toBe(2);
    const undone = undo(updateSession(createSession(state), next)).game;
    expect(undone).toEqual(state);
    expect(remainingResurrections(undone, "white", "pawn")).toBe(3);

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
    expect(remainingResurrections(state, "white", "pawn")).toBe(3);
    expect(state.moveHistory).toHaveLength(0);
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

  it("permits three revivals across recaptures but refuses the fourth even for another Pawn", () => {
    let state = startPosition(position([...KINGS, NECRO, ["white", "pawn", null, "E3"],
      ["white", "pawn", null, "F3"], ["black", "rook", "E8"],
    ]));
    for (const [used, destination] of ["C2", "C1", "C2"].entries()) {
      state = play(state, resurrect("white-E3"));
      expect(pieceAt(state, sq("E3"))?.id).toBe("white-E3");
      expect(remainingResurrections(state, "white", "pawn")).toBe(2 - used);
      state = play(state, move("black-E8", "E3"));
      state = play(state, move("white-C1", destination));
      state = play(state, move("black-E8", "E8"));
    }
    expect(state.graveyard.white).toEqual(["white-F3", "white-E3"]);
    expect(applyAction(state, resurrect("white-E3"))).toBeNull();
    expect(applyAction(state, resurrect("white-F3"))).toBeNull();
    expect(state.moveHistory.filter((turn) => turn.action.kind === "resurrect")).toHaveLength(3);
    expect(remainingResurrections(state, "black", "pawn")).toBe(3);
  });

  it("shares a one-use quota across identities and actors, but not across players", () => {
    const start = position([...KINGS, NECRO, ["white", "necromancer", "J1"], ["black", "necromancer", "J12"],
      ["white", "queen", null, "F1"], ["black", "queen", null, "F12"],
      ["white", "dragon", null, "D1"], ["white", "dragon", null, "I1"], ["black", "rook", "F5"],
    ]);
    const whiteQueen = play(start, resurrect("white-F1"));
    expect(remainingResurrections(whiteQueen, "white", "queen")).toBe(0);
    expect(remainingResurrections(whiteQueen, "black", "queen")).toBe(1);
    const blackQueen = play(whiteQueen, resurrect("black-F12", "black-J12"));
    expect(remainingResurrections(blackQueen, "black", "queen")).toBe(0);
    const firstDragon = play(blackQueen, resurrect("white-D1"));
    expect(remainingResurrections(firstDragon, "white", "dragon")).toBe(0);
    const recaptured = play(firstDragon, move("black-F5", "F1"));
    expect(applyAction(recaptured, resurrect("white-I1", "white-J1"))).toBeNull();
    const waited = play(recaptured, move("white-C1", "C2"));
    const vacated = play(waited, move("black-F5", "F5"));
    expect(pieceAt(vacated, sq("F1"))).toBeUndefined();
    expect(applyAction(vacated, resurrect("white-F1", "white-J1"))).toBeNull();
  });

  it("restores a captured promoted unit to a Pawn that has already moved", () => {
    const state = position([...KINGS, NECRO, ["white", "pawn", "F11", "F3", { hasMoved: true }],
      ["black", "rook", "G12"],
    ]);
    state.resurrectionState.white.pawn = 2;
    state.resurrectionState.white.bishop = 1;
    const promotion = play(state, move("white-F3", "F12", "bishop"));
    const capture = play(promotion, move("black-G12", "F12"));
    expect(capture.pieces["white-F3"]).toMatchObject({ type: "bishop", promoted: true, currentSquare: null });
    const exhaustedPawnQuota = {
      ...capture,
      resurrectionState: {
        ...capture.resurrectionState,
        white: { ...capture.resurrectionState.white, pawn: 3, bishop: 0 },
      },
    };
    expect(applyAction(exhaustedPawnQuota, resurrect("white-F3"))).toBeNull();
    const revived = play(capture, resurrect("white-F3"));
    expect(revived.resurrectionState.white).toMatchObject({ pawn: 3, bishop: 1 });
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

  it("allows a revived Shielder to survive existing fire without saving the ally behind it", () => {
    const initial = startPosition(position([
      ...KINGS, NECRO, ["white", "shielder", null, "E6"],
      ["white", "pawn", "E5", "E3", { hasMoved: true }], ["black", "dragon", "E7"],
    ], "black"));
    const burned = play(initial, {
      kind: "dragon", pieceId: "black-E7", destination: sq("G8"), fireTiming: "before",
    });
    expect(burned.fireState.effects.map((effect) => squareName(effect.square))).toContain("E6");
    const revived = play(burned, resurrect("white-E6"));
    expect(pieceAt(revived, sq("E6"))?.type).toBe("shielder");
    expect(revived.graveyard.white).toEqual(["white-E3"]);
    expect(remainingResurrections(revived, "white", "shielder")).toBe(0);
  });

  it("rejects resurrection when fire expiration removes a blocker and exposes its King", () => {
    const initial = startPosition(position([
      ...KINGS, NECRO, ["white", "knight", "A3", "B1"], ["white", "pawn", null, "D3"],
      ["black", "dragon", "A4"], ["black", "rook", "A8"],
    ], "black"));
    const burned = play(initial, {
      kind: "dragon", pieceId: "black-A4", destination: sq("C5"), fireTiming: "before",
    });
    expect(isInCheck(burned, "white")).toBe(false);
    expect(applyAction(burned, resurrect("white-D3"))).toBeNull();
    expect(remainingResurrections(burned, "white", "pawn")).toBe(3);
    expect(pieceAt(burned, sq("A3"))?.id).toBe("white-B1");
  });
});
