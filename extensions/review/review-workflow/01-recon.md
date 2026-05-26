# Stage 1: Recon

Inspect the diff, target files, nearby tests, and relevant project instructions without modifying files. Build a concise Recon memo for later phases:

- changed surfaces and responsibilities
- affected contracts/APIs/config/schema/test behavior
- high-risk files or functions
- existing tests that should protect the change
- review tasks for Hunt

For each material risk area, either create a Hunt task, mark it protected by specific existing tests/checks, or note why it is intentionally not hunted.

Generate narrow Hunt tasks. Each task must have:

- a specific question
- a concrete target anchor: file, function, API, config, schema, or test behavior
- a small scope hint
- evidence the hunter should look for
- why that task matters for this diff

Avoid generic “review everything” tasks.
