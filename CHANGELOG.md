# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- Deferred runtime install failures now include the first load error (for example a missing dependency) instead of reporting only a missing factory, and a factory that already started executing is never re-run.
- Deferred loading is preserved: startup events (resources_discover, project_trust) are registered only when the bootstrap declares startupEvents, and factory on()/registerCommand() registrations commit only after the factory completes.
- Deferred session_start replay now uses the latest event received while an asynchronous factory is installing, and replay handlers stay uncommitted until the pending event is drained so events arriving mid-replay cannot overtake the replayed one.
- Deferred command handlers and completions are committed only after the factory installs successfully; stale completions are removed on command replacement.
- Deferred `resources_discover` now participates in Pi's first resource discovery (returned skill/prompt/theme paths are aggregated), session_start replay runs only after the factory completes with async handlers awaited, the warmup timer is cancelled on session_shutdown, and all Pi 0.84.3 extension events are classified as replay or blocking.

- Retry transient deferred module imports with bounded backoff and clear failed attempts so later lifecycle events can load the extension.
