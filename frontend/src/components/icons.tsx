/**
 * Shared line-icon set for the Nocturne design system, traced from the Claude
 * Design "GymHelper Screens" reference. Every icon is a 24×24 stroke glyph so
 * they line up in the tab bar, back header, quick-action cards and list rows.
 * `color` follows `currentColor` unless a fill icon needs its own hue.
 */
type IconProps = {
  size?: number
  className?: string
}

function svg(size: number, className: string | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function HomeIcon({ size = 22, className, filled = false }: IconProps & { filled?: boolean }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z" />
      </svg>
    )
  }
  return svg(size, className, <path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1z" />)
}

/** Dumbbell — Train / Training Builder. */
export function DumbbellIcon({ size = 22, className }: IconProps) {
  return svg(size, className, <path d="M6.5 8v8M17.5 8v8M4 10v4M20 10v4M6.5 12h11" />)
}

/** Book — Exercise Library. */
export function BookIcon({ size = 22, className }: IconProps) {
  return svg(
    size,
    className,
    <path d="M4 5.5A1.5 1.5 0 015.5 4H11v16H5.5A1.5 1.5 0 014 18.5zM20 5.5A1.5 1.5 0 0018.5 4H13v16h5.5a1.5 1.5 0 001.5-1.5z" />,
  )
}

/** Leaf — Food tracker. */
export function LeafIcon({ size = 22, className }: IconProps) {
  return svg(size, className, <path d="M12 8c-1.5-4-5-3-6-2-.8 4 2 8 6 12 4-4 6.8-8 6-12-1-1-4.5-2-6 2z" />)
}

/** Rising chart — Progress. */
export function ChartIcon({ size = 22, className }: IconProps) {
  return svg(size, className, <path d="M4 19V5M4 15l5-4 4 3 7-7" />)
}

/** User — Profile. */
export function UserIcon({ size = 22, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </>,
  )
}

export function ChevronLeft({ size = 18, className }: IconProps) {
  return svg(size, className, <path d="M15 18l-6-6 6-6" />)
}

export function ChevronDown({ size = 16, className }: IconProps) {
  return svg(size, className, <path d="M6 9l6 6 6-6" />)
}

/** Solid play triangle for Start buttons. */
export function PlayIcon({ size = 12, className }: IconProps & { color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor" className={className} aria-hidden="true">
      <path d="M3 2l9 5-9 5z" />
    </svg>
  )
}
