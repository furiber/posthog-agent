# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- When a PostHog or Google Analytics tag is found but no events are sent, the report now says so and, if the browser reported it, names the cause: a Content-Security-Policy block (with the blocked URL and directive) or a failing request.

### Fixed

- The "no consent-mode handling" finding is no longer reported on pages where no analytics request fired, since its "beacons fire unconditionally" claim had no evidence.
- PostHog is now detected when it is loaded through a first-party proxy or a renamed loader script (for example `/ph.js` with `api_host` on your own domain); previously such sites were reported as having no analytics.
- A run that finds no analytics at all now says "No analytics detected" and makes no recommendations, instead of inventing consent-mode and `cta_click` advice.
