# AI Development Instructions

## Starting work

1. Read `.ai/PROJECT.md` and `.ai/HANDOFF.md` before development.
2. Check `git status`, recent commits, and relevant source files. Source code and actual test results take precedence over stale notes.
3. Continue from confirmed work; preserve unrelated user changes and existing instructions.

These files are shared project memory for Codex, Claude Code, OpenCode, and Pi Agent. If an agent does not load AGENTS.md automatically, explicitly ask it to read this file. No external memory service is required.

## Development

- Follow existing architecture; prefer focused changes over rewrites.
- Shared editor features should work in both the offline web app and Server Lab unless explicitly scoped otherwise.
- Preserve originals, per-photo edits, metadata, and export/preview consistency.
- Record lasting decisions, significant fixes, and failed approaches in `.ai/PROJECT.md`.
- Never store credentials, tokens, private photo data, or personal infrastructure details in memory files.
- Do not claim testing or deployment unless verified. Distinguish conversation history from current repository evidence.
- A request to change code does not by itself request a push or deployment. Follow the user's current authorization; relevant pushes to main can publish the live site and Docker image.

## Handoff

After each substantial completed task, before switching agents, and at a normal session end, update `.ai/HANDOFF.md` with:

- Date, agent, starting/current commit, and working-tree state.
- Completed work and important files changed.
- Unfinished work, confirmed bugs, and blockers.
- Exact verification commands and observed results; identify anything not tested.
- A concrete next step, or state that there is no pending implementation.

Keep PROJECT.md focused on durable knowledge and HANDOFF.md focused on current progress. Check before removing older findings. An abrupt termination cannot guarantee a final handoff, so checkpoint after substantial tasks.
