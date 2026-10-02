import shellBackground from './assets/shell-background.webp'
import css from './Artwork.module.css'

/** Right side of the auth screens: the brand artwork in an inset, rounded shell. */
export function Artwork() {
  return (
    <div className={css.artwork} aria-hidden="true">
      <div className={css.shell}>
        <img className={css.image} src={shellBackground} alt="" draggable={false} />
      </div>
    </div>
  )
}
