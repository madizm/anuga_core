import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function ParameterHelp({ label, text }: { label: string; text: string }) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, above: false })
  const visible = hovered || focused || pinned
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(240, window.innerWidth - 24)
    const estimatedHeight = 70
    const above = rect.bottom + estimatedHeight + 10 > window.innerHeight
    setPosition({
      left: Math.max(12, Math.min(
        rect.left + rect.width / 2 - width / 2,
        window.innerWidth - width - 12,
      )),
      top: above ? rect.top - 8 : rect.bottom + 8,
      above,
    })
  }, [])

  useEffect(() => {
    if (!visible) return
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [place, visible])

  useEffect(() => {
    if (!pinned) return
    const close = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [pinned])

  return <>
    <button
      ref={buttonRef}
      type="button"
      className="parameter-help-trigger"
      aria-label={`${label}参数说明`}
      aria-describedby={visible ? id : undefined}
      aria-expanded={visible}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        place()
        if (pinned) {
          setPinned(false)
          buttonRef.current?.blur()
        } else setPinned(true)
      }}
      onMouseEnter={() => { place(); setHovered(true) }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => { place(); setFocused(true) }}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        setPinned(false)
        buttonRef.current?.blur()
      }}
    >i</button>
    {visible && createPortal(
      <span
        id={id}
        role="tooltip"
        className={`parameter-tooltip${position.above ? ' above' : ''}`}
        style={{ left: position.left, top: position.top }}
      >{text}</span>,
      document.body,
    )}
  </>
}
