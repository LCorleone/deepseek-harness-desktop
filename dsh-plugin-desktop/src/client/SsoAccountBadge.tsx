// Authenticated-account badge for the sidebar footer slot. When a locked
// `requireSso` build passed the startup gate, the Electron Host injects the
// account email into the renderer URL (`dsh-desktop-account`), and this
// occupant renders it as a persistent, muted footer row — the in-app share
// of the "corner shows who is signed in" confirmation, beside the native
// tray row and the window-title suffix.
//
// The seat is upstream ui-sidebar's documented `sidebar.footer.action` list
// slot (see packages/client/ui-sidebar/src/client/contract/slots.ts: entries
// render above Settings at the sidebar foot in both widths, each receiving
// only the column's `wide` state). List kind means coexistence by design:
// unlike the single-kind brand-name cell, this registration cannot collide
// with any other occupant at the default priority, so it registers plainly.

/** Owner share of one `sidebar.footer.action` entry. */
export interface SsoAccountBadgeProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  readonly wide: boolean
  /** Account email to display; the caller guarantees presence when mounted. */
  readonly email: string
}

// Mirrors the muted foreground the host sidebar uses for secondary text so
// the badge reads as part of the foot row in both themes without inventing a
// new token; the rail glyph keeps the same quiet color.
const RAIL_SIZE = 18

/**
 * Render the authenticated-account badge: the full email in the wide column,
 * a compact person glyph in the collapsed rail (the full text would not fit
 * the 56px rail and truncation would defeat the confirmation purpose — the
 * tray row and window title carry the full email on rail builds).
 */
export function SsoAccountBadge({ wide, email }: SsoAccountBadgeProps): JSX.Element {
  if (!wide) {
    return <svg
      aria-label={email}
      height={RAIL_SIZE}
      role="img"
      style={{ color: 'var(--dsw-alias-label-secondary, #9aa0a6)', display: 'block' }}
      viewBox="0 0 24 24"
      width={RAIL_SIZE}
    >
      <title>{email}</title>
      <path
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-2.67 0-8 1.34-8 4v1c0 .55.45 1 1 1h14c.55 0 1-.45 1-1v-1c0-2.66-5.33-4-8-4Z"
        fill="currentColor"
      />
    </svg>
  }
  return <span
    style={{
      color: 'var(--dsw-alias-label-secondary, #5f6368)',
      display: 'block',
      fontSize: 12,
      lineHeight: '28px',
      maxWidth: '100%',
      overflow: 'hidden',
      padding: '0 12px',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
    title={email}
  >{email}</span>
}

/**
 * Build the slot occupant for one authenticated account: the registration
 * helper lives in a `.ts` module (client/index.ts), so the JSX component is
 * constructed here instead of inline at the registration site.
 */
export function ssoAccountBadgeOccupant(
  email: string,
): (props: { readonly wide: boolean }) => JSX.Element {
  return function SsoAccountBadgeOccupant({ wide }: { readonly wide: boolean }): JSX.Element {
    return <SsoAccountBadge email={email} wide={wide} />
  }
}
