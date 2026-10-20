# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- PostHog is now detected when it is loaded through a first-party proxy or a renamed loader script (for example `/ph.js` with `api_host` on your own domain); previously such sites were reported as having no analytics.
- A run that finds no analytics at all now says "No analytics detected" and makes no recommendations, instead of inventing consent-mode and `cta_click` advice.
