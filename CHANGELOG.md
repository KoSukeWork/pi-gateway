# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- Deferred runtime install failures now include the first load error (for example a missing dependency) instead of reporting only a missing factory, and a factory that already started executing is never re-run.

- Retry transient deferred module imports with bounded backoff and clear failed attempts so later lifecycle events can load the extension.
