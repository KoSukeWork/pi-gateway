# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Rebuild the chat reply lifecycle around one persistent reply, serialized/coalesced preview edits, task phases, elapsed time, and reliable final delivery. Dialogs resume the same reply instead of creating extra thinking placeholders.
- Follow the Hermes Discord patterns of in-place streaming previews, final-only overflow delivery, and processing/completion reactions. Preserve fenced code and Unicode across final chunks, retain status in oversized previews, and report partial delivery to the user.
- Complete deferred Discord slash responses and replace model/resume pickers with their outcome. Add `/help`, `/stop`, owner-bound Stop buttons, and native input/editor modals.
- Bind permission buttons to their request, channel, message, and owner; record answered/cancelled/expired status. Cancel even prompts whose send is still in flight, and reject stale IDs without answering newer questions.
- Reserve the shared RPC worker before asynchronous preparation. Only the initiating user/channel may steer; other chats and session changes receive an explicit busy response.
- Back default channel conversations with distinct persistent Pi session files, restore their history when switching channels, and give `/new` a fresh history.

### Fixed
- Preserve full streamed text on empty/suffix-only terminal events, display model output-limit warnings, and retain complete extension display content even when widgets are cleared. Route editor-text events instead of dropping them.
- Complete attachment fallbacks through the deferred Discord original response. Prefer full text attachments above eight chunks; fall back to complete text when attachment permission is unavailable, and retry explicitly rejected reply references without their anchor.
- Preserve input whitespace and long permission context, accept pending answers without another mention, prevent prompts after cancellation during context delivery, and enforce channel/role restrictions for slash and component entry points.
- Preserve extended code fences and complete language strings, respect Discord's retry-after duration, and avoid resending a successful reply when obsolete-continuation cleanup fails. Free-text dialog answers are no longer written to logs.
- Register prompt completions before sending RPC commands, so an ACK and terminal event in one stdout chunk cannot strand a thinking message. Propagate model errors and process exits, clear request timers, and settle active replies during shutdown.
- Keep old RPC process exits from clearing a replacement worker's state. Close inline gateway resources when the host session shuts down.
- Scope Discord resume choices to each displayed message instead of interpreting old indices against a newer list. Enforce picker ownership and expiry.
- Handle guild nickname mentions and replies to the bot; suppress automatic mentions in generated messages and retry transient idempotent edits.

## [1.16.7] - 2026-09-07

### Fixed
- Isolate Discord model pickers by message and owner, enforce expiry, preserve case and `/` characters in model IDs, and use typed select-menu components.
- Tear down Discord heartbeat/socket state on fatal closes, reset heartbeat cadence after server requests, and report the actual WebSocket connection state.
- Restart daemon resources in-process instead of self-signalling on Windows.
- Retry rate-limited Discord edits and avoid duplicating already delivered chunks when a later overflow message fails.
- Close SQLite stores on extension shutdown so isolated Windows tests and reloads release their files.

## [1.16.6] - 2026-09-07

### Changed
- Discord `/model` now uses a provider dropdown, then a model dropdown (25 per page with Back/Prev/Next), instead of a wall of text.

## [1.16.5] - 2026-09-07

### Fixed
- Discord Gateway now resumes sessions, honors opcode 7/9, ACKs heartbeats, and clears heartbeat timers on reconnect so the bot does not drop hourly.

## [1.16.4] - 2026-09-06

### Fixed
- Retry Discord 429s using `retry_after` and pause between split messages so a large `/model` catalog is not dropped as "Failed to retrieve model list."

## [1.16.3] - 2026-09-06

### Fixed
- Discord `/model` now sends the full text catalog instead of a 5-button keyboard, so NewAPI model lists are no longer truncated.

## [1.16.2] - 2026-09-06

### Fixed
- Discord replies over 2000 characters are split instead of being dropped. Message edits now fail on Discord API errors (with a new-message fallback), RPC stdout uses a streaming UTF-8 decoder, and unparseable RPC lines are logged at warn.

## [1.16.1]

### Fixed
- Deferred runtime install failures now include the first load error (for example a missing dependency) instead of reporting only a missing factory, and a factory that already started executing is never re-run.
- Deferred loading is preserved: startup events (resources_discover, project_trust) are registered only when the bootstrap declares startupEvents, and factory on()/registerCommand() registrations commit only after the factory completes.
- Deferred session_start replay now uses the latest event received while an asynchronous factory is installing, and replay handlers stay uncommitted until the pending event is drained so events arriving mid-replay cannot overtake the replayed one.
- Deferred command handlers and completions are committed only after the factory installs successfully; stale completions are removed on command replacement.
- Deferred `resources_discover` now participates in Pi's first resource discovery (returned skill/prompt/theme paths are aggregated), session_start replay runs only after the factory completes with async handlers awaited, the warmup timer is cancelled on session_shutdown, and all Pi 0.84.3 extension events are classified as replay or blocking.

- Retry transient deferred module imports with bounded backoff and clear failed attempts so later lifecycle events can load the extension.
