/**
 * Facade for `scripts/events.js`, served at `<rev>/scripts/events.js`. Upstream
 * re-exports the app's emitter; the kernel's event bus is that emitter here,
 * shared with the script.js facade by construction.
 */

export { eventSource, event_types } from '../kernel-entry.ts'
