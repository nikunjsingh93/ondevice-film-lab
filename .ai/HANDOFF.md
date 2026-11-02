# Development Handoff

## Last updated

- Date: 2026-11-02 (America/New_York)
- Agent: Codex
- Starting/current HEAD: `6dba506` (shared memory files; previously pushed).
- Working tree was clean before this feature. User authorized committing and pushing all feature changes. See Git history for the resulting commit and remote state.

## Completed

Added imported LUT removal for both OnDevice Film Lab editions. Select a LUT and use the adjacent accessible × button; confirm removal or cancel. No LUT disables the button. Saved recipes can retain the missing content ID, render without the LUT, and regain it if the same file is reimported.

- `index.html`: shared remove UI, IndexedDB deletion, preview refresh and thumbnail cache invalidation based on LUT availability.
- `lab/public/lab-editor.js`: map browser content IDs to server UUIDs; delete server LUTs, await pending imports, and reconcile stale browser copies on startup.
- `lab/server.js`: account-scoped DELETE endpoint removes LUT file and DB record; bridge exposes local deletion. Editor script URL bumped to 1.4.28.
- `sw.js`: cache bumped to v1.10.29.
- `lab/test/lut-removal.test.js`: persistence helper, authenticated API deletion, ownership isolation and cross-device reconciliation tests.
- `lab/test/edited-thumbnails.test.js`: thumbnail invalidation coverage and updated context.
- `lab/test/server.test.js`: updated editor asset version expectation.
- `.ai/PROJECT.md`: recorded LUT management and user preference that future feature requests mean OnDevice Film Lab, not the separate Flashback app.

## Verification

- `npm --prefix lab run check`: passed.
- Parsed all 3 nonempty inline scripts from index.html using Node vm.Script: passed.
- `npm --prefix lab test`: 103 tests passed, 0 failed (outside sandbox to allow local HTTP/file operations).
- Initial sandbox test run failed on local HTTP permissions and file renames. Unsandboxed run resolved these restrictions.
- Initial thumbnail regression failed because its isolated VM lacked the new customLuts dependency; updated its context and added cache invalidation coverage, then suite passed.
- Browser smoke check attempted but did not start: historical temporary Playwright module was unavailable outside the sandbox. No visual browser verification claimed.

## Next steps / limitations

1. Feature implementation is complete locally; no known remaining code blocker. Browser visual checks remain unverified.
2. User requested commit/push and attached the shared-memory setup instructions. Verified AGENTS.md, CLAUDE.md and both memory files already meet that setup; preserved them. Relevant main changes trigger Pages and Docker workflows, then Lab needs image pull/redeploy. Verify workflow results before claiming deployment.
3. Active sessions on another device reconcile server deletions when their editor reloads; no live push synchronization was added.

## Prior baseline

`3409aee` fixed Flashback module caching and moved credits to Settings; `2776946` added edited thumbnails and additional looks. Those features remain intact. The earlier documentation-only task created AGENTS.md, CLAUDE.md and both memory files; commit `6dba506` was pushed with user authorization.
