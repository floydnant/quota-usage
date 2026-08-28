# Architecture

This document is the shortest path from a fresh checkout to understanding where
a change belongs. User-facing behavior and commands are documented in the
[README](../README.md); implementation and verification procedures are in the
[development guide](development.md).

## Runtime flow

```text
src/cli.ts
  -> ConfigStore loads and validates config.yaml
  -> selectors choose registered accounts
  -> collectUsage coordinates mode, concurrency, fallback, and exit code
       -> CodexAdapter: fresh JSONL app-server child per account
       -> ClaudeLiveAdapter: owned PTY + headless terminal, sequentially
       -> cache: Claude default mode and live-failure fallback
  -> renderHuman or renderJson writes stdout
  -> ProcessTracker cleans every owned process on all exit paths
```

Diagnostics and warnings go to stderr. JSON mode emits exactly one versioned JSON
document to stdout and must never contain progress text or ANSI escapes.

## Module map

| Area           | Primary files                                               | Responsibility                                                                      |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| CLI wiring     | `src/cli.ts`                                                | Commander options and commands, output routing, signal cleanup                      |
| Public model   | `src/types.ts`, `src/errors.ts`                             | Normalized quotas, account/config types, stable error contract                      |
| Configuration  | `src/config.ts`, `src/paths.ts`                             | Strict YAML validation, atomic writes, permissions, canonical paths                 |
| Accounts       | `src/accounts.ts`                                           | Registration, identity setup, Claude collector install/restore, removal/purge       |
| Collection     | `src/collect.ts`, `src/selectors.ts`                        | Selection, concurrency, cache fallback, result sorting, exit aggregation            |
| Process safety | `src/processes.ts`, `src/executable.ts`                     | Executable resolution, scrubbed vendor environments, owned-child lifecycle          |
| Codex          | `src/providers/codex.ts`                                    | JSON-RPC handshake, identity verification, rate-limit normalization, retry boundary |
| Claude cache   | `src/providers/claude-cache.ts`, `src/statusline-helper.ts` | Status-line extraction, chaining, atomic cache updates                              |
| Claude live    | `src/providers/claude-live.ts`                              | PTY loading, terminal negotiation, TUI state detection, `/usage` parsing            |
| Cache          | `src/cache.ts`                                              | Atomic newest-reading writes, freshness and expiration                              |
| Presentation   | `src/render-human.ts`, `src/render-json.ts`                 | Stable human and JSON contracts                                                     |
| Diagnostics    | `src/doctor.ts`, `src/uninstall.ts`                         | Read-only health checks and safe cleanup previews/actions                           |

## Normalized data and errors

Adapters return `AccountResult` with exact provider percentages, derived remaining
percentages, zero or more windows, optional reset/duration/reached fields, plan,
credits, warnings, and a safe attached error. Do not assume only 5-hour and 7-day
windows. Credits are separate from quota percentages.

`collectUsage` owns fallback semantics:

- A successful live result replaces that account's newest cache.
- A failed live refresh may return a still-usable cached result plus the live
  error and `live refresh failed` warning.
- Expired cache is not usable.
- Exit `0` means every requested account is usable, `1` means partial failure,
  and `2` means no usable result. Usage level never affects the exit code.

Add public failure categories only by extending `ERROR_CODES`, documenting the
contract, and testing both JSON and exit-code behavior.

## Provider boundaries

### Codex

Each check starts a fresh absolute `codex app-server` with the registered
`CODEX_HOME`. It performs initialization, `account/read` without forced refresh,
identity-hash comparison, then `account/rateLimits/read`. Startup/transport
failures retry once; authentication, identity, version, timeout, and invalid
response failures do not. At most four Codex accounts run concurrently.

Never reuse or discover another app-server. Plan is display metadata; only the
normalized email hash is an identity boundary.

### Claude cached

Explicit account setup installs a compiled status-line wrapper. The helper keeps
only quota fields, collection time, source, and label; it atomically rejects an
older timestamp overwriting a newer reading. If a prior status-line command
existed, the exact input is chained to it and its visible output is preserved.

Collector restoration is compare-before-write: if the current setting drifted,
do not overwrite it. Return exact manual cleanup guidance instead.

### Claude live

Live mode is experimental and sequential. A fresh `node-pty` runs the absolute
Claude executable with `--ax-screen-reader`; `@xterm/headless` answers terminal
capability queries and supplies user input. The parser uses semantic readiness
and explicit alternate-screen detection, not a fixed startup sleep. First-run,
login, trust, network, update, incomplete, and renamed screens are provider
errors. Raw screen content is bounded in memory and never enters diagnostics.

Two easy-to-miss compatibility details:

1. The `node-pty` macOS `spawn-helper` can lose its executable bit during
   packaging. Live mode repairs it narrowly; `doctor` only reports its state.
2. Claude's normal default state must launch with `CLAUDE_CONFIG_DIR` removed.
   Isolated/managed accounts must launch with their exact canonical directory.

## Local state and permissions

```text
~/.config/usage/config.yaml          0600
~/.config/usage/config.yaml.bak      0600
~/.local/share/usage/                directories 0700
~/.local/share/usage/accounts/       managed vendor state
~/.local/share/usage/bin/            compiled collector and owner-only backups
~/Library/Caches/usage/              cache files 0600
```

Managed purge requires the exact expected path, no symlinks, a matching random
ownership marker, successful official logout, and a collision-safe move to
macOS Trash. External/default state is never purged.

## Packaging

TypeScript compiles to `dist/` with JavaScript, declarations, and source maps.
`dist/` is ignored by Git but is rebuilt by `prepack`; `package.json.files`
restricts the tarball to `dist/`, README, LICENSE, and package metadata. The
packed-artifact test installs the tarball with production dependencies and runs
its generated `usage` binary.
