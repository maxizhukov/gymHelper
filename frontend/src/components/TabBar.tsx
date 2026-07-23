import {
  ChartIcon,
  DumbbellIcon,
  HomeIcon,
  LeafIcon,
  UserIcon,
} from './icons'

/** The five section roots, in the order the design's bottom tab bar shows them. */
export type Tab = 'home' | 'train' | 'food' | 'progress' | 'profile'

const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'train', label: 'Train' },
  { id: 'food', label: 'Food' },
  { id: 'progress', label: 'Progress' },
  { id: 'profile', label: 'Profile' },
]

function TabIcon({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab) {
    case 'home':
      return <HomeIcon size={23} filled={active} />
    case 'train':
      return <DumbbellIcon size={23} />
    case 'food':
      return <LeafIcon size={23} />
    case 'progress':
      return <ChartIcon size={23} />
    case 'profile':
      return <UserIcon size={23} />
  }
}

/**
 * The persistent liquid-glass bottom navigation shown on every section root.
 * Pushed views (preview, builder editor, exercise detail) hide it and show a
 * back header instead, matching the design.
 */
export default function TabBar({
  active,
  onSelect,
}: {
  active: Tab
  onSelect: (tab: Tab) => void
}) {
  return (
    <nav className="tabbar" aria-label="Main navigation">
      {TABS.map((tab) => {
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            className={`tabbar-item${isActive ? ' is-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelect(tab.id)}
          >
            <TabIcon tab={tab.id} active={isActive} />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
