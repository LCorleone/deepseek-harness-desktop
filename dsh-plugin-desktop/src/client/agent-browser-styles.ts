/**
 * Styles for the agent-browser client surfaces (the conversation banner and
 * the compact tool cards), installed independently of presentation mode.
 *
 * These rules live in their own installer — NOT in styles.ts's
 * ADVANCED_STYLES — because that sheet only loads with the advanced shell,
 * while the banner (conversation.input.dock) and the tool cards
 * (tool.call.toolview) are registered from client apply() and render in
 * compatibility mode too. The installer is called from the same mode-neutral
 * apply() path, so both shells see the styles.
 *
 * Every color rides the upstream --dsw-alias-* / --dsw-specific-* theme
 * aliases (light and dark resolve themselves); the banner's column geometry
 * rides the --dsh-composer-* variables upstream's ConversationRoot declares
 * on the dock slot's ancestor in both modes.
 */

const STYLE_ID = 'dsh-agent-browser-styles'

const CSS = `
/* Banner: one quiet status pill in the composer context stack — the
   GoalBar/TodoPanel/QueueDock dock family (card minus four insets,
   centered) — so the live browser surface reads as part of the input zone
   without competing with the input card. */
.dshAgentBrowserBanner {
  box-sizing: border-box;
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  min-height: 32px;
  margin: 0 auto;
  padding: 4px 6px 4px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-specific-tip);
}
/* Label keeps the dock-card title family (13/24 medium, primary). */
.dshAgentBrowserBannerLabel {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
/* The URL is the payload: mono, small, fill with ellipsis (the span's title
   attribute carries the full URL on hover). */
.dshAgentBrowserBannerUrl {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Generation · phase stays a weak trailing annotation. */
.dshAgentBrowserBannerMeta {
  flex: none;
  font-size: 12px;
  line-height: 24px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
/* Ghost action (the plugin's settings-button family): hairline pill that
   only fills on hover, so the button never outweighs the input card. */
.dshAgentBrowserBannerAction {
  flex: none;
  height: 24px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 22px;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.dshAgentBrowserBannerAction:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshAgentBrowserBannerAction:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshAgentBrowserBannerAction:disabled { cursor: default; opacity: .55; }
/* While the operator holds control the release affordance carries a light
   business accent — a state change that reads without shouting. */
.dshAgentBrowserBanner[data-phase='claimed'] .dshAgentBrowserBannerAction {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
/* Tool card: the ToolRow 24px single-line family — title in secondary, the
   mono URL fills and ellipsizes, the detail trails in tertiary (error rows
   swap it to the error color, mirroring ToolRow's failure summary). */
.dshAgentBrowserToolCard {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 24px;
  font-size: 14px;
  line-height: 24px;
}
.dshAgentBrowserToolCardLabel {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dshAgentBrowserToolCardUrl {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshAgentBrowserToolCardDetail {
  flex: none;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshAgentBrowserToolCard[data-failed='true'] .dshAgentBrowserToolCardDetail {
  color: var(--dsw-alias-state-error-primary);
}
`

/** Install one scoped stylesheet; tolerate headless Client boot. */
export function installAgentBrowserStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
