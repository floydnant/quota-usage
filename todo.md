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
