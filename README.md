# 12×12 Chess

A chess variant for two people at one screen or one player against a local bot. The starting board has 144 squares and 26 pieces per side. White moves first.

## Run locally

Use Node.js 24 and npm. From this project folder:

```powershell
npm.cmd ci
npm.cmd run dev -- --open
```

You can skip the install step if the dependencies are already installed. Open **How to play** in the game for a quick rules guide. Select one of the current player's pieces, then choose a highlighted destination. On the keyboard, press Tab to enter the board, use the arrow keys to navigate, then press Enter or Space to select or move.

- **Dragon:** Choose Move only, Fire first, or Fire after. For Fire after, select the destination to preview the result, then select it again or press **Play move + fire**.
- **Necromancer:** Select a living Necromancer and choose an eligible ally from the resurrection list. The move uses the whole turn.
- **Shielder:** The dashed file marks its frontal guard. Solid teal highlights show protection against a currently positioned enemy Dragon.

Matches are held in memory for the current tab. Refreshing the page starts a fresh match. Undo covers complete turns and draw decisions.

## Play against the bot

Choose **Play White vs bot** or **Play Black vs bot** in **Match mode**. The bot searches in a background worker for about 1.5 seconds per turn. **Completed depth** counts individual turns (plies). **Predicted reply** is the opponent's next move on the bot's best line when the search found one. In this mode **Undo** returns to your last decision, even if the bot has already replied.

The bot uses iterative deepening with alpha-beta pruning, orders tactical actions and reuses transposition entries. A bounded quiescence search extends captures, promotions, resurrections and responses to check. At the deadline it keeps the last completed search or a legal fallback. Its evaluation accounts for Dragon fire, Shielder interception, legal resurrection potential, piece placement and king safety. It uses the same legal turn generator and draw rules as the game.


## Project structure

- `src/engine/model.ts` defines board coordinates, identities, action types and the initial position.
- `src/engine/movement.ts` defines standard and special moves, en passant and direct attacks.
- `src/engine/fire.ts` calculates fire, interception and the same previews used by the UI.
- `src/engine/rules.ts` simulates complete actions and handles castling, King safety and repetition identity.
- `src/engine/game.ts` exposes validated turns, game status, draw actions and undo snapshots.
- `src/bot/` contains variant evaluation, timed search and the worker.
- `src/App.tsx`, `src/components/` and `src/styles.css` render and control the responsive interface. Assets are local vector artwork.
- `src/tests/` contains engine tests for movement, special pieces, King safety, draw conditions and undo.

Claimable draws are exposed once the current position or move counter reaches the specified threshold. Castling checks the starting, transit and final King squares, including Dragon fire. Conventional attack geometry still applies when an attacking piece is pinned.

## Verify or build

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run preview
```

The production build is written to `dist/`. Serve it over HTTP or use the preview command.
