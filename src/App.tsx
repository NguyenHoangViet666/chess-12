import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Board } from './components/Board'
import { BotPanel } from './components/BotPanel'
import type { BotDecision } from './bot/protocol'
import { useBot } from './bot/useBot'
import { PieceGlyph } from './components/PieceGlyph'
import { agreeDraw, applyAction, claimDraw, createSession, legalActions, undo, updateSession } from './engine/game'
import { shielderProtection } from './engine/fire'
import { actionLanding, dragonPreview } from './engine/rules'
import {
  opposite, pieceAt, sameSquare, squareName,
  type Action, type Color, type DragonAction, type DragonFireTiming, type DrawReason,
  type GameState, type MoveAction, type Piece, type PieceType, type Square,
} from './engine/model'

const colorNames = { white: 'White', black: 'Black' }
const drawNames: Record<DrawReason, string> = {
  threefold: 'Threefold repetition', fivefold: 'Fivefold repetition',
  'fifty-move': '50-move rule', 'seventy-five-move': '75-move rule',
  'bare-kings': 'Only the kings remain', stalemate: 'Stalemate', agreement: 'Mutual agreement',
}
const timingLabels: Record<DragonFireTiming, string> = {
  none: 'Move only', before: 'Fire first', after: 'Fire after',
}
const descriptions: Record<PieceType, string> = {
  king: 'One square in any direction. Keep it out of check.',
  queen: 'Any distance along a rank, file or diagonal.',
  rook: 'Any distance along a rank or file.',
  bishop: 'Any distance along a diagonal.',
  knight: 'Jumps in an L shape.',
  pawn: 'Moves forward and captures diagonally.',
  dragon: 'Jumps like a Knight. It can breathe fire once before or after moving.',
  necromancer: 'Moves one square in any direction. It can spend a turn reviving one ally.',
  shielder: 'Slides up to three squares along a rank or file. Guards its front and intercepts fire.',
}
const nameOf = (value: string) => value[0].toUpperCase() + value.slice(1)
const modeNames = {
  local: 'Two players', white: 'Play White vs bot', black: 'Play Black vs bot',
} as const
type MatchMode = keyof typeof modeNames
type DialogKind = 'rules' | 'restart' | 'draw' | { mode: MatchMode }

function lastHumanDecision(past: readonly GameState[], human: Color) {
  for (let index = past.length - 1; index >= 0; index--) {
    if (past[index].currentPlayer === human) return index
  }
  return -1
}

function Icon({ name }: { name: 'undo' | 'restart' | 'book' | 'close' | 'brand' }) {
  const paths = {
    undo: 'M9 14 4 9l5-5M4 9h9a6 6 0 0 1 0 12h-2',
    restart: 'M3 11a9 9 0 1 1 2.4 7M3 4v7h7',
    book: 'M12 5.5C9 3.5 6 3.5 2.5 5v14c3.5-1.5 6.5-1.5 9.5.5 3-2 6-2 9.5-.5V5C18 3.5 15 3.5 12 5.5Zm0 0v14',
    close: 'm6 6 12 12M18 6 6 18',
    brand: 'M12 2.5 20 6v5.5c0 4.8-3 8-8 10-5-2-8-5.2-8-10V6l8-3.5Zm-3 11.3h6m-6.8-2L9 8l3 2 3-2 .8 3.8',
  }
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!opener.current && document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement
    }
    dialog?.showModal()
    return () => {
      dialog?.close()
      queueMicrotask(() => {
        if (!dialog?.open && opener.current?.isConnected && document.activeElement === document.body) {
          opener.current.focus()
        }
      })
    }
  }, [])
  function dismiss() {
    ref.current?.close()
    opener.current?.focus()
    onClose()
  }
  return <dialog ref={ref} aria-labelledby={id} className="dialog"
    onCancel={event => { event.preventDefault(); dismiss() }}>
    <div className="dialog-heading">
      <h2 id={id}>{title}</h2>
      <button type="button" className="icon-button" aria-label="Close dialog" onClick={dismiss}><Icon name="close" /></button>
    </div>
    {children}
  </dialog>
}

function Rules() {
  return <div className="rules-copy">
    <p>Share a board with a second player or choose a side against the bot. White moves first. Checkmate wins.</p>
    <h3>Dragon</h3>
    <p>Jump like a Knight, with optional fire before or after the jump. The four-square cone always faces the opposing side. It burns enemy pieces and gives check, but never destroys a King.</p>
    <h3>Necromancer</h3>
    <p>Move like a King or spend the turn bringing one ally back to its original square if it is empty. A promoted Pawn returns as a Pawn. You need a living Necromancer to revive an ally.</p>
    <h3>Shielder</h3>
    <p>Slide up to three squares in a straight line. A Shielder resists direct captures from the front on its own file. It also intercepts fire aimed at itself and an ally directly behind it on that file.</p>
    <h3>Pawns and castling</h3>
    <p>Pawns start on ranks 3 and 10, retain the usual first double step and en passant, and promote to Queen, Rook, Bishop or Knight. Castle from G to I or E with the original Rook when the path is empty and the King is safe.</p>
    <h3>Draws</h3>
    <p>Stalemate, bare Kings, fivefold repetition and 75 moves per side without progress end the game automatically. Claim a draw after threefold repetition or 50 such moves. Two local players can also agree to a draw together. Pawn moves, captures and resurrections reset the move count.</p>
  </div>
}

function Graveyard({ game, color }: { game: GameState; color: Color }) {
  const ids = game.graveyard[color]
  return <div className="graveyard">
    <div className="graveyard-label"><span>{colorNames[color]}</span><span className="count">{ids.length}</span></div>
    {ids.length ? <ul className="captured-pieces">{ids.map(id => {
      const piece = game.pieces[id]
      const title = `${colorNames[color]} ${nameOf(piece.type)} · ${squareName(piece.spawnSquare)}`
      return <li key={id} title={title} aria-label={title}><PieceGlyph type={piece.type} color={color} /></li>
    })}</ul> : <p className="empty-state">No pieces captured.</p>}
  </div>
}

function Outcome({ game }: { game: GameState }) {
  const status = game.status
  const player = colorNames[game.currentPlayer]
  const color = status.kind === 'checkmate' ? status.winner : game.currentPlayer
  const heading = status.kind === 'checkmate' ? `${colorNames[status.winner]} wins`
    : status.kind === 'draw' ? 'Draw' : `${player} to move`
  const detail = status.kind === 'checkmate' ? 'Checkmate'
    : status.kind === 'draw' ? drawNames[status.reason]
    : status.inCheck ? `${player} is in check` : `Turn ${game.fullMoveNumber}`
  return <div className="outcome" aria-live="polite" aria-atomic="true">
    <div className={`turn-avatar avatar-${color}`}><PieceGlyph type="king" color={color} /></div>
    <div><h2>{heading}</h2><p className={status.kind === 'active' && status.inCheck ? 'check-text' : ''}>{detail}</p></div>
  </div>
}

function History({ game }: { game: GameState }) {
  return <section className="panel history-panel" aria-labelledby="history-title">
    <div className="section-heading"><h2 id="history-title">Move history</h2><span className="count">{game.moveHistory.length}</span></div>
    {game.moveHistory.length
      ? <ol className="history-list" reversed>{[...game.moveHistory].reverse().map(turn =>
        <li key={`${turn.fullMoveNumber}-${turn.color}`}>
          <span className="history-glyph"><PieceGlyph type={turn.pieceType} color={turn.color} /></span>
          <span className="history-text"><span className="history-player">{turn.fullMoveNumber}. {colorNames[turn.color]}</span>
            <span>{turn.description.slice(turn.description.indexOf(': ') + 2)}</span></span>
        </li>)}</ol>
      : <p className="empty-state">Moves will appear here.</p>}
  </section>
}

export function App() {
  const [session, setSession] = useState(() => createSession())
  const [mode, setMode] = useState<MatchMode>('local')
  const [selection, setSelection] = useState<string | null>(null)
  const [timing, setTiming] = useState<DragonFireTiming>('none')
  const [hover, setHover] = useState<Square | null>(null)
  const [pending, setPending] = useState<DragonAction>()
  const [promotion, setPromotion] = useState<MoveAction[]>([])
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const game = session.game
  const ready = game.status.kind === 'active'
  const human = mode === 'local' ? null : mode
  const botColor = human && opposite(human)
  const botTurn = ready && game.currentPlayer === botColor
  const playerTurn = ready && !botTurn
  const claims = game.status.kind === 'active' ? game.status.claimable : []
  const canUndo = human ? lastHumanDecision(session.past, human) >= 0 : session.past.length > 0
  const onBotDecision = useCallback((position: GameState, decision: BotDecision) => {
    const next = decision.kind === 'play'
      ? applyAction(position, decision.action)
      : claimDraw(position, decision.reason)
    if (!next) return false
    setSession(previous => previous.game === position ? updateSession(previous, next) : previous)
    return true
  }, [])
  const bot = useBot(botTurn ? game : null, dialog !== null, onBotDecision)
  const allActions = useMemo(() => playerTurn ? legalActions(game) : [], [game, playerTurn])
  const selected = playerTurn && selection ? game.pieces[selection] : undefined
  const options = useMemo(() => allActions.flatMap(action => {
    const landing = actionLanding(game, action)
    return landing?.pieceId === selection && (action.kind !== 'dragon' || action.fireTiming === timing)
      ? [{ action, ...landing }] : []
  }), [allActions, game, selection, timing])
  const destinations = useMemo(
    () => new Map(options.map(({ square, captures }) => [squareName(square), { captures }])),
    [options],
  )
  const hovering = options.find(option => sameSquare(option.square, hover))?.action
  const previewAction = pending ?? (hovering?.kind === 'dragon' ? hovering : undefined)
  const cone = selected?.type === 'dragon' && (timing !== 'after' || previewAction)
    ? dragonPreview(game, selected, previewAction) : []
  const shield = selected?.type === 'shielder' ? shielderProtection(game, selected) : { axis: [], protectedLine: [] }

  function resetSelection() {
    setSelection(null)
    setTiming('none')
    setHover(null)
    setPending(undefined)
    setPromotion([])
  }

  function select(piece: Piece) {
    resetSelection()
    setSelection(piece.id)
    if (piece.type === 'dragon') {
      const first = allActions.find(action => action.kind === 'dragon' && action.pieceId === piece.id)
      if (first?.kind === 'dragon') setTiming(first.fireTiming)
    }
  }

  function openDialog(next: DialogKind) {
    bot.pause()
    setDialog(next)
  }

  function startMatch(nextMode = mode) {
    bot.reset()
    setMode(nextMode)
    setSession(createSession())
    resetSelection()
    setDialog(null)
  }

  function changeMode(nextMode: MatchMode) {
    if (nextMode === mode) return
    if (game.moveHistory.length) openDialog({ mode: nextMode })
    else startMatch(nextMode)
  }

  function undoTurn() {
    if (!canUndo) return
    bot.reset()
    setSession(previous => {
      if (!human) return undo(previous)
      const index = lastHumanDecision(previous.past, human)
      return index < 0 ? previous : { game: previous.past[index], past: previous.past.slice(0, index) }
    })
    resetSelection()
  }

  function commit(next: GameState | null) {
    if (!playerTurn || !next) return
    setSession(previous => previous.game === game ? updateSession(previous, next) : previous)
    resetSelection()
    setDialog(null)
  }

  function play(action: Action) {
    if (playerTurn) commit(applyAction(game, action))
  }

  function clickSquare(square: Square) {
    if (!playerTurn) return
    const choices = options.filter(option => sameSquare(option.square, square)).map(({ action }) => action)
    const action = choices[0]
    if (action) {
      if (action.kind === 'move' && action.promotion) {
        setPromotion(choices.filter((choice): choice is MoveAction => choice.kind === 'move'))
      } else if (action.kind === 'dragon' && action.fireTiming === 'after' && !sameSquare(pending?.destination, square)) {
        setPending(action)
      } else {
        play(action)
      }
      return
    }
    const piece = pieceAt(game, square)
    if (piece?.color === game.currentPlayer && piece.id !== selection) select(piece)
    else resetSelection()
  }

  function changeTiming(choice: DragonFireTiming) {
    setTiming(choice)
    setPending(undefined)
    setHover(null)
  }

  const player = colorNames[game.currentPlayer]
  const captures = cone.filter(cell => cell.effect === 'victim').length
  const protections = cone.filter(cell => cell.effect === 'protected' || cell.effect === 'protected-king').length
  const threatened = cone.some(cell => cell.effect === 'king')
  const active = (color: Color) => ready && game.currentPlayer === color
  const seat = (color: Color) => <div className={`board-seat seat-${color}`}>
    <span className={`seat-token token-${color}`} /><span>{colorNames[color]}</span>
    {human && <span className="seat-role">{color === human ? 'You' : 'Bot'}</span>}
    {active(color) && <span className="seat-active">To move</span>}
  </div>

  return <>
    <header className="topbar"><div className="topbar-inner">
      <div className="brand"><span className="brand-mark"><Icon name="brand" /></span><h1>12×12 Chess</h1></div>
      <button type="button" className="control-button rules-button" onClick={() => openDialog('rules')}><Icon name="book" /> How to play</button>
    </div></header>

    <main className="game-layout">
      <section className="board-area" aria-label="Game board" aria-disabled={botTurn || undefined}>
        {seat('black')}
        <Board game={game} selected={selected?.currentSquare} destinations={destinations} cone={cone}
          armed={timing !== 'none'} axis={shield.axis} protectedLine={shield.protectedLine}
          pending={pending?.destination} onSquare={clickSquare} onHover={setHover} />
        {seat('white')}
      </section>

      <aside className="match-column" aria-label="Match and captured pieces">
        <section className="panel match-panel">
          <label className="match-mode">
            <span className="eyebrow">Match mode</span>
            <select value={mode} onChange={event => changeMode(event.currentTarget.value as MatchMode)}>
              {Object.entries(modeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Outcome game={game} />
          <div className="match-controls">
            <button type="button" className="control-button" disabled={!canUndo} onClick={undoTurn}>
              <Icon name="undo" /> Undo
            </button>
            <button type="button" className="control-button" onClick={() => openDialog('restart')}><Icon name="restart" /> Restart</button>
          </div>
          {playerTurn && (!human || claims.length > 0) && <div className="draw-controls">
            {!human && <button type="button" className="text-button" onClick={() => openDialog('draw')}>Agree to draw</button>}
            {claims.map(reason =>
              <button key={reason} type="button" className="text-button claim-button" onClick={() => commit(claimDraw(game, reason))}>
                Claim draw · {drawNames[reason]}
              </button>)}
          </div>}
          {bot.display && <BotPanel display={bot.display} onRetry={bot.retry} />}
        </section>

        <section className="panel graveyard-panel" aria-labelledby="graveyard-title">
          <div className="section-heading"><h2 id="graveyard-title">Graveyards</h2></div>
          <Graveyard game={game} color="white" />
          <Graveyard game={game} color="black" />
        </section>
      </aside>

      <aside className="details-column" aria-label="Piece actions and moves">
        <section className="panel action-panel" aria-labelledby="actions-title">
          <div className="section-heading"><h2 id="actions-title">Piece actions</h2></div>
          {selected ? <>
            <div className="selected-detail">
              <span className="action-glyph"><PieceGlyph type={selected.type} color={selected.color} /></span>
              <div><h3>{nameOf(selected.type)} <span>{squareName(selected.currentSquare!)}</span></h3>
                <p>{descriptions[selected.type]}</p></div>
            </div>
            {selected.type === 'dragon' && <>
              <div className="timing-controls" role="group" aria-label="Dragon fire timing">
                {(['none', 'before', 'after'] as const).map(choice => <button type="button" key={choice}
                  aria-pressed={timing === choice} onClick={() => changeTiming(choice)}
                  disabled={!allActions.some(action => action.kind === 'dragon' && action.pieceId === selection && action.fireTiming === choice)}>
                  {timingLabels[choice]}
                </button>)}
              </div>
              <div className="ability-preview" aria-live="polite">
                {timing === 'after' && !previewAction ? 'Choose a destination to preview the fire.'
                  : timing === 'none' ? 'Outlined squares show the Dragon’s current cone.'
                    : <><span className="legend-fire" /> {captures} burn · {protections} shielded{threatened ? ' · King threatened' : ''}</>}
              </div>
              {pending && <button type="button" className="primary-button" onClick={() => play(pending)}>Play move + fire</button>}
            </>}
            {selected.type === 'shielder' && <div className="ability-preview">
              <span className="legend-shield" /> Faces {selected.color === 'white' ? 'rank 12' : 'rank 1'}.
              The dashed file marks its frontal guard.{shield.protectedLine.length > 0 && ' Solid marks show active fire protection.'}
            </div>}
            {selected.type === 'necromancer' && <>
              <h3 className="ability-heading">Resurrect an ally</h3>
              {game.graveyard[game.currentPlayer].length ? <ul className="revive-list">
                {game.graveyard[game.currentPlayer].map(id => {
                  const piece = game.pieces[id]
                  const action = allActions.find(candidate => candidate.kind === 'resurrect' &&
                    candidate.necromancerId === selection && candidate.revivedPieceId === id)
                  const spawn = squareName(piece.spawnSquare)
                  const hint = pieceAt(game, piece.spawnSquare) ? 'Spawn occupied' : action ? 'Ready to revive' : 'King would be in check'
                  return <li key={id}><button type="button" disabled={!action} onClick={() => { if (action) play(action) }}>
                    <span className="revive-glyph"><PieceGlyph type={piece.baseType} color={piece.color} /></span>
                    <span><strong>{nameOf(piece.baseType)} · {spawn}</strong><small>{hint}</small></span>
                  </button></li>
                })}
              </ul> : <p className="empty-state">There are no allies in your graveyard.</p>}
            </>}
          </> : <p className="empty-state">{botTurn ? 'Wait for the bot to finish its turn.' : ready
            ? 'Select one of your pieces to see its moves and abilities.'
            : 'Restart to begin another match.'}</p>}
        </section>

        <History game={game} />

        <section className="variant-panel" aria-label="Variant pieces">
          <div className="section-heading"><h2>Variant pieces</h2></div>
          <ul>{(['dragon', 'necromancer', 'shielder'] as const).map(type =>
            <li key={type}><span className="variant-glyph"><PieceGlyph type={type} color="black" /></span>{nameOf(type)}</li>)}</ul>
        </section>
      </aside>
    </main>

    {promotion.length > 0 && <Dialog title="Promote your Pawn" onClose={() => setPromotion([])}>
      <p>Choose the piece this Pawn will become.</p>
      <div className="promotion-options">{promotion.map(action => <button className="control-button" type="button"
        key={action.promotion} onClick={() => play(action)}>
        <span className="promotion-glyph"><PieceGlyph type={action.promotion!} color={game.currentPlayer} /></span>
        {nameOf(action.promotion!)}
      </button>)}</div>
    </Dialog>}
    {dialog === 'rules' && <Dialog title="How to play" onClose={() => setDialog(null)}><Rules /></Dialog>}
    {dialog === 'restart' && <Dialog title="Restart match?" onClose={() => setDialog(null)}>
      <p>The board and move history will return to the starting position.</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Keep playing</button>
        <button type="button" className="primary-button" onClick={() => startMatch()}>Restart match</button>
      </div>
    </Dialog>}
    {dialog && typeof dialog === 'object' && <Dialog title="Change match mode?" onClose={() => setDialog(null)}>
      <p>Switching to {modeNames[dialog.mode]} will start a new match.</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Keep playing</button>
        <button type="button" className="primary-button" onClick={() => startMatch(dialog.mode)}>Start new match</button>
      </div>
    </Dialog>}
    {dialog === 'draw' && <Dialog title="Agree to a draw?" onClose={() => setDialog(null)}>
      <p>{player} offers a draw. {colorNames[opposite(game.currentPlayer)]} can accept or keep playing.</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Keep playing</button>
        <button type="button" className="primary-button" onClick={() => commit(agreeDraw(game))}>
          Accept as {colorNames[opposite(game.currentPlayer)]}
        </button>
      </div>
    </Dialog>}
  </>
}
