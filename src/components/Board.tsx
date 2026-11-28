import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { BOARD_SIZE, FILES, pieceAt, sameSquare, squareName, type Color, type FireEffect, type GameState, type PieceType, type Square } from '../engine/model'
import { isBurnable, turnsRemaining, type FirePreview } from '../engine/fire'
import { kingOf } from '../engine/rules'
import { BoardVfxCanvas } from './BoardVfxCanvas'
import { PieceGlyph } from './PieceGlyph'

const ranks = Array.from({ length: BOARD_SIZE }, (_, index) => BOARD_SIZE - 1 - index)
const files = [...FILES]
const ownerNames = { white: 'White', black: 'Black' }

interface Props {
  game: GameState
  selected?: Square | null
  destinations: Map<string, { captures: boolean; fireRisk: boolean }>
  preview?: FirePreview
  axis: Square[]
  pending?: Square
  hintSquares?: { from: Square | null; to: Square } | null
  onSquare: (square: Square) => void
  onHover: (square: Square | null) => void
}

interface BurnGhost {
  key: string
  type: PieceType
  color: Color
  square: Square
}

export function Board({ game, selected, destinations, preview, axis, pending, hintSquares, onSquare, onHover }: Props) {
  const [focusSquare, setFocusSquare] = useState('A12')
  const squares = useRef(new Map<string, HTMLButtonElement>())
  const spriteRefs = useRef(new Map<string, HTMLDivElement>())
  const shadowRefs = useRef(new Map<string, HTMLDivElement>())
  const prevHistoryLenRef = useRef(game.moveHistory.length)
  const [burnGhosts, setBurnGhosts] = useState<BurnGhost[]>([])

  const currentKing = game.status.kind === 'checkmate' || (game.status.kind === 'active' && game.status.inCheck)
    ? kingOf(game, game.currentPlayer)?.currentSquare : null
  const last = game.moveHistory.at(-1)
  const previewCells = useMemo(() => new Map(preview?.cells.map(cell => [squareName(cell.square), cell])), [preview])
  const canceled = Boolean(preview?.canceledBy.length)
  const axisNames = useMemo(() => new Set(axis.map(squareName)), [axis])

  const activeFire = useMemo(() => {
    const map = new Map<string, { effect: FireEffect; remaining: number }[]>()
    for (const effect of game.fireState.effects) {
      const remaining = turnsRemaining(effect, game.fireState.currentTurnIndex)
      if (!remaining) continue
      const name = squareName(effect.square)
      const active = map.get(name) ?? []
      active.push({ effect, remaining })
      map.set(name, active)
    }
    return map
  }, [game.fireState])

  const livingPieces = useMemo(
    () => Object.values(game.pieces)
      .filter(piece => piece.currentSquare !== null)
      .sort((a, b) => a.id.localeCompare(b.id)),
    [game.pieces],
  )

  const lastMovedPieceId = useMemo(() => {
    if (!last) return null
    if (last.action.kind === 'resurrect') return last.action.revivedPieceId
    if (last.action.kind === 'castle') return kingOf(game, last.color)?.id ?? null
    return last.action.pieceId
  }, [game, last])

  // Trigger airborne jump / arcane revival animations on the moved piece sprite
  useLayoutEffect(() => {
    const prevLen = prevHistoryLenRef.current
    const currLen = game.moveHistory.length
    prevHistoryLenRef.current = currLen
    if (currLen !== prevLen + 1 || currLen === 0) return

    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) return

    const turn = game.moveHistory[currLen - 1]
    if (turn.action.kind === 'resurrect') {
      const sprite = spriteRefs.current.get(turn.action.revivedPieceId)
      sprite?.animate(
        [
          { transform: 'translateY(26%) scale(0.3)', opacity: 0, filter: 'brightness(2.3) drop-shadow(0 0 12px #52e5a5)' },
          { transform: 'translateY(-7%) scale(1.09)', opacity: 1, offset: 0.68 },
          { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'none' },
        ],
        { duration: 440, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
      return
    }

    if (turn.action.kind === 'move' || turn.action.kind === 'dragon') {
      if (turn.pieceType === 'knight' || turn.pieceType === 'dragon') {
        const sprite = spriteRefs.current.get(turn.action.pieceId)
        const shadow = shadowRefs.current.get(turn.action.pieceId)
        sprite?.animate(
          [
            { transform: 'translateY(0) scale(1)' },
            { transform: 'translateY(-34%) scale(1.25)', offset: 0.48 },
            { transform: 'translateY(0) scale(1)' },
          ],
          { duration: 270, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        )
        shadow?.animate(
          [
            { transform: 'scale(1)', opacity: 0.5 },
            { transform: 'scale(0.68)', opacity: 0.22, offset: 0.48 },
            { transform: 'scale(1)', opacity: 0.5 },
          ],
          { duration: 270, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        )
      }
    }
  }, [game.moveHistory])

  // Spawn brief incineration ghosts for pieces destroyed by expired fire
  useEffect(() => {
    if (!last || last.fire.captures.length === 0) return
    const reducedMotion = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) return

    const ghosts: BurnGhost[] = last.fire.captures.map((cap, idx) => {
      const piece = game.pieces[cap.pieceId]
      return {
        key: `${game.fireState.currentTurnIndex}-${cap.pieceId}-${idx}`,
        type: piece.type,
        color: piece.color,
        square: cap.square,
      }
    })
    setBurnGhosts(ghosts)
    const timer = window.setTimeout(() => setBurnGhosts([]), 480)
    return () => window.clearTimeout(timer)
  }, [game.fireState.currentTurnIndex, game.pieces, last])

  function navigate(event: KeyboardEvent<HTMLButtonElement>, square: Square) {
    let { file, rank } = square
    switch (event.key) {
      case 'ArrowLeft': file--; break
      case 'ArrowRight': file++; break
      case 'ArrowUp': rank++; break
      case 'ArrowDown': rank--; break
      case 'Home': file = 0; break
      case 'End': file = BOARD_SIZE - 1; break
      default: return
    }
    event.preventDefault()
    const next = squareName({
      file: Math.max(0, Math.min(BOARD_SIZE - 1, file)),
      rank: Math.max(0, Math.min(BOARD_SIZE - 1, rank)),
    })
    setFocusSquare(next)
    squares.current.get(next)?.focus()
  }

  return <div className="board-layout">
    <div className="rank-labels" aria-hidden="true">{ranks.map(rank => <span key={rank}>{rank + 1}</span>)}</div>
    <div className="board" role="group" aria-label="12 by 12 chessboard" onPointerLeave={() => onHover(null)}
      onBlur={event => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) onHover(null)
      }}>
      <div className="board-surface">
        {ranks.flatMap(rank => files.map((_, file) => {
          const square = { file, rank }
          const name = squareName(square)
          const piece = pieceAt(game, square)
          const legal = destinations.get(name)
          const projected = previewCells.get(name)
          const active = activeFire.get(name) ?? []
          const hasWhiteFire = active.some(({ effect }) => effect.owner === 'white')
          const hasBlackFire = active.some(({ effect }) => effect.owner === 'black')
          const imminentFire = active.some(({ remaining }) => remaining === 1)
          const exposed = piece && active.some(({ effect }) => isBurnable(piece, effect.owner) ||
            (piece.type === 'king' && piece.color !== effect.owner))
          const isSelected = sameSquare(selected, square)
          const isChecked = sameSquare(currentKing, square)
          const isLast = sameSquare(last?.from, square) || sameSquare(last?.to, square)
          const isHintFrom = hintSquares ? sameSquare(hintSquares.from, square) : false
          const isHintTo = hintSquares ? sameSquare(hintSquares.to, square) : false
          const className = [
            'square', (file + rank) % 2 === 0 ? 'square-dark' : 'square-light',
            isSelected && 'square-selected', isLast && 'square-last', isChecked && 'square-checked',
            isHintFrom && 'square-hint-from', isHintTo && 'square-hint-to',
            active.length > 0 && 'square-burning',
            hasWhiteFire && 'square-burning-white',
            hasBlackFire && 'square-burning-black',
            imminentFire && 'square-burning-imminent',
            active.length > 1 && 'square-overlap',
            projected && (canceled ? 'preview-canceled' : 'preview-cone'),
            axisNames.has(name) && 'guard-axis', sameSquare(pending, square) && 'square-pending',
          ].filter(Boolean).join(' ')
          const label = [
            name, piece && `${piece.color} ${piece.type}`, isChecked && 'in check',
            legal && (legal.captures ? 'legal capture' : 'legal move'),
            legal?.fireRisk && 'this move loses the piece when fire expires',
            ...active.map(({ effect, remaining }) =>
              `${ownerNames[effect.owner]} fire, ${remaining} ${remaining === 1 ? 'turn' : 'turns'} remaining`),
            exposed && (piece?.type === 'king' ? 'King threatened by active fire' : 'piece at risk from active fire'),
            projected && (canceled
              ? projected.effect === 'shielder' ? 'Shielder blocks the entire fire preview' : 'canceled fire preview'
              : `fire preview${projected.effect === 'threatened' ? ', piece would be exposed' : ''}`),
          ].filter(Boolean).join(', ')

          return <button key={name} type="button" className={className} aria-label={label} aria-pressed={isSelected}
            tabIndex={name === focusSquare ? 0 : -1} data-square={name}
            ref={element => {
              if (element) squares.current.set(name, element)
              else squares.current.delete(name)
            }}
            onFocus={() => { setFocusSquare(name); onHover(square) }}
            onPointerEnter={() => onHover(square)}
            onKeyDown={event => navigate(event, square)}
            onClick={() => onSquare(square)}>
            {legal && <span className={legal.captures ? 'capture-marker' : 'move-marker'} aria-hidden="true" />}
          </button>
        }))}
      </div>

      <div className="pieces-layer" aria-hidden="true">
        {livingPieces.map(piece => {
          const sq = piece.currentSquare!
          const name = squareName(sq)
          const active = activeFire.get(name) ?? []
          const exposed = active.some(({ effect }) => isBurnable(piece, effect.owner) ||
            (piece.type === 'king' && piece.color !== effect.owner))
          const isSelected = sameSquare(selected, sq)
          const isLastMoved = piece.id === lastMovedPieceId
          const actorClass = [
            'piece-actor',
            isSelected && 'piece-actor-selected',
            isLastMoved && 'piece-actor-recent',
            exposed && 'piece-actor-exposed',
          ].filter(Boolean).join(' ')

          return <div
            key={piece.id}
            className={actorClass}
            style={{ transform: `translate3d(${sq.file * 100}%, ${(BOARD_SIZE - 1 - sq.rank) * 100}%, 0)` }}
          >
            <div
              className="piece-ground-shadow"
              ref={el => {
                if (el) shadowRefs.current.set(piece.id, el)
                else shadowRefs.current.delete(piece.id)
              }}
            />
            <div
              className="piece-sprite"
              ref={el => {
                if (el) spriteRefs.current.set(piece.id, el)
                else spriteRefs.current.delete(piece.id)
              }}
            >
              <PieceGlyph type={piece.type} color={piece.color} />
            </div>
          </div>
        })}

        {burnGhosts.map(ghost => (
          <div
            key={ghost.key}
            className="piece-actor piece-burn-ghost"
            style={{ transform: `translate3d(${ghost.square.file * 100}%, ${(BOARD_SIZE - 1 - ghost.square.rank) * 100}%, 0)` }}
          >
            <div className="piece-sprite">
              <PieceGlyph type={ghost.type} color={ghost.color} />
            </div>
          </div>
        ))}
      </div>

      <BoardVfxCanvas game={game} preview={preview} />

      <div className="board-hud-layer" aria-hidden="true">
        {ranks.flatMap(rank => files.map((_, file) => {
          const square = { file, rank }
          const name = squareName(square)
          const piece = pieceAt(game, square)
          const legal = destinations.get(name)
          const projected = previewCells.get(name)
          const active = activeFire.get(name) ?? []
          const exposed = piece && active.some(({ effect }) => isBurnable(piece, effect.owner) ||
            (piece.type === 'king' && piece.color !== effect.owner))
          const showDanger = Boolean(legal?.fireRisk || exposed)
          const showShielder = projected?.effect === 'shielder'
          if (!active.length && !showDanger && !showShielder) return null

          return <div
            key={`hud-${name}`}
            className="hud-cell"
            style={{ transform: `translate3d(${file * 100}%, ${(BOARD_SIZE - 1 - rank) * 100}%, 0)` }}
          >
            {showDanger && <span className="fire-danger">!</span>}
            {showShielder && <span className="preview-shielder">◆</span>}
            {active.length > 0 && <span className="square-fire-badges">
              {active.map(({ effect, remaining }) =>
                <span key={effect.id} className={`fire-badge fire-badge-${effect.owner}`}>
                  {effect.owner === 'white' ? 'W' : 'B'}{remaining}
                </span>)}
            </span>}
          </div>
        }))}
      </div>
    </div>
    <div className="file-labels" aria-hidden="true">{files.map(file => <span key={file}>{file}</span>)}</div>
  </div>
}
