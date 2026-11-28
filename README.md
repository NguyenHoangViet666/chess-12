# 12×12 Chess

Ruleset **0.4** is a chess variant for two people at one screen, one player against a local bot, or two bots in self-play. The board has 144 squares and 26 starting pieces per side. White moves first.

## Run locally

Use Node.js 24 and npm. From this project folder:

```powershell
npm.cmd ci
npm.cmd run dev -- --open
```

Skip installation if the dependencies are already installed. Select a piece, then choose a highlighted destination. On the keyboard, press Tab to enter the board, use the arrow keys to navigate, then press Enter or Space. **How to play** explains the rules.

- **Dragon:** Choose Fire first or Fire after, select a landing square, and confirm the preview. The fire starts with two turns on the activation turn and has one turn left during the answer. It destroys vulnerable enemy pieces still on the zone after the answer. A landed piece at risk is marked before the action is played.
- **Shielder:** Any Shielder inside the preview cancels the whole new breath, regardless of color. Existing fire persists, and Shielders are immune. The dashed file shows the separate frontal guard.
- **Necromancer:** Each side may revive three Pawns and one piece of every other non-King original type. Revived pieces go back to their own empty starting square. A promoted Pawn consumes the Pawn allowance and returns as a Pawn.

Ordinary actions are checked after fire expires. A King may finish a legal answer on a square whose hostile fire has expired. Castling also checks the active hazards on the King’s start, crossing and destination squares. Inactive Dragon cones never give check.

Matches are in memory for the current tab. Refreshing starts a fresh match. Undo restores complete turns, including fire timers and resurrection allowances.

## Play against the bot

Choose **Play White vs bot** or **Play Black vs bot** in **Match mode**. The bot runs in a Web Worker and defaults to 1.5 seconds per turn, adjustable from 1 to 2 seconds. The analysis panel shows depth, nodes, time, score, the best completed move and its actual predicted line. Depth counts individual turns. **Undo** returns to your last decision in this mode.

The bot uses the same legal turn generator as the game. It searches with iterative deepening, alpha-beta pruning, move ordering, a transposition table and a bounded tactical search. Its evaluation tracks remaining revival allowances, active fire, escape options, piece placement and King safety. The execution interface can be replaced without changing the game rules or search.

## Watch self-play and measure balance

Choose **Bot vs bot** to watch a match. **Pause** stops the current search and **Resume** continues it. **Undo** rewinds one turn and leaves playback paused. Statistics credit delayed burns to the color that created the effect.

Run batches without the browser:

```powershell
npm.cmd run selfplay -- --games 8 --max-plies 160 --opening-plies 4 --nodes 1000 --seed 12012 --workers 4 --history --output selfplay-results/rules-0.4-seed-12012.json
```

Both colors use the same engine and deterministic search limits. The seed makes the quiet opening moves reproducible. The match cap includes those moves, while ability telemetry starts after them. The JSON includes the ruleset version, real and capped outcomes, search depth, fallbacks, fire activations, cancellations, expiration captures and resurrections. `--history` adds turn records. Run `npm.cmd run selfplay -- --help` for all options.

Games stopped at the move limit are counted separately from rule-based draws. Depth zero indicates a legal fallback. Compare reports from the same ruleset and settings when judging strength. The earlier `baseline-seed-12012.json` uses the previous rules.

## Project structure

- `src/engine/` defines board state, identities, movement, fire effects, legal actions, repetition and undo.
- `src/bot/` contains the evaluator, search and local worker.
- `src/App.tsx`, `src/components/` and `src/styles.css` implement the interface.
- `src/selfPlay/` and `scripts/self-play.mjs` implement batch matches and telemetry.
- `src/tests/` contains engine, bot and self-play regression tests.

## Verify or build

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run preview
```

The production build is written to `dist/`. Serve it over HTTP or use the preview command.
