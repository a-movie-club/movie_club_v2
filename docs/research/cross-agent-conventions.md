# Research: cross-agent convention formats (Claude Code + OpenAI Codex)

**Issue:** [#5](https://github.com/Foifoif/movie_club_v2/issues/5) · Part of [#1](https://github.com/Foifoif/movie_club_v2/issues/1)
**Date:** 2026-08-28
**Question:** What is the smallest convention layer that *both* Claude Code and OpenAI Codex reliably read?

**Sources:** official Anthropic Claude Code docs (`code.claude.com/docs`), official OpenAI Codex docs
(`learn.chatgpt.com/docs`, canonical aliases under `developers.openai.com/codex`), the Agent Skills
specification site (`agentskills.io`), and the first-party `openai/codex` repository. No blogs, no
secondary summaries. Anything not confirmed against one of those is listed under
[Unverified](#unverified--flagged).

---

## TL;DR

1. **The working hypothesis is broadly right, but the current repo is broken.** `movie_club_v2` has
   `AGENTS.md` and **no `CLAUDE.md` at all** — so Claude Code today reads *nothing* in this repo.
   `movie-club` (v1) has the mirror-image bug: `CLAUDE.md` and no `AGENTS.md`, so Codex reads nothing there.
2. **Claude Code does not read `AGENTS.md`.** This is stated flatly in the docs. It needs a
   `CLAUDE.md` that imports it (`@AGENTS.md`) or a symlink.
3. **Nested per-feature `AGENTS.md` is not worth writing.** Codex only walks *root → your current
   working directory* at session start; it never descends into subdirectories as work moves there.
   A root-launched Codex session will never see `src/features/movies/AGENTS.md`. This is an
   acknowledged open gap (`openai/codex#12115`, still OPEN).
4. **Codex now has real skills** — `.agents/skills/<name>/SKILL.md`, built on the same
   [agentskills.io](https://agentskills.io) standard Claude Code uses. Codex's own custom-prompt
   slash commands are *deprecated in favour of skills*. This is the big change since the hypothesis
   was written: prose in `AGENTS.md` is **not** the whole Codex surface any more.
5. **The Agent Skills spec standardises the file, not the folder.** `SKILL.md` content is portable;
   `.claude/skills/` vs `.agents/skills/` is not. The shim is a **directory symlink**, not a copy —
   which means zero drift without any generator.

---

## 1. What OpenAI Codex reads for project instructions

### Confirmed: `AGENTS.md` at the repo root

> "Codex reads `AGENTS.md` files before doing any work."
> — <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
> (canonical alias: <https://developers.openai.com/codex/guides/agents-md>)

### Full discovery + merge order

Per the same page:

1. **Global scope:** `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`.
2. **Project scope:** starting at the **Git root**, walk *toward* the current directory. In each
   directory: `AGENTS.override.md` first, then `AGENTS.md`, then any name listed in
   `project_doc_fallback_filenames`. **At most one file per directory.**
3. **Merge:** > "Codex concatenates files from the root down, joining them with blank lines. Files
   closer to your current directory override earlier guidance because they appear later in the
   combined prompt."
4. If `AGENTS.override.md` exists in a directory, the sibling `AGENTS.md` is ignored at that level.
5. Empty files are skipped; loading stops at `project_doc_max_bytes` (**32 KiB default**).

Independently confirmed in first-party source — module doc comment of
<https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs>:

> "1. Determine the project root by walking upwards from the current working directory until a
> configured `project_root_markers` entry is found… (default `.git`).
> 2. Collect every `AGENTS.md` found from the project root down to the current working directory
> (inclusive) and concatenate their contents in that order.
> 3. We do **not** walk past the project root."

Relevant config keys (<https://learn.chatgpt.com/docs/config-file/config-reference>), settable in
`~/.codex/config.toml` or a project-scoped `.codex/config.toml` (project config loads only when the
project is trusted):

| Key | Meaning |
|---|---|
| `project_root_markers` | "List of project root marker filenames" (default `.git`) |
| `project_doc_max_bytes` | "Maximum bytes read from AGENTS.md" (default 32768) |
| `project_doc_fallback_filenames` | "Additional filenames to try **when AGENTS.md is missing**" |

### CRITICAL: does Codex load nested `AGENTS.md` when working in a subdirectory?

**No — not in the sense that matters here.**

Nested `AGENTS.md` files are supported, but only along the path **from the Git root down to the
directory Codex was launched in**, and the set is resolved at session start (see
`load_project_instructions` in `agents_md.rs`, which assembles first-turn instructions).

The docs are explicit that discovery *terminates* at the CWD:

> "Codex stops searching once it reaches your current directory, so place overrides as close to
> specialized work as possible."
> — <https://learn.chatgpt.com/docs/agent-configuration/agents-md>

So for a contributor who runs `codex` at the repo root — which is what our less-technical
collaborators will do — **`src/features/movies/AGENTS.md` is never loaded**, no matter how many files
Codex edits in that directory. It only loads if they `cd src/features/movies && codex`.

This is a known, still-open gap. `openai/codex#12115` — *"Dynamically loading nested AGENTS.md"*,
**state: OPEN** as of 2026-08-28 — carries this canonical problem statement:

> "Codex should officially load nested AGENTS.md files on demand as work moves into deeper subtrees
> from repo-root sessions, with deterministic deeper-over-shallower instruction behavior and
> visibility into active instruction files."
> — <https://github.com/openai/codex/issues/12115>

An open feature request asking for on-demand nested loading is direct evidence that it does not
exist today.

**Beware the spec site here — it oversells this.** <https://agents.md/> says:

> "Large monorepo? Use nested AGENTS.md files for subprojects. Place another AGENTS.md inside each
> package. Agents automatically read the nearest file in the directory tree, so the closest one takes
> precedence."

Read casually, that implies an agent picks up the nearest file *as it works*. It doesn't, in Codex:
"nearest in the directory tree" is resolved relative to the launch directory, once. The spec describes
an aspiration; `agents_md.rs` and issue #12115 describe the implementation. Trust the implementation.

**Contrast with Claude Code, which *does* do this** (see §3). The two tools differ precisely on the
capability that would justify per-feature convention files.

---

## 2. Does Codex have a skill / slash-command / reusable-prompt equivalent?

**Yes. Codex has first-class skills, and they are the recommended surface.** This is the finding that
most changes the picture versus the hypothesis.

### Codex skills

Source: <https://learn.chatgpt.com/docs/build-skills> (alias <https://developers.openai.com/codex/skills>)

> "Skills build on the [open agent skills standard](https://agentskills.io)."

Layout is the standard one:

```
my-skill/
├── SKILL.md      (required)
├── scripts/      (optional)
├── references/   (optional)
├── assets/       (optional)
└── agents/openai.yaml  (optional, Codex-specific)
```

Discovery scopes, quoted from the docs' table:

| Scope | Location |
|---|---|
| `REPO` | `$CWD/.agents/skills` |
| `REPO` | `$CWD/../.agents/skills` (a folder above CWD, inside a Git repo) |
| `REPO` | **`$REPO_ROOT/.agents/skills`** — "The topmost root folder… These serve as root skills available to **any subfolder** in the repository." |
| `USER` | `$HOME/.agents/skills` |
| `ADMIN` | `/etc/codex/skills` |
| `SYSTEM` | bundled with Codex (e.g. `skill-creator`) |

Invocation: explicit via `$skill-name` in the Codex CLI / IDE extension (`@skill-name` in ChatGPT), or
implicit — "ChatGPT or Codex can choose a skill when your task matches the skill `description`".

**This is the important asymmetry:** repo-root `.agents/skills` is available to *any* subfolder,
whereas a nested `AGENTS.md` below the CWD is not loaded at all. **In Codex, a root-level skill is the
working mechanism for per-feature conventions; a nested `AGENTS.md` is not.**

### Codex custom prompts are deprecated

> "Custom prompts are deprecated. Use skills for reusable instructions that Codex can invoke
> explicitly or implicitly."
> — <https://learn.chatgpt.com/docs/custom-prompts>

They lived in `$CODEX_HOME/prompts/` (default `~/.codex/prompts/`), were `.md` only, were
machine-local (never shared through a repo), and surfaced as `/prompts:<name>`. Not a candidate for a
committed convention layer, and now superseded.

Built-in Codex slash commands (`/init`, `/plan`, `/review`, `/memories`, `/import`, …) are listed at
<https://learn.chatgpt.com/docs/reference/slash-commands>; none are user-definable.

**So: prose in `AGENTS.md` is *not* the entire Codex surface. Codex has `AGENTS.md` + skills, exactly
mirroring Claude Code's `CLAUDE.md` + skills.**

---

## 3. Does Claude Code read `AGENTS.md`?

**No.** Directly quoted from <https://code.claude.com/docs/en/memory> (the current URL; the old
`docs.claude.com/en/docs/claude-code/memory` 301s here):

> "**Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** If your repository already uses `AGENTS.md`
> for other coding agents, create a `CLAUDE.md` that imports it so both tools read the same
> instructions without duplicating them. You can also add Claude-specific instructions below the
> import. Claude loads the imported file at session start, then appends the rest:"

```markdown
@AGENTS.md

## Claude Code

Use plan mode for changes under `src/billing/`.
```

> "A symlink also works if you don't need to add Claude-specific content:"
> ```bash
> ln -s AGENTS.md CLAUDE.md
> ```
> "On Windows, creating a symlink requires Administrator privileges or Developer Mode, so use the
> `@AGENTS.md` import instead."

Verification step given in the docs: run `/context` and confirm `CLAUDE.md` appears under **Memory files**.

### Claude Code memory locations (load order, broadest → most specific)

| Scope | Location |
|---|---|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS) / `/etc/claude-code/CLAUDE.md` / `C:\Program Files\ClaudeCode\CLAUDE.md` |
| User | `~/.claude/CLAUDE.md` |
| Project | `./CLAUDE.md` **or** `./.claude/CLAUDE.md` |
| Local | `./CLAUDE.local.md` (gitignore it) |

### Nested memory files: YES, and on demand

> "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your current working directory and every
> directory above it… All discovered files are **concatenated into context rather than overriding
> each other**. Across the directory tree, content is ordered from the filesystem root down to your
> working directory."

> "Claude also discovers `CLAUDE.md` and `CLAUDE.local.md` files in **subdirectories** under your
> current working directory. Instead of loading them at launch, they are **included when Claude reads
> files in those subdirectories**."

That is exactly the capability Codex lacks. Claude Code additionally has a *better* mechanism than
nested files — `.claude/rules/` with glob-scoped frontmatter:

```markdown
---
paths:
  - "src/features/**/*.ts"
---
```

> "Rules can be scoped to specific files using YAML frontmatter with the `paths` field… Path-scoped
> rules trigger when Claude reads files matching the pattern."

Rules without `paths` load at launch with the same priority as `.claude/CLAUDE.md`.
**There is no Codex equivalent of `.claude/rules/`** — path/glob-scoped instruction loading is an open
enterprise request on the Codex side (referenced as CEF-650 in `openai/codex#12115`).

Other Claude Code specifics worth knowing:

- Imports use `@path/to/file`, relative to the importing file, max **4 hops** deep. Imported content
  loads at launch and costs the same context as inlining it.
- Backtick-wrapped `` `@README` `` is *not* treated as an import.
- Target **under 200 lines** per `CLAUDE.md`; files over 4 MiB are skipped entirely.
- Block-level HTML comments in `CLAUDE.md` are stripped before injection — free maintainer notes.
- Project-root `CLAUDE.md` is re-read from disk after `/compact`; nested files reload as Claude reads
  files they apply to.
- `claudeMdExcludes` (glob, any settings layer) skips unwanted ancestor memory files.
- `/init` generates a starting `CLAUDE.md`. With `CLAUDE_CODE_NEW_INIT=1` it also reads `AGENTS.md`,
  `.cursor/rules/`, `.windsurf/rules/`, `.clinerules`, `.devin/rules/`.
- `/import` (v2.1.213+) "appends a **one-time copy** of instruction files such as `AGENTS.md` to the
  matching `CLAUDE.md`". One-time — this is a drift source, not a solution.

---

## 4. Precedence: what wins when both `AGENTS.md` and `CLAUDE.md` exist?

**Neither. They are mutually invisible by default.** There is no contest to adjudicate:

| | reads `AGENTS.md` | reads `CLAUDE.md` |
|---|---|---|
| **Claude Code** | ✗ never, unless imported/symlinked from `CLAUDE.md` | ✓ natively |
| **Codex** | ✓ natively | ✗ never, unless added to `project_doc_fallback_filenames` — and that only fires **when `AGENTS.md` is missing** in that directory |

Consequences:

- If both files exist with *different* content, each agent silently obeys a different rulebook and
  nobody gets an error. This is the single most dangerous configuration and it is exactly what the
  two repos are currently one step away from.
- Making `CLAUDE.md` a **symlink to, or a one-line `@AGENTS.md` import of,** `AGENTS.md` eliminates
  the divergence structurally.
- Going the other direction (`project_doc_fallback_filenames = ["CLAUDE.md"]` in `.codex/config.toml`)
  is a worse deal: it inverts the hierarchy, only triggers on an *absent* `AGENTS.md`, and depends on
  the project being trusted. Don't.

Within each tool, precedence is:

- **Claude Code:** concatenation, root → CWD, then `CLAUDE.local.md` after `CLAUDE.md` at each level;
  managed policy loads first and cannot be excluded. Conflicting instructions are not resolved —
  "if two rules contradict each other, Claude may pick one arbitrarily."
- **Codex:** concatenation, Git root → CWD, later (deeper) wins by virtue of appearing later in the
  prompt; `AGENTS.override.md` beats `AGENTS.md` within a directory; hard stop at
  `project_doc_max_bytes`.

Both tools state that these files are **context, not enforcement**. Claude Code says so explicitly:
"Claude treats them as context, not enforced configuration. To block an action regardless of what
Claude decides, use a PreToolUse hook instead." This validates the map's standing principle — *if a
convention can be a lint rule, it must be a lint rule.*

---

## 5. The Agent Skills format, and whether there is a shared standard

**There is a real, live cross-vendor standard, and both our tools are on it.**

<https://agentskills.io>:

> "The Agent Skills format was originally developed by [Anthropic](https://www.anthropic.com/),
> released as an open standard, and has been adopted by a growing number of agent products."

Claude Code (<https://code.claude.com/docs/en/skills>):

> "Claude Code skills follow the [Agent Skills](https://agentskills.io) open standard, which works
> across multiple AI tools. Claude Code extends the standard with additional features…"

Codex (<https://learn.chatgpt.com/docs/build-skills>):

> "Skills build on the [open agent skills standard](https://agentskills.io)."

The client showcase on agentskills.io lists Claude Code, ChatGPT & Codex, Cursor, Gemini CLI, GitHub
Copilot, VS Code, JetBrains Junie, OpenCode, Goose, Amp, Kiro, Roo Code, Factory, and ~30 more.

### What the spec actually pins down

<https://agentskills.io/specification>:

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/  references/  assets/   # Optional
```

| Field | Required | Constraint |
|---|---|---|
| `name` | Yes | ≤64 chars, lowercase `a-z0-9-`, no leading/trailing/consecutive hyphens, **must match the parent directory name** |
| `description` | Yes | ≤1024 chars; says what it does *and when to use it* |
| `license` | No | |
| `compatibility` | No | ≤500 chars |
| `metadata` | No | string→string map |
| `allowed-tools` | No | space-separated; **experimental**, support varies |

Progressive disclosure: name+description at startup (~100 tokens), full body on activation
(<5000 tokens recommended, keep `SKILL.md` under 500 lines), bundled files on demand.

A reference validator exists: `skills-ref validate ./my-skill`
(<https://github.com/agentskills/agentskills/tree/main/skills-ref>) — a plausible CI gate.

### The catch: the spec standardises the *file*, not the *folder*

The specification says **nothing** about on-disk discovery locations. There is no mention of
`.claude/skills` or `.agents/skills` anywhere in it. Each client picks its own directory:

| | Project/repo skills | Personal skills |
|---|---|---|
| **Claude Code** | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| **Codex** | `.agents/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` |

Cross-reading was checked, not assumed:

- GitHub code search over `openai/codex` for `.claude/skills` → **0 results**. Codex does not read
  Claude's skills directory.
- The Claude Code skills docs enumerate skill locations exhaustively (personal / project / plugin /
  enterprise / `--add-dir` / claude.ai-synced) and `.agents/skills` is not among them.

### Claude-only frontmatter — know where the line is

Claude Code accepts spec fields plus its own extensions (`paths`, `disable-model-invocation`,
`argument-hint`, `allowed-tools`/`disallowed-tools` semantics, subagent execution, dynamic context
injection). Outside Claude Code — claude.ai uploads, the Skills API, `package_skill.py` — only the six
spec fields validate, and an extension key produces:

> `Unexpected key(s) in SKILL.md frontmatter: argument-hint. Allowed properties are: allowed-tools, compatibility, description, license, metadata, name`

> "Claude Code accepts all six fields, so frontmatter that follows the spec loads in Claude Code
> without changes."

**Practical rule: write skills with spec-only frontmatter and they load unmodified in both tools.**
The moment you reach for `paths:` or `disable-model-invocation:`, you have written a Claude-only skill.

Also relevant to nesting: Claude Code loads project skills from `.claude/skills/` in the start
directory and every parent up to the repo root, and nested skills below the start directory load on
demand once Claude touches a file in that subdirectory (namespaced `/apps/web:deploy` on collision).
So **root-level skills work from any subdirectory in both tools** — the one place the two agree
cleanly.

---

## 6. Can shims be generated so they cannot drift?

Ranked by how hard they are to break.

### Tier 1 — structurally impossible to drift (use these)

1. **`CLAUDE.md` = `@AGENTS.md` import.** One line, documented by Anthropic, and leaves room for a
   Claude-only section below. Preferred here, because we *do* have Claude-only content (the
   `/grilling`, `/domain-modeling`, `/research`, `/prototype`, `/wizard` skills named in the map are
   Claude Code slash-skills that Codex cannot invoke by those names).
2. **`ln -s AGENTS.md CLAUDE.md`.** Documented; zero drift; but leaves no room for Claude-only
   content and needs Developer Mode on Windows. Fallback, not first choice.
3. **Skill directory symlinks.** From the Claude Code skills docs:
   > "A `<skill-name>` entry in the enterprise, personal, or project locations can be a symlink to a
   > directory elsewhere on disk. Claude Code follows the symlink and reads `SKILL.md` from the target
   > directory, and if the same target is reachable from more than one location, Claude Code loads the
   > skill once."

   So `.claude/skills/<name>` → `../../.agents/skills/<name>` gives one canonical skill body with a
   Claude-side shim that cannot go stale, and no generator to maintain. *(The reverse direction —
   whether Codex follows symlinks under `.agents/skills` — is **unverified**; see below. Point the
   symlink from `.claude/` at the `.agents/` original, not vice versa.)*

### Tier 2 — one-time copies (these are the drift)

4. **Claude Code `/import`** (v2.1.213+) — "appends a **one-time copy** of instruction files such as
   `AGENTS.md` to the matching `CLAUDE.md`", plus MCP servers, commands, subagents, skills.
5. **Codex `/import`** (<https://learn.chatgpt.com/docs/import>) — imports Claude Code / Cursor
   instruction files *into* `AGENTS.md`, skills, slash commands (as skills), project memories, MCP
   config, hooks, and recent chats. Confirmed in first-party source: the
   `codex-rs/external-agent-migration` crate has dedicated Claude (`Cla`) and Cursor (`Cur`) sources.

   The doc offers "turn on automatic updates to keep imported work in sync with the original agent",
   which *sounds* like continuous sync, but the mechanism and direction are not spelled out — see
   [Unverified](#unverified--flagged). Do not build our convention layer on it.

### Tier 3 — generate

No first-party tool generates per-agent convention shims from neutral docs. Third-party generators
exist but are out of scope for a primary-source ticket and would be one more thing to maintain.
**They are also unnecessary**: Tier 1 reduces the entire shim surface to two symlinks/imports, which
is less machinery than any generator.

If a CI check is wanted (consistent with the map's lint-rule principle), the cheap version is a
script that asserts:
- `CLAUDE.md` exists and its first non-blank line is `@AGENTS.md`;
- every directory in `.agents/skills/` has a matching entry in `.claude/skills/` that is a symlink to it;
- `skills-ref validate` passes for each skill;
- no `AGENTS.md` exists anywhere except the repo root.

---

## 7. What this repo actually has today

`movie_club_v2` (root):

```
AGENTS.md                      1584 bytes — workflow + "Agent skills" index
docs/agents/domain.md
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

`movie-club` (v1, `../movie-club`):

```
CLAUDE.md                      373 bytes — same "Agent skills" index shape
docs/agents/domain.md          (identical trio)
docs/agents/issue-tracker.md
docs/agents/triage-labels.md
```

Findings:

- **`movie_club_v2` has no `CLAUDE.md` — not empty, absent.** Claude Code currently loads no project
  memory in this repo at all. Everything in `AGENTS.md` (branch-first, PR-per-issue, never commit to
  `main`) is invisible to the agent that Jacob drives. This is a live bug, not a hypothetical.
- **`movie-club` v1 has no `AGENTS.md`** — Codex loads nothing there. Exact mirror image.
- The `docs/agents/*.md` split is sound and both tools can use it, but note that `AGENTS.md`
  references those files as **plain prose** ("See `docs/agents/issue-tracker.md`"). That is a pointer,
  not an import: Codex will not auto-load them, and Claude Code will not either without `@`. They are
  read only if the agent chooses to open them. That's acceptable for reference material, and is
  actually the *right* call for context economy — but it should be a deliberate choice, and the
  wording in `AGENTS.md` should tell the agent to read them rather than merely mention they exist.
- `docs/agents/domain.md` instructs agents to read `CONTEXT.md`, `CONTEXT-MAP.md`, and `docs/adr/`.
  None of those exist in `movie_club_v2` yet. The doc handles this ("If any of these files don't
  exist, proceed silently"), so no action needed — noting it for the map's benefit.
- Neither repo has any `.claude/skills/` or `.agents/skills/` directory yet.

---

## RECOMMENDATION

### The exact file list

| # | File | Read by | Loaded when | Contents |
|---|---|---|---|---|
| 1 | **`AGENTS.md`** (repo root) | **Codex** natively; **Claude Code** via #2 | Every session, both tools | The single canonical convention index. Workflow rules, settled stack invariants, and pointers into `docs/agents/*.md`. Keep under ~200 lines (Claude's guidance) and far under 32 KiB (Codex's hard cap). Everything neutral goes here. |
| 2 | **`CLAUDE.md`** (repo root) | **Claude Code** only | Every Claude session | Three lines. `@AGENTS.md`, then a `## Claude Code` heading, then the Claude-only bits — e.g. "consult `/grilling` and `/domain-modeling` on every ticket". **Never** duplicate a rule from `AGENTS.md` here. |
| 3 | **`docs/agents/*.md`** (existing) | Both | On demand, when the agent opens them | Neutral long-form reference: `domain.md`, `issue-tracker.md`, `triage-labels.md`, plus future `conventions.md`. Auto-loaded by neither tool — `AGENTS.md` must instruct the agent to *read* them, not just note they exist. |
| 4 | **`.agents/skills/<name>/SKILL.md`** | **Codex** natively; **Claude Code** via #5 | Progressive disclosure — `description` at startup, body on match | The canonical home for every procedural/multi-step convention. **Spec-only frontmatter** (`name`, `description`). Root-level, so it reaches every subdirectory in *both* tools. |
| 5 | **`.claude/skills/<name>` → symlink to `../../.agents/skills/<name>`** | **Claude Code** only | Same as #4 | A symlink, not a copy. Documented as followed by Claude Code. Write a *real* `SKILL.md` here only when the skill genuinely needs Claude-only frontmatter (`paths:`, `disable-model-invocation:`) or Claude-only body features. |

Optional, later, Claude-only:

| # | File | Notes |
|---|---|---|
| 6 | `.claude/rules/<topic>.md` with `paths:` frontmatter | The best per-path mechanism that exists, but **Claude Code only** — no Codex counterpart. Use it only for genuinely Claude-specific enforcement reminders, never as the home of a shared convention, or the two collaborator groups diverge. |

### Do not write

- **Nested per-feature `AGENTS.md`.** Codex won't load it from a root-launched session
  (`openai/codex#12115` open), and Claude Code won't read `AGENTS.md` at any depth. Zero readers.
- **Nested per-feature `CLAUDE.md`.** Claude Code *would* load it on demand — but it is invisible to
  Codex, which splits the rulebook between the two collaborator groups. That is the one failure mode
  this whole ticket exists to prevent.
- **`.codex/config.toml` with `project_doc_fallback_filenames = ["CLAUDE.md"]`.** Inverts the
  hierarchy, only fires when `AGENTS.md` is absent, and requires the project to be trusted.
- **Duplicated prose in both `AGENTS.md` and `CLAUDE.md`.** Silently divergent rulebooks, no error.

### Is nesting worth it?

**No — nested *instruction files* are not worth it. Use a root-level skill instead.**

| Mechanism | Claude Code | Codex |
|---|---|---|
| Nested instruction file below CWD | ✓ loads on demand when Claude reads a file there | ✗ **never loads** from a root-launched session |
| Path/glob-scoped rules | ✓ `.claude/rules/` with `paths:` | ✗ no equivalent |
| **Root-level skill** | ✓ `.claude/skills/` at root, available everywhere | ✓ `.agents/skills/` at root, "available to any subfolder" |

Root-level skills are the *only* row where both tools say yes. A per-feature convention should
therefore be a skill whose `description` names the feature ("Use when working on the movies data
layer under `src/features/movies/`"), living once in `.agents/skills/` and symlinked into
`.claude/skills/`. Both tools progressive-disclose it; neither pays context for it until it matters;
there is exactly one copy on disk.

### Immediate action (outside this ticket's scope, but it is a live bug)

Create `CLAUDE.md` at the root of `movie_club_v2`. Until it exists, Claude Code obeys none of the
workflow rules in `AGENTS.md` — including "never commit directly to `main`".

### Standing caveat

Both `AGENTS.md` and `CLAUDE.md` are *context*, not configuration. Anthropic states it outright:
"Claude treats them as context, not enforced configuration." Every convention in this layer that
*can* be a lint rule, a type, or a CI gate should be one; this layer carries only the "why" and the
genuine judgment calls. That is the map's standing principle and nothing found here weakens it.

---

## Unverified / flagged

Stated explicitly, per the `/research` discipline:

1. **Whether Codex follows symlinks under `.agents/skills/`.** Not documented, and not established
   from source in the time available. Mitigation: point the symlink from `.claude/skills/` at the
   `.agents/skills/` original (that direction *is* documented on the Claude side), so a Codex symlink
   limitation would never bite. If it later turns out Codex does follow symlinks, the choice of
   canonical directory becomes free.
2. **Codex `/import` "automatic updates".** <https://learn.chatgpt.com/docs/import> says "turn on
   automatic updates to keep imported work in sync with the original agent", but does not state the
   direction, trigger, or whether it is genuinely continuous. Not relied on in the recommendation.
3. **Whether Codex re-reads `AGENTS.md` mid-session** (e.g. after an edit, or on `/compact`). The
   source path examined assembles first-turn instructions; nothing was found either way about
   re-reading. Claude Code's behaviour here *is* documented (project-root `CLAUDE.md` is re-read after
   `/compact`).
4. **Codex skill precedence across scopes** (REPO vs USER vs ADMIN vs SYSTEM on a name collision).
   The docs list the scopes but the conflict-resolution order was not stated on the page fetched.
   Claude Code's is documented ("enterprise overrides personal, and personal overrides project").
   Unlikely to matter for a three-person hobby repo.
5. **Claude Code reading `.agents/skills/`.** Concluded *negative from absence* — the skills docs
   enumerate locations exhaustively and `.agents/` is not among them — rather than from an explicit
   denial. Confidence high but not a direct quote.
6. **Third-party shim generators** (e.g. rule-syncing tools). Deliberately not researched: the ticket
   restricts to primary sources, and the Tier 1 symlink/import approach makes a generator unnecessary.
7. **Volatility warning.** Codex skills, `.agents/skills`, the `agentskills.io` standard, and Codex's
   deprecation of custom prompts are all recent. Everything above reflects docs fetched **2026-08-28**.
   Re-check §2 and §5 before treating them as settled six months from now.

---

## Sources

Anthropic / Claude Code (primary):
- <https://code.claude.com/docs/en/memory> — memory files, `AGENTS.md` stance, nested loading, imports, rules
- <https://code.claude.com/docs/en/skills> — Agent Skills format, locations, frontmatter, nesting, symlinks

OpenAI / Codex (primary):
- <https://learn.chatgpt.com/docs/agent-configuration/agents-md> (alias <https://developers.openai.com/codex/guides/agents-md>) — `AGENTS.md` discovery, merge order, overrides, limits
- <https://learn.chatgpt.com/docs/build-skills> (alias <https://developers.openai.com/codex/skills>) — Codex skills, `.agents/skills`, scopes, invocation
- <https://learn.chatgpt.com/docs/custom-prompts> — deprecation of custom prompts
- <https://learn.chatgpt.com/docs/config-file/config-reference> — `project_doc_max_bytes`, `project_doc_fallback_filenames`, `project_root_markers`
- <https://learn.chatgpt.com/docs/reference/slash-commands> — built-in commands
- <https://learn.chatgpt.com/docs/import> — importing from Claude Code / Cursor

First-party repositories:
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs> — discovery algorithm in source
- <https://github.com/openai/codex/issues/12115> — open request for on-demand nested `AGENTS.md`
- <https://github.com/openai/codex/tree/main/codex-rs/external-agent-migration> — Claude Code / Cursor import implementation
- <https://github.com/agentskills/agentskills> — Agent Skills standard repo and `skills-ref` validator

Standard:
- <https://agents.md/> — AGENTS.md format and nesting guidance
- <https://agentskills.io> — Agent Skills overview, origin, adopters
- <https://agentskills.io/specification> — the format specification
