/**
 * The `event_types` subset the pilot maps, with SillyTavern 1.18.0's own string
 * values (`public/scripts/events.js` is the source of every literal).
 *
 * Values matter: the upstream bundle compares these strings, and a mapped event
 * whose value drifted from upstream would silently register a handler no
 * emission will ever call. The pilot maps only what its use cases drive (see
 * `notes/st-compat/PILOT-DESIGN.md` §2); an event that is absent here is not
 * "empty", it is unmapped — nothing emits it, and the report's mapping table
 * says so rather than leaving the reader to infer it.
 */
export const event_types = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
} as const

export type StEventType = (typeof event_types)[keyof typeof event_types]
