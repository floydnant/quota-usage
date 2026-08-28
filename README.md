# quota-usage

`quota-usage` is a macOS command-line tool that reports ChatGPT Codex and Claude Code subscription quota windows across multiple locally registered accounts. The executable is named `usage`.

It reports subscription allowance usage, reset times, plan metadata, and provider-supplied credits. It does **not** report API billing, API spend, token costs, or API rate limits. High usage and reached limits are information only; there are no thresholds and no `check` command.

## Requirements

- macOS on Apple Silicon or Intel
- Node.js 22 or newer
- The official `codex` and/or `claude` CLI for the providers you use
- Codex CLI 0.150.1 or newer
- Claude Code 2.1.238 or newer for multi-account setup and experimental live collection

The Codex protocol was verified against Codex CLI 0.150.1. Claude cached and live behavior was verified against Claude Code 2.1.247; this project retains 2.1.238 as the safe minimum for multi-account operations.

## Install

After the package is published:

```sh
npm install --global quota-usage
usage --help
```

From a local checkout:

```sh
npm install
npm run build
npm link
usage --help
```

The npm package ships compiled JavaScript, source maps, declarations, this README, and the license. TypeScript and a development runner are not needed after installation.

## Set up accounts

Accounts are independent provider registrations. Labels are unique within a provider and use lowercase ASCII letters, digits, underscores, or hyphens. Uppercase labels are rejected.

Register the effective default vendor state directory:

```sh
usage accounts add codex personal --default
usage accounts add claude personal --default
```

`--default` resolves `CODEX_HOME` or `CLAUDE_CONFIG_DIR` at registration time, when set, and otherwise uses the vendor default. The canonical absolute path is saved. Later shell environment changes do not redirect it. Claude's unset default is preserved as a distinct launch mode because explicitly setting `CLAUDE_CONFIG_DIR=~/.claude` makes Claude use an isolated nested `.claude.json` rather than its normal sibling `~/.claude.json`.

Register an existing isolated state directory:

```sh
usage accounts add codex work --state-dir "$HOME/.codex-work"
usage accounts add claude work --state-dir "$HOME/.claude-work"
```

The path must exist, resolves through symlinks to its canonical location, and must be considered logged in by the official vendor CLI. Two labels for the same provider cannot use the same state directory.

Create new managed state and perform the official login once:

```sh
usage accounts add codex client --create
usage accounts add claude client --create
```

Managed state lives under `~/.local/share/usage/accounts/<provider>/<label>/`. `usage` creates a random ownership marker, then launches the official vendor login under that exact state directory. Vendor CLIs continue to own credentials, refresh, and logout.

Claude setup previews its `settings.json` status-line change and asks for confirmation. It saves the prior setting in owner-only application state, installs a compiled collector under `~/.local/share/usage/bin/`, and configures a label-specific wrapper. There is no per-account experimental switch: `--live` is the single global opt-in.

## Collect usage

```sh
usage
usage codex
usage claude
usage codex:personal
usage codex:personal claude:work
usage --live
usage --cached
usage --json
```

With no selector, every configured account is checked. A provider selector chooses every account for that provider. Multiple selectors are accepted and overlapping selections are deduplicated.

Modes:

- Default `usage`: collect Codex live and read Claude status-line caches.
- `usage --live`: collect Codex live and attempt the experimental Claude TUI method, sequentially, for every selected Claude account.
- `usage --cached`: start no vendor process and perform no vendor version check.

`--live` and `--cached` are mutually exclusive. Codex checks run with at most four accounts in parallel. Claude live checks run one at a time.

Global collection options:

```text
--live
--cached
--json
--verbose
--debug-file <path>
--color <always|auto|never>
--codex-timeout <duration>
--claude-timeout <duration>
```

Durations accept values such as `10s`, `1m`, and `1.5m`. Defaults are 10 seconds for Codex and 30 seconds for Claude. Color defaults to interactive terminals only, and `NO_COLOR` always disables it.

## Output

Human output has one heading per account, one 20-character ASCII bar per active window, and shorter known durations first:

```text
Codex  personal  Plus  live
  5h    [#####---------------]  24% used  resets in 2h 14m, 18:40
  7d    [############--------]  61% used  resets in 4d 3h, Fri 19:00

Claude  work  Max  cached 4m ago
  5h    [################----]  82% used  resets in 47m, 17:13
  7d    [########------------]  39% used  resets in 3d 8h, Sat 00:26
```

Green is below 60% used, yellow is 60–79%, and red begins at 80%. `LIMIT REACHED` appears when the provider marks a window reached or usage reaches 100%. Stale data is yellow and expired or unavailable data is red. Output remains fully understandable without color. Unavailable accounts remain in sorted position and never get a fake zero bar.

Every cached result shows age. A reading becomes stale after 15 minutes. If every reported reset time has passed, it is expired and unusable. A provider that omits reset time remains usable, becomes stale after 15 minutes, and displays `reset unknown`.

Warnings and verbose diagnostics go to standard error. Results go to standard output.

### JSON

`usage --json` writes exactly one valid JSON document to standard output, with no progress text, bars, or ANSI escapes:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-27T18:40:00.000Z",
  "mode": "default",
  "results": [
    {
      "provider": "codex",
      "label": "personal",
      "plan": "plus",
      "source": "codex-app-server",
      "status": "live",
      "collectedAt": "2026-08-27T18:40:00.000Z",
      "windows": [
        {
          "id": "codex:primary",
          "usedPercent": 24.5,
          "remainingPercent": 75.5,
          "resetOriginal": 1787875200,
          "resetAt": "2026-08-27T21:20:00.000Z",
          "durationSeconds": 18000,
          "reached": false
        }
      ]
    }
  ],
  "errors": []
}
```

Provider percentages remain exact numeric values in JSON. Credits or paid extra usage are separate fields and are never combined with percentages.

Stable initial error codes are:

- `invalid_configuration`
- `missing_vendor_executable`
- `unsupported_vendor_version`
- `logged_out_account`
- `identity_mismatch`
- `timeout`
- `provider_failure`
- `parse_failure`
- `missing_cache`
- `expired_cache`

Errors include a safe human message, provider and account when applicable, and a `retryable` boolean. Raw terminal captures and credentials are never included. A usable cached fallback can appear in `results` beside the live error that caused it.

## Commands

```text
usage [selectors...] [collection options]
usage accounts add <provider> <label> --default
usage accounts add <provider> <label> --state-dir <path>
usage accounts add <provider> <label> --create
usage accounts list
usage accounts list --verbose
usage accounts remove <provider:label>
usage accounts remove <provider:label> --purge
usage accounts revalidate codex:<label>
usage doctor
usage uninstall
```

`accounts list --verbose` shows safe state paths and labels provider identity details as **unverified metadata**. There is no rename command in version 1; remove and register a new label instead.

`accounts revalidate` is Codex-only. It displays old and new masked, non-secret metadata, asks for confirmation, and records a new email hash. Plan changes alone never trigger an identity mismatch.

## Exit codes

- `0`: every requested account produced a usable result
- `1`: some requested accounts failed, including a live failure that used a cache fallback
- `2`: no usable result could be produced because of configuration or runtime failure

High percentages, reached limits, stale-but-usable readings, plans, and credits never change the exit code.

## How providers work

### Codex

Each live account check starts a fresh absolute `codex app-server --stdio` child with the registered `CODEX_HOME`, performs the documented initialization handshake, calls `account/read` with `refreshToken: false`, verifies the stored email hash, and calls `account/rateLimits/read`. Every active bucket and primary/secondary window is preserved; familiar 5-hour and 7-day windows are not hard-coded.

The app-server standard-input transport is process-local, so `usage` never discovers, attaches to, or reuses another app's server. The short-lived child receives EOF and is cleaned up after each check. Startup and transport failures retry once; authentication, identity, version, timeout, and invalid-response failures do not.

See the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server) and [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

### Claude cached collector

Claude Code's documented status-line JSON contains rolling subscription `rate_limits` after account activity. The installed helper receives that JSON on standard input, retains only quota windows, percentages, reset timestamps, label, source, and collection time, and atomically replaces the account's cache. Concurrent sessions use a lock plus timestamp comparison so an older reading cannot overwrite a newer one.

If a previous status-line command existed, the helper passes the exact same input to it and prints its output. With no prior visible status line, the helper is quiet. It never retains prompts, responses, session content, unrelated token counts, or credentials.

See the official [Claude Code status-line documentation](https://code.claude.com/docs/en/statusline) and [environment variables](https://code.claude.com/docs/en/env-vars).

### Claude experimental live collection

`usage --live` launches the absolute official Claude executable directly in an owned `node-pty`, applies the registered default or isolated configuration mode, and enables `--ax-screen-reader`. An `@xterm/headless` bridge answers terminal capability queries and reconstructs terminal state before the adapter waits for semantic readiness, sends `/usage`, and parses quota labels, percentages, and resets from a bounded screen-reader-friendly capture. Login, first-run setup, trust prompts, network failures, upgrade notices, and unrecognized screens become explicit safe errors.

This parser is experimental because Claude provides no documented one-shot CLI or public subscription endpoint for this data. Claude itself performs the private usage request. `usage` does not extract a token or call an undocumented endpoint. When PTY loading or live parsing fails, cached Claude support continues to work.

## Credentials, privacy, and processes

`usage` never reads, copies, prints, or stores Codex `auth.json`, Claude `.credentials.json`, OAuth access or refresh tokens, API keys, setup tokens, or Keychain secrets. It never invokes macOS `security` or queries Keychain directly. Official vendor CLIs own login, refresh, and logout.

Codex identity matching stores SHA-256 of a consistently normalized email, never the plaintext email. Normal output shows local labels. Claude identity is its local label bound to a canonical stable configuration directory.

The tool sends no telemetry, crash reports, or update checks of its own. `--verbose` and owner-only `--debug-file` output is deliberately redacted: it can contain versions, selected labels, safe paths, timing, cache decisions, retries, and cleanup actions, but no raw authentication data, environment secrets, terminal captures, prompts, or responses.

There is no daemon or resident service. Provider processes exist only during active collection, validation, login, logout, or doctor commands. Every child and PTY created by `usage` is tracked and cleaned after success, failure, timeout, SIGINT, or SIGTERM. Processes not started by `usage` are never attached to or terminated.

## Local files

```text
Configuration:  ~/.config/usage/config.yaml
Backup:         ~/.config/usage/config.yaml.bak
Managed state:  ~/.local/share/usage/accounts/
Helper files:   ~/.local/share/usage/bin/
Cache:          ~/Library/Caches/usage/
```

Application directories use mode `0700`. Configuration, backup, ownership, collector-backup, and cache files use `0600`. YAML has top-level `schemaVersion: 1`, is completely validated before use, rejects unknown fields with their YAML path, and supports careful manual edits. Writes are atomic and retain one previous backup.

## Removal, purge, and uninstall

Normal removal restores a Claude status line only when the current setting still matches the wrapper installed by `usage`, removes registration and quota cache, and leaves vendor state and credentials untouched:

```sh
usage accounts remove claude:work
```

If the user changed Claude's setting afterward, `usage` does not overwrite it. It reports drift and prints the exact wrapper command to remove manually if still present.

`--purge` is only for verified managed state:

```sh
usage accounts remove codex:client --purge
```

It refuses default/external state, missing or mismatched ownership markers, symlinks, broad paths, and locations outside the managed root. After confirmation it asks the official vendor CLI to log out under the exact directory. If logout fails, state is not moved. A successful purge moves the directory to macOS Trash with a collision-safe name and reports that it is recoverable. There is no `--force`.

Prepare for npm removal with:

```sh
usage uninstall --preview
usage uninstall
npm uninstall --global quota-usage
```

`usage uninstall` previews its changes, safely restores matching Claude settings, removes helpers and caches, offers to remove configuration, and leaves all vendor state and logins untouched. Purge managed accounts separately first if desired. The npm uninstall lifecycle itself deletes no user data.

## Doctor and troubleshooting

`usage doctor` performs read-only checks for:

- YAML validity and schema version
- local file permissions and duplicate/unsafe paths
- vendor executable paths and versions
- vendor-reported login status for every account
- Codex app-server stdio capability
- Claude multi-account version support and `node-pty` loading
- collector installation and configuration drift
- cache presence, age, expiration, and permissions
- managed ownership markers

It does not query live quota endpoints.

Common fixes:

- `missing_vendor_executable`: install the official CLI or set its absolute executable in `config.yaml`.
- `unsupported_vendor_version`: upgrade the official vendor CLI. Claude setup/live requires 2.1.238+.
- `logged_out_account`: run the official CLI using the account's registered state directory, or remove and re-register it.
- `identity_mismatch`: verify the intended Codex account, then run `usage accounts revalidate codex:<label>`.
- `missing_cache`: use Claude Code on that account after installing the collector, then retry.
- `expired_cache`: use Claude Code to refresh the status line, or opt into `usage --live`.
- Collector drift: follow the exact manual cleanup instruction without overwriting the newer Claude setting.
- Claude live PTY unavailable: cached mode remains supported; run `usage doctor` for the native-module and terminal-emulation detail. Live mode repairs a packaged `node-pty` `spawn-helper` that has lost its executable permission; `doctor` reports the helper path and mode without changing it.

## Development

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run coverage
npm run build
npm pack --dry-run
```

Tests use temporary directories, protocol fixtures, fake vendor executables, and mocked PTYs. They do not touch real vendor state, credentials, Keychain, status-line settings, or live quota endpoints.

Real-account verification is manual only and was not run while building this repository. With explicit permission, smoke test on disposable registrations by adding one account per provider, exercising default/cached/live/JSON output, running doctor, and removing the registrations. Claude setup changes its status-line configuration after a confirmation, and live checks read current subscription state.

## Roadmap

- Quota history
- Linux support
- Loading animation
- More providers

## License

MIT © 2026 Floyd Haremsa
