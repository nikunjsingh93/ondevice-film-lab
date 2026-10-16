# Flashback processing engine

Derived from nikunjsingh93/flashback-raw-editor-web at be2026e3a9dab46b90992f4adeef7108994cc424, a browser port of lofilogic/flashback-raw-editor. Original author: lofilogic. Licensed under GPL-3.0; see COPYING.

Source: https://github.com/nikunjsingh93/flashback-raw-editor-web
Upstream: https://github.com/lofilogic/flashback-raw-editor

Film Lab modifications: relative asset URLs, isolated worker integration, native One35-only decoder, CPU rendering backend, and per-photo mode integration. All engine source, shaders, LUTs and grain assets are distributed here. Gold and Expired Superia are procedural interpretations, as described in core/procedural-luts.js.

The Flashback engine is a separately loaded worker component. Film Lab's existing code retains its license.
