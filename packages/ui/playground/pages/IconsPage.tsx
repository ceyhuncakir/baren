import * as UI from '../../src/icons/icons'
import { Lucide, TextAaIcon, type IconComponent } from '../../src/icons'
import { Page, Section } from '../kit'

const designIcons = Object.entries(UI).filter(
  (entry): entry is [string, IconComponent] =>
    entry[0].endsWith('Icon') && entry[0] !== 'TextAaIcon' && typeof entry[1] === 'function',
)

export function IconsPage() {
  return (
    <Page title="Icons">
      <Section title={`Design icons (${designIcons.length + 1}) — exact paths from the artboards`}>
        <div className="pg-icon-grid">
          {designIcons.map(([name, Icon]) => (
            <div key={name} className="pg-icon">
              <Icon size={16} />
              {name}
            </div>
          ))}
          <div className="pg-icon">
            <TextAaIcon size={15} />
            TextAaIcon
          </div>
        </div>
      </Section>
      <Section title="Sizes used in the designs (ClockIcon)">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {[10, 11, 12, 13, 14, 15, 16, 22].map((s) => (
            <UI.ClockIcon key={s} size={s} />
          ))}
        </div>
      </Section>
      <Section title="Lucide namespace (everything else)">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Lucide.Bell size={16} strokeWidth={1.75} />
          <Lucide.Star size={16} strokeWidth={1.75} />
          <Lucide.Bookmark size={16} strokeWidth={1.75} />
          <Lucide.Cloud size={16} strokeWidth={1.75} />
        </div>
      </Section>
    </Page>
  )
}
