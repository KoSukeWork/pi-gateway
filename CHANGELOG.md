# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- Retry transient deferred module imports with bounded backoff and clear failed attempts so later lifecycle events can load the extension.
