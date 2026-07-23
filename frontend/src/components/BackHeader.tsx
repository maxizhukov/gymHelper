import { ChevronLeft } from './icons'

/**
 * The pushed-view header from the design: a circular glass back button and a
 * title. Used wherever a screen is stacked on top of a section root (workout
 * preview, training builder editor, exercise detail) in place of the tab bar.
 */
export default function BackHeader({
  title,
  onBack,
}: {
  title: string
  onBack: () => void
}) {
  return (
    <header className="back-header">
      <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
        <ChevronLeft size={15} />
      </button>
      <span className="back-header-title">{title}</span>
    </header>
  )
}
