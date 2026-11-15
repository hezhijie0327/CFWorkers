# AGENTS.md

Cloudflare Workers scripts — each worker lives in its own directory with a `worker.js` and a per-worker `wrangler.jsonc`.

## HANDOVER.md

When a multi-step task is interrupted, write progress to `HANDOVER.md` so the next session can pick up where you left off. Include: what was done, what remains, key decisions made, and the next concrete step. Delete the file when the task is complete.

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

**Additional rules:**
- Be concise in output but thorough in reasoning.
- Do not re-read files you have already read.
- User instructions always override this file.
- Don't wrestle with indentation in the Edit tool — focus on logic, let the project's formatter fix formatting. Use `sed` or `python3` freely when the Edit tool struggles with whitespace.

## Git commit convention

Every commit subject starts with a type prefix — `feat` / `fix` / `chore` / `docs` / `revert` / `refactor` / `perf` / `test` / `build` — optionally scoped: `fix(toolbar): ...`. Subject: imperative, lowercase start, no trailing period, aim ≤ 72 chars; detail goes in the body after a blank line (why, not what); breaking changes take `!` before the colon or a `BREAKING CHANGE:` body footer. Never rewrite pushed history.

- Commit incrementally — one logical change per commit, after lint and tests pass. Present changes for review before committing.
- PRs: link the issue, summarize the change and verification (tests/benchmarks), and include config/log/pprof evidence for bug fixes.

### Co-Author Format

- Always add co-author information. If closing an issue in commit text, verify against `main` first: `gh issue view <issue-id>`.
- Only ONE co-author line is allowed. If multiple agents contributed, aggregate into ONE entry.

Format: `Co-authored-by: <AgentName> <Email>`

Valid examples (choose EXACTLY ONE):

```
Co-authored-by: ZCode <noreply@z.ai>
```

Every commit subject starts with a type prefix — `feat` / `fix` / `chore` / `docs` / `refactor` / `perf` / `test` / `build` — optionally scoped: `fix(proxy): ...`. Subject: imperative, lowercase start, no trailing period, aim ≤ 72 chars; detail goes in the body after a blank line (why, not what); breaking changes take `!` before the colon or a `BREAKING CHANGE:` body footer.

## Documentation format

Family-wide Markdown rules, shared verbatim across all ZJ projects:

- **Language**: AGENTS.md, AUDIT.md, DESIGN.md and other agent-facing docs are English; README.md is Chinese (human-facing). Keep literal UI strings and code identifiers verbatim.
- **AGENTS.md skeleton** — generic sections first, then project; omit sections that don't apply, keep the order:
  `# AGENTS.md` → 1–2 sentence intro (what the project is + key doc links) → Behavioral Guidelines → Git commit convention → Documentation format → Project → Commands → Architecture → Conventions (Gotchas as a subsection) → project-specific sections → Key Docs.
- **README.md skeleton**: `# <project>` → one-line positioning + stack + key links → 特性 → 快速开始 → 配置 / 用法 → 文档 → License (omit as needed).
- **Formatting**: ATX headings (`#`), never skip a level; code fences always carry a language tag (`bash`, `go`, `json`, `text` for trees); tables for structured reference; no decorative emoji in headings or bullets; bold for key terms only.

## Project

This repository contains Cloudflare Workers scripts for various purposes. Each worker lives in
its own directory with a `worker.js` and a per-worker `wrangler.jsonc`:
- workers/container-proxy/worker.js: Container registry proxy for Docker, GCR, etc.
- workers/reverse-proxy/worker.js: General reverse proxy

## Commands

This is a pure JavaScript project with no build system. Each worker is a standalone script.
Biome (pinned in devDependencies) enforces the formatting rules below; run `pnpm install` first.
`wrangler` is also a devDependency - use `pnpm wrangler …` (its version pins the safe
compatibility_date ceiling and the local dev runtime).

### Lint & Format

```bash
pnpm run lint       # Biome check (formatter + linter), same gate as CI
pnpm run lint:fix   # apply safe fixes and formatting
```

### Type Check

```bash
pnpm run typecheck  # tsc --noEmit over workers/ (same gate as CI)
```
Worker files are plain JavaScript; JSDoc annotations plus `tsconfig.json` (checkJs, strict,
`@cloudflare/workers-types`) give editors and CI real runtime types without a build step.

### Compatibility Date

```bash
pnpm run bump-compat  # set compatibility_date in workers/*/wrangler.jsonc to the latest wrangler release date
```
The safe maximum is the release date of the latest wrangler on npm (a date must not exceed
the wrangler used to deploy; Cloudflare Builds deploys with the latest wrangler). Run it
periodically, review `git diff`, then commit. Plain Node script, same command in any shell.

### Testing

Audit-grade protocol testing runs against local `wrangler dev` instances - see
[AUDIT.md](AUDIT.md) for the full playbook (matrices, gates, environment traps).
Quick reference:

```bash
node scripts/audit-container-unit.mjs   # container-proxy unit audit (no server needed)
node scripts/audit-upstream.mjs         # deterministic upstream harness on :8901
pnpm wrangler dev --config workers/reverse-proxy/wrangler.jsonc --port 8788
node scripts/audit-reverse-e2e.mjs      # reverse-proxy E2E vs the harness
pnpm wrangler dev --config workers/container-proxy/wrangler.jsonc --port 8787
node scripts/audit-container-e2e.mjs    # container-proxy E2E vs real registries
```

Unreachable-upstream full chains (Docker Hub, github.com) run under
`scripts/dev-via-proxy.mjs`, which routes the worker's outbound `fetch()` through
Node so `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` apply - workerd itself ignores
proxy env entirely. The runner accepts any worker directory argument.

- Browser shim assertions: open
  `http://127.0.0.1:8788/http://127.0.0.1:8901/shim-test` (16 in-page checks).
- All audit scripts are plain Node.js with zero dependencies; exit 1 = failure.
- Cache-behavior assertions require a fresh dev instance (hot reload poisons the
  local Cache API - AUDIT.md §10); clear `workers/*/.wrangler` and restart first.

### Deployment

Each worker directory has its own `wrangler.jsonc` (adjust `name` to the worker name on your
account). Deploy from the repo root or from inside the worker directory:
```bash
wrangler deploy --config workers/container-proxy/wrangler.jsonc
wrangler deploy --config workers/reverse-proxy/wrangler.jsonc
```

## Conventions

### General Formatting

Enforced by Biome (see `biome.json`); the config matches these rules:
- Use 4 spaces for indentation (not tabs)
- Keep lines under 120 characters when possible
- No trailing whitespace
- End files with a newline

### Import/Export Patterns

- No ES6 modules - use vanilla JavaScript
- All functions are defined in the global scope
- No runtime dependencies - Cloudflare Workers provides built-in APIs; devDependencies
  are tooling only (Biome, TypeScript, @cloudflare/workers-types)
- Workers secrets go in bindings (e.g. `env.GITHUB_TOKEN` via `wrangler secret put`),
  never in source

### Naming Conventions

- Functions: camelCase (e.g., `handleRequest`, `fetchHandler`)
- Variables: camelCase (e.g., `urlObj`, `targetUrl`)
- Constants: UPPER_SNAKE_CASE for immutable values (e.g., `domainMapping`)
- File names: lowercase with no spaces (e.g., `container.js`, `ddns.js`)

### Function Structure

- All main handlers are async functions
- Keep functions focused on a single responsibility
- Use descriptive function names that explain their purpose
- Add version comments at the top of each file

### Error Handling

- Use try-catch blocks for all async operations
- Return meaningful error responses with appropriate HTTP status codes
- Include error messages in JSON responses for debugging
- Log errors using console.error when appropriate
- Example error response:
```javascript
return new Response(JSON.stringify({ error: error.message }), {
  status: 500,
  headers: { 'Content-Type': 'application/json; charset=utf-8' }
})
```

### Response Patterns

- Always set appropriate Content-Type headers
- Include CORS headers for cross-origin requests:
```javascript
'Access-Control-Allow-Headers': '*',
'Access-Control-Allow-Methods': '*',
'Access-Control-Allow-Origin': '*'
```

- Use consistent response structure for JSON responses
- Return appropriate HTTP status codes (400, 401, 404, 500, etc.)

### URL and Request Handling

- Always parse URLs using the URL constructor
- Extract query parameters using URL.searchParams
- Handle request headers appropriately, filtering Cloudflare-specific headers when proxying
- Preserve request method and body when forwarding requests

### Comments and Documentation

- Add version and description comment at the top of each file
- Keep comments concise and focused on explaining "why" not "what"
- No inline comments for self-evident code

### Performance Considerations

- Minimize memory usage in edge environments
- Use appropriate caching headers (typically `Cache-Control: no-store` for dynamic content)
- Avoid unnecessary operations in the request path

### Security Best Practices

- Never expose sensitive information in responses
- Validate and sanitize all inputs
- Use appropriate authentication mechanisms
- Filter headers when proxying requests to avoid exposing Cloudflare metadata

### Code Organization

- Main entry point: addEventListener for 'fetch' events
- Helper functions placed after main handler
- Constants defined at the top of functions
- Group related functionality together

When making changes:
1. Follow the existing patterns in each file
2. Test manually by deploying to a staging environment
3. Ensure backward compatibility when modifying existing functionality
4. Update version comments when making significant changes
