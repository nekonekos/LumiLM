import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes
} from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-hover border border-transparent',
  secondary:
    'bg-surface-3 text-fg hover:bg-surface-2 border border-border hover:border-border-strong',
  soft: 'bg-brand-soft text-brand border border-transparent hover:brightness-105',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-3 hover:text-fg border border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 border border-transparent'
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-[8px]',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-sm gap-2 rounded-[12px]',
  icon: 'h-8 w-8 rounded-[9px] justify-center'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center font-medium transition-colors select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
}

export function IconButton({ label, active, className, children, ...rest }: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] border border-transparent',
        'text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg',
        active && 'bg-brand-soft text-brand',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export function Spinner({ className }: { className?: string }): ReactNode {
  return (
    <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
  className?: string
}): ReactNode {
  const tones = {
    neutral: 'bg-surface-3 text-fg-muted border-border',
    brand: 'bg-brand-soft text-brand border-transparent',
    success: 'bg-surface-3 text-success border-border',
    warning: 'bg-surface-3 text-warning border-border',
    danger: 'bg-surface-3 text-danger border-border'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function ProgressBar({ value, className }: { value: number; className?: string }): ReactNode {
  const percent = Math.max(0, Math.min(1, value)) * 100
  return (
    // Note: no `w-full` in the base classes. `cn` is a plain joiner rather than a
    // tailwind-merge, so a hardcoded width would fight the caller's own width
    // utility and win depending on stylesheet order. A block-level element
    // already fills its container, so omitting the width is a safe default.
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-surface-3', className)}>
      <div
        className="h-full rounded-full bg-brand transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-fg-subtle">{hint}</span> : null}
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        checked ? 'border-transparent bg-brand' : 'border-border-strong bg-surface-3',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block size-3.5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        )}
      />
    </button>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  disabled?: boolean
}): ReactNode {
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      className={cn(
        'h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none',
        '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2',
        '[&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-brand',
        '[&::-webkit-slider-thumb]:shadow'
      )}
      style={{
        background: `linear-gradient(to right, var(--color-brand) ${percent}%, var(--color-surface-3) ${percent}%)`
      }}
    />
  )
}

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

const OPTION_HEIGHT_PX = 34
const MAX_LIST_HEIGHT_PX = 240

/** Moves `index` in `direction`, skipping disabled options. */
function stepOption<T extends string | number>(
  options: Array<SelectOption<T>>,
  index: number,
  direction: 1 | -1
): number {
  for (let next = index + direction; next >= 0 && next < options.length; next += direction) {
    if (!options[next]?.disabled) return next
  }
  return index
}

interface PopupBox {
  top: number
  left: number
  width: number
  maxHeight: number
}

/**
 * Custom listbox. The native `<select>` popup is drawn by the operating system
 * and cannot be themed, so the trigger and the option list are rendered here.
 *
 * The list is portalled to `document.body` and positioned from the trigger's
 * bounding box, because an in-flow popup would be clipped by the scrolling
 * panels the selects usually live in.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  className
}: {
  value: T
  options: Array<SelectOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<PopupBox | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  const measure = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const listHeight = Math.min(MAX_LIST_HEIGHT_PX, options.length * OPTION_HEIGHT_PX + 8)
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < listHeight + 8 && rect.top > spaceBelow

    setBox({
      top: openUp ? Math.max(8, rect.top - listHeight - 4) : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: listHeight
    })
  }, [options.length])

  useEffect(() => {
    if (!open) return

    measure()

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      close()
    }

    // `capture` so scrolling inside the surrounding panels is observed too.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [open, measure, close])

  // Keep the highlighted option inside the scrollable list.
  useEffect(() => {
    if (!open) return
    const element = listRef.current?.children[activeIndex]
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const openList = useCallback(() => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }, [selectedIndex])

  const commit = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          openList()
          return
        }
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((index) => stepOption(options, index, direction))
        return
      }
      case 'Home':
        if (open) {
          event.preventDefault()
          setActiveIndex(stepOption(options, -1, 1))
        }
        return
      case 'End':
        if (open) {
          event.preventDefault()
          setActiveIndex(stepOption(options, options.length, -1))
        }
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (open) commit(activeIndex)
        else openList()
        return
      case 'Escape':
        if (open) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        return
      case 'Tab':
        close()
        return
      default:
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex h-8 w-full items-center gap-1.5 rounded-[9px] border bg-surface px-2.5 text-left',
          'text-sm text-fg transition-colors hover:border-border-strong',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open ? 'border-brand' : 'border-border',
          className
        )}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? ''}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && box
        ? createPortal(
            <div
              ref={listRef}
              role="listbox"
              style={{
                position: 'fixed',
                top: box.top,
                left: box.left,
                width: box.width,
                maxHeight: box.maxHeight
              }}
              className={cn(
                'lm-fade-in z-[60] overflow-y-auto rounded-[10px] border border-border',
                'bg-surface p-1 shadow-[var(--shadow-pop)]'
              )}
            >
              {options.map((option, index) => {
                const isSelected = index === selectedIndex
                const isActive = index === activeIndex
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-sm',
                      'transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      isActive ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected ? <Check className="size-3.5 shrink-0 text-brand" /> : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
}

export function TextInput({ className, invalid, ...rest }: TextInputProps): ReactNode {
  return (
    <input
      className={cn(
        'h-8 rounded-[9px] border bg-surface px-2.5 text-sm text-fg placeholder:text-fg-subtle',
        'outline-none transition-colors',
        invalid ? 'border-danger' : 'border-border hover:border-border-strong focus:border-brand',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...rest}
    />
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>
}

export function TextArea({ className, ref, ...rest }: TextAreaProps): ReactNode {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[80px] w-full resize-y rounded-[10px] border border-border bg-surface px-2.5 py-2',
        'font-mono text-xs leading-relaxed text-fg placeholder:text-fg-subtle',
        'outline-none transition-colors hover:border-border-strong focus:border-brand',
        className
      )}
      {...rest}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({
  value,
  tabs,
  onChange
}: {
  value: T
  tabs: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): ReactNode {
  return (
    <div className="flex gap-1 rounded-[11px] bg-surface-3 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'flex-1 rounded-[8px] px-3 py-1.5 text-xs font-medium transition-colors',
            value === tab.value
              ? 'bg-surface text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
              : 'text-fg-muted hover:text-fg'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-2xl'
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    },
    [onClose]
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'var(--color-scrim)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'lm-fade-in flex max-h-[86vh] w-full flex-col overflow-hidden rounded-[16px]',
          'border border-border bg-surface shadow-[var(--shadow-pop)]',
          width
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-fg">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-xs leading-snug text-fg-muted">{description}</p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <h3 className={cn('mb-2 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase', className)}>
      {children}
    </h3>
  )
}

export function EmptyHint({ children }: { children: ReactNode }): ReactNode {
  return <p className="px-1 py-6 text-center text-xs text-fg-subtle">{children}</p>
}
