# Architecture Decision Records

Small, dated, one-decision-per-file. Each ADR records a decision that has
been made about how this site is built, why, and what it forces on future
work. ADRs are append-only: if a later decision supersedes an earlier
one, the earlier ADR gets a `Status: Superseded by 000N` line and stays
in place. History is the point.

Format follows Michael Nygard's classic ADR shape (Context / Decision /
Consequences), plus explicit alternatives-considered so the reasoning is
recoverable years later without me in the room.

## Index

| #    | Title                                                                 | Status   | Date       |
|------|-----------------------------------------------------------------------|----------|------------|
| 0001 | [Site topology: portfolio-first, product elsewhere](./0001-site-topology.md) | Accepted | 2026-07-14 |
| 0002 | [Design folder layout and extraction contract](./0002-design-folder.md) | Accepted | 2026-07-14 |
| 0003 | [Theme model: OS-default with user override, data-theme attribute](./0003-theme-model.md) | Accepted | 2026-07-14 |

## Conventions

- Filename: `NNNN-kebab-title.md`, numbered contiguously from 0001.
- One decision per ADR. If a change touches two decisions, write two ADRs.
- `Status` is one of: `Proposed`, `Accepted`, `Superseded by NNNN`,
  `Deprecated`.
- Keep them short. If an ADR is longer than a screen or two, the
  decision is probably not a single decision.
