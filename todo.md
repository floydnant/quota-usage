# TODO

This is the candidate backlog, not a change to the version-one contract. Preserve
the privacy, no-daemon, provider-ownership, cleanup, JSON, and exit-code
invariants in [`AGENTS.md`](AGENTS.md) when designing any item.

## Product candidates

- [ ] Compute usage pace and predictions/expectations. Define the minimum sample
      quality and make uncertainty explicit; do not imply precision from one
      reading.
- [ ] Make Claude live usage load faster and show a usable stale cache reading
      while refresh is in progress. Preserve the final partial-failure status and
      structured live error when refresh fails.
- [ ] Add loading indicators. Keep them interactive-human-output only; never
      write progress, ANSI, or animation frames to JSON stdout or non-TTY output.
- [ ] Add historical usage analytics. Define retention, pruning, permissions,
      schema migration, and an opt-out before retaining more than the current
      newest reading.

## Roadmap carried from the README

- [ ] Linux support, including platform-specific paths and account-state behavior.
- [ ] More providers through `ProviderAdapter`, without provider-specific logic
      leaking into collection or rendering.

## Maintenance

- [ ] Revalidate Codex app-server and Claude noninteractive/status-line fixtures when the
      supported vendor versions change.
- [ ] Recheck npm package-name availability immediately before publication.

## Completed output improvements

- [x] Color the whole quota row red when a limit is reached.
- [x] Align quota columns across accounts.
- [x] Default to a foreground auto-refreshing TUI on interactive terminals, with
      explicit TUI/plain modes and finite redirected/JSON output.
- [x] Show one row per reset credit, sorted by expiration, dimmed except for
      credits expiring in less than seven days.

## Completed account inventory

- [x] Infer subscriptions from immediate `~/.codex-<label>` and `~/.claude-<label>`
      directories, plus the bare defaults, while retaining arbitrary
      explicit registrations.
- [x] Rescan at each refresh, preserve logged-out rows with `auth failed`, and keep
      successful accounts visible alongside failures.
- [x] Deduplicate canonical paths, prefer explicit registrations, and isolate
      discovered caches by directory identity.

- [x] Display directory names and accept them as filters while retaining colon
      aliases and explicit `default` selectors; `personal` requires an actual label.
