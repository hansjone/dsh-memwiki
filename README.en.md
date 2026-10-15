# dsh-memwiki

A shared memory wiki for multiple AI agents: an Obsidian-compatible Markdown vault plus an MCP server. DeepSeek Harness (DSH), Claude Code, Codex, and Cursor all read/write through the same MCP; humans use Obsidian or VS Code.

Design contract: [docs/DESIGN.md](docs/DESIGN.md).

## Install

```bash
npm install -g dsh-memwiki
```

Initialize a vault:

```bash
dsh-memwiki init ~/memwiki
```

## Connect clients

Every client runs Node on this package’s `lib/cli.js serve` with `MEMWIKI_AGENT` / `MEMWIKI_DIR`.

```bash
dsh-memwiki setup claude   # or codex / cursor / dsh — print only
dsh-memwiki setup claude --write   # merge-write; originals backed up as .bak
```

| Client | Where | agent |
|---|---|---|
| Claude Code | user MCP + `~/.claude/settings.json` SessionStart hook | `claude` |
| Codex | `~/.codex/config.toml` `[mcp_servers.memwiki]` | `codex` |
| Cursor | `~/.cursor/mcp.json` `mcpServers.memwiki` | `cursor` |
| DSH | `dsh plugin add` mounts `cordis.patch.yml`; customize via `$DSH_HOME/cordis.patch.yml` | `dsh` |

Optional skill:

```bash
dsh-memwiki install-skill
```

## Configuration

Precedence: CLI > env > vault `memwiki.json` `settings` > defaults.

| Setting | CLI | Env | Default |
|---|---|---|---|
| Vault dir | `--dir` | `MEMWIKI_DIR` | `~/memwiki` |
| Writer ID | `--agent` | `MEMWIKI_AGENT` | `agent` |
| Auto-commit | `--no-git` | `MEMWIKI_GIT=0` | on if vault is a git repo |
| Auto-push | `--push` / `--no-push` | `MEMWIKI_GIT_PUSH=1` | off |
| Context budget (bytes) | `--budget` | `MEMWIKI_CONTEXT_BUDGET` | 4096 |
| Stale days | — | vault settings | 90 |
| Secret scan | — | vault settings | on |
| Similar-create threshold | — | `settings.similarCreateThreshold` | 0.72 |
| Body overlap threshold | — | `settings.overlapThreshold` | 0.70 |

## MCP tools

| Tool | Purpose |
|---|---|
| `memwiki_context` | Compact catalog (session start) |
| `memwiki_search` | Full-text search |
| `memwiki_read` | Read page (rev, backlinks, broken links) |
| `memwiki_write` | Write (create/replace/append/edit/section/meta); similar creates require justified force |
| `memwiki_remember` | Quick inbox capture + related pages |
| `memwiki_move` | Rename/move and rewrite links |
| `memwiki_merge` | Merge into one owner, rewrite links, retain source redirects; optional body/meta and required target rev |
| `memwiki_verify` | Refresh verified date and restore stale to active, without rev |
| `memwiki_feedback` | add/list/resolve monthly tool and rule feedback |
| `memwiki_usage` | Local event counts and Top 10 zero-result queries |
| `memwiki_delete` / `memwiki_restore` | Trash / restore |
| `memwiki_lint` | Health check, including overlap/fact_repeat/feedback_open; those three cannot be auto-fixed |
| `memwiki_log` | Recent changes |

Prompts: `memwiki-ingest`, `memwiki-lint`, `memwiki-curate` (converge content, verify, archive inbox, report feedback and usage; no code changes). The vault's `_guide` is the single source of detailed rules; the skill and server instructions are summaries.

## CLI

```text
dsh-memwiki init [dir]
dsh-memwiki serve
dsh-memwiki context [--project <name>]
dsh-memwiki search <query>
dsh-memwiki read <page>
dsh-memwiki lint [--fix]
dsh-memwiki merge <from>... --into <page> --rev <rev> --reason <why> [--body-file <md>] [--meta-file <json>]
dsh-memwiki verify <page> [--note <note>]
dsh-memwiki usage [--days 7]
dsh-memwiki feedback list [--all]
dsh-memwiki reindex
dsh-memwiki sync
dsh-memwiki setup <claude|codex|cursor|dsh> [--write]
dsh-memwiki install-skill [--target ...]
```

`sync` pulls with rebase+autostash then pushes; on conflict aborts rebase, lists files, exits non-zero.

## Vault format

Markdown + YAML frontmatter + `[[wikilinks]]`. Layout: [docs/DESIGN.md](docs/DESIGN.md) §2–§3. Do not hand-edit generated `index.md` / `log.md`.

## FAQ

**CONFLICT**: Re-`memwiki_read` for a fresh `rev`, then write again.

**SIMILAR_EXISTS**: Read up to three candidates and update an existing page. Use `force: true` only for a distinct topic with a nonempty reason, preserved verbatim in the log. Inbox capture is exempt.

**Maintenance**: One fact has one owner; correct existing pages before adding information. Supply the consolidated merge body yourself and confirm all unique information is retained before removing source content. Sources remain superseded redirects; git retains the original text. Repeated fact tokens are advisory; IP addresses in reference links can be normal.

**Feedback and usage**: Monthly feedback pages live in `meta/feedback/YYYY-MM.md` (type=meta); context shows only the open count. Git-ignored `.memwiki/usage.jsonl` rotates at 1 MB, keeping one previous file. Signals contain event counts, redacted queries and hashed page IDs, never page bodies, write reasons or credential values.

**SECRET_DETECTED**: Key-like content rejected; store where to get secrets, not the secrets.

**Multi-machine**: Shared git remote + `autoPush` or periodic `sync`.

**External edits**: Watched; committed as `[external] …` after ~60s debounce.

**DSH cannot find cli.js**: Run `dsh-memwiki setup dsh` and merge the printed absolute-path entry into `$DSH_HOME/cordis.patch.yml`.

## DSH settings

After installing the plugin, open Settings → 记忆库 on desktop to save the vault directory and auto-push preference, inspect vault status and recent changes, and run read-only health checks. The credential section supports adding, updating, deleting, and viewing access logs. Values are hidden by default; clicking 显示 reveals one credential for 10 seconds and records the view in the access log without the value. Switching settings sections or losing window focus hides it immediately. While visible, you can copy the value; after 30 seconds the clipboard is cleared only if it can be read and still contains that value. Settings are saved to `~/.dsh/dsh-memwiki.json`; restart DSH after saving.
