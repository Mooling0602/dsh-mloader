# CONTEXT.md

Technical detail for agents and maintainers. This is the place to look for the parts
of the system that are too specific, too brittle or too long to belong in
`README.md`, and the place to record them.

`AGENTS.md` holds coding conventions and development rules only. `README.md` is for
ordinary users and stays short. Documentation for third-party plugin authors belongs
in `docs/` and stays rigorous.

## Contents

- [1. How to use this document](#1-how-to-use-this-document)
- [2. Architecture axioms](#2-architecture-axioms)
- [3. Repository map](#3-repository-map)
- [4. Commands and testing](#4-commands-and-testing)
- [5. Pitfalls the code already paid for](#5-pitfalls-the-code-already-paid-for)
- [6. External-plugin author constraints](#6-external-plugin-author-constraints)
- [7. Documentation layers](#7-documentation-layers)

## 1. How to use this document

- Hard technical facts live here, not inline in `AGENTS.md` and not in `README.md`.
- When a change alters behaviour, an invariant, a protocol or a workaround, update
  this file in the same change. A stale section here is worse than no section.
- Keep it dense and factual. No marketing, no tutorial tone.
- Detailed contract material stays in [`docs/ABI.md`](docs/ABI.md), which is the
  authority for the plugin ABI; this file summarises and links, and never restates
  the ABI in more detail than the reader needs here.

## 2. Architecture axioms

Todo.

## 3. Repository map

Todo.

## 4. Commands and testing

Todo.

## 5. Pitfalls the code already paid for

Todo.

## 6. External-plugin author constraints

Todo.

## 7. Documentation layers

See section 4 of `AGENTS.md` for the rule that governs where documentation goes. In
short:

| File | Audience | Character |
|---|---|---|
| `README.md` | users of the plugin | short, plain, task-oriented |
| `docs/` | third-party plugin authors | precise, normative, ABI-grade |
| `AGENTS.md` | AI coding agents and maintainers | rules only |
| `CONTEXT.md` | agents and maintainers | dense technical detail |
