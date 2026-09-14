/**
 * Facade for `scripts/power-user.js`, served at `<rev>/scripts/power-user.js`.
 * The extension reads `power_user.persona_description_lorebook` to decide
 * whether the persona's bound book joins the WI scan; the pilot hydrates no
 * persona book, so the name stays empty.
 */

export const power_user: {
  persona_description_lorebook: string
  [key: string]: unknown
} = {
  persona_description_lorebook: '',
}
