# Flashback processing engine

Derived from nikunjsingh93/flashback-raw-editor-web at be2026e3a9dab46b90992f4adeef7108994cc424, a browser port of lofilogic/flashback-raw-editor. Original author: lofilogic. Licensed under GPL-3.0; see COPYING.

Source: https://github.com/nikunjsingh93/flashback-raw-editor-web
Upstream: https://github.com/lofilogic/flashback-raw-editor

Film Lab modifications: relative asset URLs, isolated worker integration, native One35-only decoder, CPU rendering backend, and per-photo mode integration. All engine source, shaders, LUTs and grain assets are distributed here. Gold and Expired Superia are procedural interpretations, as described in core/procedural-luts.js.

The Flashback engine is a separately loaded worker component. Film Lab's existing code retains its license.

## Additional One35-Local looks

Atlas decoding and the Monochrome, Cine and DMG formulas were adapted from https://github.com/nikunjsingh93/One35-Local at 0c34223246b7775f4c756cc83cd45a0e43149b9c (GPL-3.0). Cine and DMG are local interpretations. Classic, Beta, Gold, Retro Haze and Dispo use the camera PNG colour atlases from that repository. Those manufacturer assets retain their original rights and are **not** relicensed under GPL or MIT. See the source project CREDITS.md for their provenance.
