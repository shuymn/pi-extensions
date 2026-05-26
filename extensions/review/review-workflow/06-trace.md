# Stage 6: Trace

For each remaining confirmed or likely actionable item from Dedupe, trace whether it matters in the current codebase without modifying files:

- Is the code path reachable?
- Which callers, tests, commands, UI paths, or configs are affected?
- Is it production code, generated code, test-only code, or dead code?
- Does the issue cross a public API/contract boundary?
- Is the suggested fix necessary now, or should it be skipped with a clear reason?

For each item, record the trace status, checked paths/callers/tests/configs, and the proceed-or-skip reason. Only proceed to fixes for findings that are confirmed or likely, deduplicated, trace-relevant, and worth changing.
