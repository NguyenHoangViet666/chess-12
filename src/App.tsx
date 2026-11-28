import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Board } from './components/Board'
import { BotPanel } from './components/BotPanel'
import { BOT_PROFILES, UI_DIFFICULTIES } from './bot/profiles'
import { BOT_TURN_MS, type BotDecision, type BotDifficulty } from './bot/protocol'
import { useBot, useBotHint } from './bot/useBot'
import { createMatchStats, recordAction, type SideStats } from './selfPlay/stats'
import { PieceGlyph } from './components/PieceGlyph'
import { agreeDraw, applyAction, claimDraw, createSession, legalActions, undo, updateSession, type Session } from './engine/game'
import { shielderAxis, type FirePreview } from './engine/fire'
import { actionFireRisk, actionLanding, dragonPreview, livingNecromancers, resurrectionBlock, simulateAction } from './engine/rules'
import {
  RESURRECTION_LIMIT, RESURRECTION_TYPES, RULESET_VERSION,
  opposite, pieceAt, remainingResurrections, sameSquare, squareName,
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
  dragon: 'Jumps like a Knight and can ignite a cone before or after moving.',
  necromancer: 'Moves one square in any direction. Reviving an ally spends one turn and one quota for its original piece type.',
  shielder: 'Slides up to three squares along a rank or file. Guards its exact front and cancels new fire in any cone it occupies.',
}
const nameOf = (value: string) => value[0].toUpperCase() + value.slice(1)
const modeNames = {
  local: 'Two players', white: 'Play White vs bot', black: 'Play Black vs bot', 'self-play': 'Bot vs bot',
} as const
const botTimeOptions = [500, 1000, 1500, 2500, 5000, 10000, 15000, 30000] as const
function formatTimeOption(ms: number) {
  return ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`
}
type MatchMode = keyof typeof modeNames
type DialogKind = 'rules' | 'restart' | 'draw' | { mode: MatchMode } | { risk: Action }

function rewindIndex(session: Session, mode: MatchMode) {
  if (mode === 'local') return session.past.length - 1

  for (let index = session.past.length - 1; index >= 0; index--) {
    const previous = session.past[index]
    if (mode === 'self-play') {
      if (previous.moveHistory.length < session.game.moveHistory.length) return index
    } else if (previous.currentPlayer === mode) {
      return index
    }
  }
  return -1
}

function Icon({ name }: { name: 'undo' | 'restart' | 'book' | 'close' | 'brand' | 'sun' | 'moon' }) {
  const paths = {
    undo: 'M9 14 4 9l5-5M4 9h9a6 6 0 0 1 0 12h-2',
    restart: 'M3 11a9 9 0 1 1 2.4 7M3 4v7h7',
    book: 'M12 5.5C9 3.5 6 3.5 2.5 5v14c3.5-1.5 6.5-1.5 9.5.5 3-2 6-2 9.5-.5V5C18 3.5 15 3.5 12 5.5Zm0 0v14',
    close: 'm6 6 12 12M18 6 6 18',
    brand: 'M12 2.5 20 6v5.5c0 4.8-3 8-8 10-5-2-8-5.2-8-10V6l8-3.5Zm-3 11.3h6m-6.8-2L9 8l3 2 3-2 .8 3.8',
    sun: 'M12 4V2m0 20v-2M4.93 4.93 3.51 3.51m16.98 16.98-1.42-1.42M4 12H2m20 0h-2M4.93 19.07l-1.42 1.42M20.49 3.51l-1.42 1.42M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    moon: 'M20.35 15.35A9 9 0 0 1 8.65 3.65a9 9 0 1 0 11.7 11.7Z',
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
    <p>Share a board with a second player, choose a side against the bot, or watch two bots play. White moves first. Checkmate wins. Ruleset {RULESET_VERSION}.</p>
    <h3>Dragon</h3>
    <p>Jump like a Knight. Fire before or after the jump ignites a four-square cone facing the opposing side. It lasts through your turn and your opponent’s response. At expiration it destroys enemy pieces still on affected squares. A King is threatened by active hostile fire and is never destroyed by it.</p>
    <h3>Necromancer</h3>
    <p>Move like a King or spend the turn returning one ally to its empty original square. Each side can revive up to three Pawns and one of each other non-King type. A promoted Pawn returns as a Pawn and spends Pawn quota. You need a living Necromancer to revive an ally.</p>
    <h3>Shielder</h3>
    <p>Slide up to three squares in a straight line. A Shielder resists direct captures from the front on its own file. Any Shielder inside a new fire cone cancels the entire attack, regardless of side. Shielders are immune to already active fire, which stays in place.</p>
    <h3>Pawns and castling</h3>
    <p>Pawns start on ranks 3 and 10, retain the usual first double step and en passant, and promote to Queen, Rook, Bishop or Knight. Castle from G to I or E with the original Rook when the path is empty and the King is safe.</p>
    <h3>Draws</h3>
    <p>Stalemate, bare Kings, fivefold repetition and 75 moves per side without progress end the game automatically. Claim a draw after threefold repetition or 50 such moves. Two local players can also agree to a draw together. Pawn moves, captures and resurrections reset the move count.</p>
  </div>
}

function Graveyard({ game, color, highlightRevivable = false }: { game: GameState; color: Color; highlightRevivable?: boolean }) {
  const ids = game.graveyard[color]
  const necromancers = livingNecromancers(game, color).length
  return <div className="graveyard">
    <div className="graveyard-label"><span>{colorNames[color]}</span><span className="count">{ids.length}</span></div>
    <p className="graveyard-necromancers">{necromancers
      ? `${necromancers} living Necromancer${necromancers === 1 ? '' : 's'}`
      : 'No living Necromancer'}</p>
    {ids.length ? <ul className="captured-pieces">{ids.map(id => {
      const piece = game.pieces[id]
      const canRevive = highlightRevivable && resurrectionBlock(game, piece) === null
      const title = `${colorNames[color]} ${nameOf(piece.type)} · ${squareName(piece.spawnSquare)}`
      return <li key={id} title={title} aria-label={title} className={canRevive ? 'revivable-ready' : undefined}>
        <span className="captured-glyph"><PieceGlyph type={piece.type} color={color} /></span>
        <span>{squareName(piece.spawnSquare)}</span>
      </li>
    })}</ul> : <p className="empty-state">No pieces captured.</p>}
  </div>
}

function Quotas({ game }: { game: GameState }) {
  return <details className="quota-panel">
    <summary>Resurrection quotas</summary>
    <table className="match-stats-table" aria-label="Remaining resurrection quota">
      <thead><tr><th scope="col">Piece type</th><th scope="col">White</th><th scope="col">Black</th></tr></thead>
      <tbody>{RESURRECTION_TYPES.map(type => <tr key={type}>
        <th scope="row">{nameOf(type)}</th>
        <td>{remainingResurrections(game, 'white', type)}/{RESURRECTION_LIMIT[type]}</td>
        <td>{remainingResurrections(game, 'black', type)}/{RESURRECTION_LIMIT[type]}</td>
      </tr>)}</tbody>
    </table>
  </details>
}

function FireNotice({ game }: { game: GameState }) {
  const fire = game.moveHistory.at(-1)?.fire
  if (!fire || (!fire.created.length && !fire.expired.length && !fire.canceledBy.length)) return null
  return <div className="fire-notice" role="status" aria-atomic="true">
    {fire.canceledBy.length > 0 && <p><strong>Fire canceled.</strong> Shielder neutralized the entire cone.</p>}
    {fire.created.length > 0 && <p><strong>Fire ignited for 2 turns.</strong> 1 turn remains after the Dragon completes its action.</p>}
    {fire.expired.length > 0 && <p><strong>Fire expired.</strong> {fire.captures.length
      ? fire.captures.map(({ pieceId, square }) => {
        const piece = game.pieces[pieceId]
        return `${colorNames[piece.color]} ${nameOf(piece.type)} at ${squareName(square)}`
      }).join(', ') + ' destroyed.'
      : 'No pieces destroyed.'}</p>}
  </div>
}

function PreviewDetails({ game, preview }: { game: GameState; preview: FirePreview }) {
  const canceled = preview.canceledBy.length > 0
  const occupants = preview.cells.filter(cell => cell.pieceId)
  return <div className={`ability-preview${canceled ? ' ability-canceled' : ''}`} aria-live="polite">
    <p>{canceled
      ? <strong>The Shielder cancels the entire Fire Breath.</strong>
      : preview.cells.length ? 'Fire preview · 2 turns on ignition.' : 'The cone is outside the board.'}</p>
    {occupants.length > 0 && <ul className="fire-preview-list">{occupants.map(cell => {
      const piece = game.pieces[cell.pieceId!]
      const effect = cell.effect === 'shielder' ? 'cancels fire'
        : canceled ? 'unaffected'
        : cell.effect === 'ally' ? 'immune'
        : cell.effect === 'king' ? 'in check once ignited' : 'exposed to fire'
      return <li key={cell.pieceId}>{squareName(cell.square)} · {colorNames[piece.color]} {nameOf(piece.type)} ({effect})</li>
    })}</ul>}
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

const spectatorStats = [
  ['Turns played', (side: SideStats) => side.plies],
  ['Movement captures', (side: SideStats) => side.normalCaptures],
  ['Dragon fire uses', (side: SideStats) => side.dragon.fireBefore + side.dragon.fireAfter],
  ['Pieces burned', (side: SideStats) => side.dragon.burnCaptures],
  ['Fire interceptions', (side: SideStats) => side.shielder.interceptedActivations],
  ['Resurrections', (side: SideStats) => side.resurrections],
] as const

function SpectatorStats({ session }: { session: Session }) {
  const stats = useMemo(() => {
    const totals = createMatchStats()
    session.past.forEach((before, index) => recordAction(totals, before, session.past[index + 1] ?? session.game))
    return totals
  }, [session])

  return <section className="panel action-panel" aria-labelledby="match-stats-title">
    <div className="section-heading"><h2 id="match-stats-title">Match stats</h2></div>
    <table className="match-stats-table" aria-labelledby="match-stats-title">
      <thead><tr><th scope="col">Activity</th><th scope="col">White</th><th scope="col">Black</th></tr></thead>
      <tbody>{spectatorStats.map(([name, value]) =>
        <tr key={name}><th scope="row">{name}</th><td>{value(stats.white)}</td><td>{value(stats.black)}</td></tr>)}</tbody>
    </table>
  </section>
}

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('chess12-theme') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('chess12-theme', theme)
    } catch {
      // ignore storage errors
    }
  }, [theme])

  const [session, setSession] = useState(() => createSession())
  const [mode, setMode] = useState<MatchMode>('local')
  const [whiteDifficulty, setWhiteDifficulty] = useState<BotDifficulty>('max')
  const [blackDifficulty, setBlackDifficulty] = useState<BotDifficulty>('max')
  const [botTime, setBotTime] = useState(BOT_TURN_MS)
  const [ponderEnabled, setPonderEnabled] = useState(true)
  const [showPvHint, setShowPvHint] = useState(true)
  const [selfPlayPaused, setSelfPlayPaused] = useState(false)
  const [selection, setSelection] = useState<string | null>(null)
  const [timing, setTiming] = useState<DragonFireTiming>('none')
  const [hover, setHover] = useState<Square | null>(null)
  const [pending, setPending] = useState<DragonAction>()
  const [promotion, setPromotion] = useState<MoveAction[]>([])
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const game = session.game
  const ready = game.status.kind === 'active'
  const selfPlay = mode === 'self-play'
  const human = mode === 'white' || mode === 'black' ? mode : null
  const botColor = human && opposite(human)
  const botTurn = ready && (selfPlay || game.currentPlayer === botColor)
  const playerTurn = ready && !botTurn
  const activeDifficulty = game.currentPlayer === 'white' ? whiteDifficulty : blackDifficulty
  const activeBotDifficulty = human ? (botColor === 'white' ? whiteDifficulty : blackDifficulty) : activeDifficulty
  const claims = game.status.kind === 'active' ? game.status.claimable : []
  const canUndo = rewindIndex(session, mode) >= 0
  const hintCtrl = useBotHint()

  const onBotDecision = useCallback((position: GameState, decision: BotDecision) => {
    const next = decision.kind === 'play'
      ? applyAction(position, decision.action)
      : claimDraw(position, decision.reason)
    if (!next) return false
    // Make the accepted turn visible before another input can pause or undo it.
    flushSync(() => setSession(previous => previous.game === position ? updateSession(previous, next) : previous))
    return true
  }, [])

  const lastBotRef = useRef<{ pvReply: Action | null; forGame: GameState | null }>({ pvReply: null, forGame: null })
  const bot = useBot(
    botTurn ? game : null,
    dialog !== null || (selfPlay && selfPlayPaused),
    botTime,
    onBotDecision,
    undefined,
    {
      difficulty: activeBotDifficulty,
      smartTime: true,
      useBook: BOT_PROFILES[activeBotDifficulty].useBook,
      ponderEnabled: Boolean(human && ponderEnabled && BOT_PROFILES[activeBotDifficulty].ponder && (!hintCtrl.hint || hintCtrl.hint.position !== game)),
      ponderPosition: useMemo(() => {
        if (!human || !ready || botTurn || dialog !== null) return null
        const prev = lastBotRef.current
        if (!prev.pvReply || prev.forGame !== game) return null
        return applyAction(game, prev.pvReply)
      }, [botTurn, dialog, game, human, ready]),
    },
  )

  useEffect(() => {
    if (bot.display?.kind === 'complete' && bot.display.analysis.principalVariation.length >= 2) {
      lastBotRef.current = {
        pvReply: bot.display.analysis.principalVariation[1],
        forGame: game,
      }
    }
  }, [bot.display, game])

  useEffect(() => {
    if (hintCtrl.hint && hintCtrl.hint.position !== game) {
      hintCtrl.clearHint()
    }
  }, [game, hintCtrl])

  const hintSquares = useMemo(() => {
    if (!showPvHint) return null
    const activeAnalysis = hintCtrl.hint?.position === game
      ? hintCtrl.hint.analysis
      : bot.display && 'analysis' in bot.display && bot.display.position === game
        ? bot.display.analysis
        : null
    const act = activeAnalysis?.decision.kind === 'play' ? activeAnalysis.decision.action : activeAnalysis?.principalVariation[0]
    if (!act) return null
    const sim = simulateAction(game, act)
    return { from: sim.turn.from, to: sim.turn.to }
  }, [bot.display, game, hintCtrl.hint, showPvHint])
  const allActions = useMemo(() => playerTurn ? legalActions(game) : [], [game, playerTurn])
  const selected = playerTurn && selection ? game.pieces[selection] : undefined
  const options = useMemo(() => allActions.flatMap(action => {
    const landing = actionLanding(game, action)
    return landing?.pieceId === selection && (action.kind !== 'dragon' || action.fireTiming === timing)
      ? [{ action, ...landing, fireRisk: actionFireRisk(game, action) }] : []
  }), [allActions, game, selection, timing])
  const destinations = useMemo(
    () => new Map(options.map(({ square, captures, fireRisk }) => [squareName(square), { captures, fireRisk }])),
    [options],
  )
  const hovering = options.find(option => sameSquare(option.square, hover))?.action
  const previewAction = pending ?? (hovering?.kind === 'dragon' ? hovering : undefined)
  const preview = selected?.type === 'dragon' && timing !== 'none' && (timing === 'before' || previewAction)
    ? dragonPreview(game, selected, previewAction) : undefined
  const axis = selected?.type === 'shielder' ? shielderAxis(selected) : []

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
    hintCtrl.clearHint()
    setDialog(next)
  }

  function startMatch(nextMode = mode, { autoPlay = false } = {}) {
    bot.reset()
    hintCtrl.clearHint()
    setMode(nextMode)
    setSelfPlayPaused(nextMode === 'self-play' && !autoPlay)
    setSession(createSession())
    resetSelection()
    setDialog(null)
  }

  function changeMode(nextMode: MatchMode) {
    if (nextMode === mode) return
    if (game.moveHistory.length) openDialog({ mode: nextMode })
    else startMatch(nextMode, { autoPlay: true })
  }

  function toggleSelfPlay() {
    if (!selfPlayPaused) bot.pause()
    setSelfPlayPaused(!selfPlayPaused)
  }

  function undoTurn() {
    if (!canUndo) return
    bot.reset()
    hintCtrl.clearHint()
    if (selfPlay) setSelfPlayPaused(true)
    setSession(previous => {
      const index = rewindIndex(previous, mode)
      if (index < 0) return previous
      if (index === previous.past.length - 1) return undo(previous)
      return { game: previous.past[index], past: previous.past.slice(0, index) }
    })
    resetSelection()
  }

  function commit(next: GameState | null) {
    if (!playerTurn || !next) return
    setSession(previous => previous.game === game ? updateSession(previous, next) : previous)
    resetSelection()
    setDialog(null)
  }

  function completePlay(action: Action) {
    if (playerTurn) commit(applyAction(game, action))
  }

  function play(action: Action) {
    if (!playerTurn) return
    if (actionFireRisk(game, action)) {
      setPromotion([])
      openDialog({ risk: action })
    } else {
      completePlay(action)
    }
  }

  function clickSquare(square: Square) {
    if (!playerTurn) return
    const choices = options.filter(option => sameSquare(option.square, square)).map(({ action }) => action)
    const action = choices[0]
    if (action) {
      if (action.kind === 'move' && action.promotion) {
        setPromotion(choices.filter((choice): choice is MoveAction => choice.kind === 'move'))
      } else if (action.kind === 'dragon' && action.fireTiming !== 'none') {
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
  const active = (color: Color) => ready && game.currentPlayer === color
  const seat = (color: Color) => <div className={`board-seat seat-${color}`}>
    <span className={`seat-token token-${color}`} /><span>{colorNames[color]}</span>
    {(selfPlay || human) && <span className="seat-role">{color === human ? 'You' : 'Bot'}</span>}
    {active(color) && <span className="seat-active">To move</span>}
  </div>

  return <>
    <header className="topbar"><div className="topbar-inner">
      <div className="brand"><span className="brand-mark"><Icon name="brand" /></span><h1>12×12 Chess</h1></div>
      <div className="topbar-actions">
        <button type="button" className="control-button theme-button"
          onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
          aria-label={theme === 'dark' ? 'Switch to Light Parchment theme' : 'Switch to Dark Royal Fantasy theme'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button type="button" className="control-button rules-button" onClick={() => openDialog('rules')}><Icon name="book" /> How to play</button>
      </div>
    </div></header>

    <main className="game-layout">
      <section className="board-area" aria-label="Game board" aria-disabled={!playerTurn || undefined}>
        {seat('black')}
        <Board game={game} selected={selected?.currentSquare} destinations={destinations}
          preview={preview} axis={axis} pending={pending?.destination} hintSquares={hintSquares} onSquare={clickSquare} onHover={setHover} />
        {seat('white')}
        {game.fireState.effects.length > 0 && <p className="board-fire-legend">
          W / B marks fire owner. The number is turns remaining. ! marks danger.
        </p>}
        <FireNotice game={game} />
      </section>

      <aside className="match-column" aria-label="Match and captured pieces">
        <section className="panel match-panel">
          <label className="match-mode">
            <span className="eyebrow">Match mode</span>
            <select value={mode} onChange={event => changeMode(event.currentTarget.value as MatchMode)}>
              {Object.entries(modeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {mode !== 'local' && !selfPlay && <label className="match-mode bot-time">
            <span className="eyebrow">AI difficulty</span>
            <select value={botColor === 'white' ? whiteDifficulty : blackDifficulty} onChange={event => {
              const nextDiff = event.currentTarget.value as BotDifficulty
              if (botColor === 'white') setWhiteDifficulty(nextDiff)
              else setBlackDifficulty(nextDiff)
              setBotTime(BOT_PROFILES[nextDiff].defaultTimeMs)
            }}>
              {UI_DIFFICULTIES.map(diff => <option key={diff} value={diff}>{BOT_PROFILES[diff].label}</option>)}
            </select>
          </label>}
          {selfPlay && <>
            <label className="match-mode bot-time">
              <span className="eyebrow">White AI</span>
              <select value={whiteDifficulty} onChange={event => setWhiteDifficulty(event.currentTarget.value as BotDifficulty)}>
                {UI_DIFFICULTIES.map(diff => <option key={diff} value={diff}>{BOT_PROFILES[diff].label}</option>)}
              </select>
            </label>
            <label className="match-mode bot-time">
              <span className="eyebrow">Black AI</span>
              <select value={blackDifficulty} onChange={event => setBlackDifficulty(event.currentTarget.value as BotDifficulty)}>
                {UI_DIFFICULTIES.map(diff => <option key={diff} value={diff}>{BOT_PROFILES[diff].label}</option>)}
              </select>
            </label>
          </>}
          {mode !== 'local' && <label className="match-mode bot-time">
            <span className="eyebrow">AI time per move</span>
            <select value={botTime} onChange={event => {
              bot.pause()
              setBotTime(Number(event.currentTarget.value))
            }}>
              {botTimeOptions.map(time => <option key={time} value={time}>{formatTimeOption(time)}</option>)}
            </select>
          </label>}
          {mode !== 'local' && <div className="bot-toggles">
            {human && <label className="bot-toggle">
              <input type="checkbox" checked={ponderEnabled} onChange={event => setPonderEnabled(event.currentTarget.checked)} />
              <span>Ponder on my turn</span>
            </label>}
            <label className="bot-toggle">
              <input type="checkbox" checked={showPvHint} onChange={event => setShowPvHint(event.currentTarget.checked)} />
              <span>Highlight AI hint</span>
            </label>
          </div>}
          <Outcome game={game} />
          <div className="match-controls">
            <button type="button" className="control-button" disabled={!canUndo} onClick={undoTurn}>
              <Icon name="undo" /> Undo
            </button>
            <button type="button" className="control-button" onClick={() => openDialog('restart')}><Icon name="restart" /> Restart</button>
          </div>
          {playerTurn && <div className="hint-controls">
            <button type="button" className="control-button hint-button"
              onClick={() => hintCtrl.requestHint(game, Math.max(botTime, 1500), activeDifficulty)}>
              {hintCtrl.hint?.status === 'thinking' ? 'Analyzing…' : 'AI Hint / Analyze'}
            </button>
          </div>}
          {playerTurn && (!human || claims.length > 0) && <div className="draw-controls">
            {!human && <button type="button" className="text-button" onClick={() => openDialog('draw')}>Agree to draw</button>}
            {claims.map(reason =>
              <button key={reason} type="button" className="text-button claim-button" onClick={() => commit(claimDraw(game, reason))}>
                Claim draw · {drawNames[reason]}
              </button>)}
          </div>}
          {selfPlay && ready && <div className="self-play-controls">
            <button type="button" className="control-button" onClick={toggleSelfPlay}>
              {selfPlayPaused ? 'Resume' : 'Pause'}
            </button>
          </div>}
          {(bot.display || (hintCtrl.hint && hintCtrl.hint.position === game)) && (
            <BotPanel
              display={bot.display}
              ponder={bot.ponderDisplay}
              hint={hintCtrl.hint?.position === game ? hintCtrl.hint : null}
              onRetry={bot.retry}
            />
          )}
        </section>

        <section className="panel graveyard-panel" aria-labelledby="graveyard-title">
          <div className="section-heading"><h2 id="graveyard-title">Graveyards</h2></div>
          <Graveyard game={game} color="white" highlightRevivable={selected?.type === 'necromancer' && game.currentPlayer === 'white'} />
          <Graveyard game={game} color="black" highlightRevivable={selected?.type === 'necromancer' && game.currentPlayer === 'black'} />
          <Quotas game={game} />
        </section>
      </aside>

      <aside className="details-column" aria-label={selfPlay ? 'Statistics and moves' : 'Piece actions and moves'}>
        {selfPlay ? <SpectatorStats session={session} /> : <section className="panel action-panel" aria-labelledby="actions-title">
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
              {preview ? <PreviewDetails game={game} preview={preview} />
                : timing === 'after' && <p className="ability-preview">Choose a destination to preview the fire.</p>}
              {pending && <div className="fire-confirm">
                <p>Dragon destination: <strong>{squareName(pending.destination)}</strong></p>
                {actionFireRisk(game, pending) && <p className="fire-risk-warning">
                  The Dragon will be destroyed when active fire expires on this turn.
                </p>}
                <button type="button" className="primary-button" onClick={() => completePlay(pending)}>Confirm dragon turn</button>
                <button type="button" className="text-button" onClick={() => { setPending(undefined); setHover(null) }}>Cancel destination</button>
              </div>}
            </>}
            {selected.type === 'shielder' && <div className="ability-preview">
              <span className="legend-shield" /> Faces {selected.color === 'white' ? 'rank 12' : 'rank 1'}.
              The dashed line marks its frontal guard. A Shielder in any square of a new cone cancels the entire fire.
            </div>}
            {selected.type === 'necromancer' && <>
              <h3 className="ability-heading">Resurrect an ally</h3>
              {game.graveyard[game.currentPlayer].length ? <ul className="revive-list">
                {game.graveyard[game.currentPlayer].map(id => {
                  const piece = game.pieces[id]
                  const action = allActions.find(candidate => candidate.kind === 'resurrect' &&
                    candidate.necromancerId === selection && candidate.revivedPieceId === id)
                  const spawn = squareName(piece.spawnSquare)
                  const occupied = Boolean(pieceAt(game, piece.spawnSquare))
                  const remaining = remainingResurrections(game, piece.color, piece.baseType)
                  const block = resurrectionBlock(game, piece)
                  const hint = action ? actionFireRisk(game, action) ? 'Fire will destroy this piece on revival' : 'Ready to revive'
                    : block === 'quota' ? 'Quota exhausted'
                    : block === 'occupied' ? 'Spawn occupied'
                    : block === 'no-necromancer' ? 'No living Necromancer'
                    : block === 'ineligible' ? 'Ineligible' : 'King would be in check'
                  return <li key={id}><button type="button" disabled={!action} onClick={() => { if (action) play(action) }}>
                    <span className="revive-glyph"><PieceGlyph type={piece.baseType} color={piece.color} /></span>
                    <span>
                      <strong>{nameOf(piece.baseType)} · {spawn}</strong>
                      <small>{occupied ? 'Occupied spawn' : 'Empty spawn'} · {remaining} quota left</small>
                      <small>{hint}</small>
                    </span>
                  </button></li>
                })}
              </ul> : <p className="empty-state">There are no allies in your graveyard.</p>}
            </>}
          </> : <p className="empty-state">{botTurn ? 'Wait for the bot to finish its turn.' : ready
            ? 'Select one of your pieces to see its moves and abilities.'
            : 'Restart to begin another match.'}</p>}
        </section>}

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
      <p>The board and move history will return to the starting position.{selfPlay && ' Playback will be paused.'}</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Keep playing</button>
        <button type="button" className="primary-button" onClick={() => startMatch()}>Restart match</button>
      </div>
    </Dialog>}
    {dialog && typeof dialog === 'object' && 'mode' in dialog && <Dialog title="Change match mode?" onClose={() => setDialog(null)}>
      <p>Switching to {modeNames[dialog.mode]} will start a new match.</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Keep playing</button>
        <button type="button" className="primary-button" onClick={() => startMatch(dialog.mode, { autoPlay: true })}>Start new match</button>
      </div>
    </Dialog>}
    {dialog && typeof dialog === 'object' && 'risk' in dialog && <Dialog title="Confirm fire risk?" onClose={() => setDialog(null)}>
      <p>The piece will be destroyed when fire expires at the end of this turn. The action is legal. Choose Cancel to look for another move.</p>
      <div className="dialog-actions">
        <button type="button" className="control-button" onClick={() => setDialog(null)}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => completePlay(dialog.risk)}>Confirm action</button>
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
