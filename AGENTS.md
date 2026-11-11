# agent-bridge development conventions

- Node.js 22+ / TypeScript ESM; src/core contains agent-neutral logic, src/adapters owns native decoding.
- Tests are synthetic, isolated in OS temporary directories; never read/write user agent session roots in tests.
- No model calls, credential copying, tool replay, plugin execution, or changes to existing workspaces during import.
- Prepared handoff is PREPARED, never READY. Unknown native compatibility must not be labeled supported.
- All writes use exclusive creation, atomic publication and validation. Do not overwrite user files.
- Native event graph and effective model context are different; preserve provenance and never silently drop semantic events.
- Run npm run check before reporting implemented features as passing.
