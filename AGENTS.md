# AGENTS.md

<!--
此标记仅由人类维护者所使用，并添加以仓库所有者所使用的自然语言编写的注解内容。
注意：这条注解不要求修改任何内容，也不允许被项目维护者以外的人修改！
当 AI Agents 看见这些注解时，应该根据其意见进行修改，然后移除掉注解。
不允许 AI Agents 添加或者修改任何注解内容，在删除注解前，应确保已正确按照注解内意见修改了受影响的内容，并明确告知用户。
不允许未持有 Collaborators 权限的人员添加或修改任何注解内容，包含这类更改且未开启 `Allow edits from maintainers`（允许维护者修改）的外部 PR 将被拒绝。
-->

**Where the current state of this repository violates the rules below, leave it alone.** Do not tidy it, reformat it, translate it or migrate it on your own initiative, and do not treat an existing violation you happen to pass as part of the task. Cleanup of pre-existing material happens only when the user asks for it, and that request is the only trigger.

Rules for AI coding agents working in this repository. Follow them exactly. When a rule and your own judgement disagree, the rule wins. The rules govern the code and the prose you write or change; material you are not touching stays as it is until the user asks for it to be brought into line.

## 1. Git: commits and pushes always need the user's approval

- **Never create a commit without asking first.** Ask for approval every time, even if you have committed in this same session before.
- **Commit messages must be reviewed by the user before the commit exists.** Draft the message, show it, and wait for approval. There is no exception to this, not even when the commit itself is already approved.
- **Never push without asking first.** Ask every time.
- The only relief is an explicit statement from the user, during the current session, that further pushes need no further asking. That waiver covers pushes only, is session scoped, and does not carry into later sessions. It never covers commits or commit message review.

## 2. Commit messages: Conventional Commits

Follow [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```plaintext
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

- **Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `style`, `revert`. Any other type needs a reason in review.
- **Scope** is optional but preferred. Use the module or area touched, such as `contract`, `registrar`, `discovery`, `serialize`, `backends`, `python`, `wasm`, `console`, `seed`, `tools`, `commands`, `test`, `docs` or `deps`.
- **Description** is lowercase, imperative and carries no trailing period. Describe the change, not the file. Write "reject unsupported schema keywords" rather than "update contract.js".
- **Body** explains why the change was made. It is mandatory for a bug fix or an ABI change, because a one line subject cannot justify either of them.
- **Do not wrap the message by hand.** The subject and each body paragraph are one complete line, with no limit on how many characters that line holds. Section 7 states the rule and the reason it exists; it covers commit messages as well as Markdown documents.
- **Footers:** use `BREAKING CHANGE: <description>` or a `!` after the type or scope for any change to the external plugin contract, the manifest schema, the RPC protocol or the WebAssembly ABI. Reference issues as `Closes #123`.
- **One logical change per commit.** Do not mix an unrelated refactor, a formatting sweep or a dependency bump into a behavioural fix.

Examples that fit this repository:

```plaintext
fix(transport): project host exec objects before crossing process boundary
feat(seed): release built-in example on first start without overwriting
docs(abi): document the profile directory detection order
test(waterfall): assert listeners cannot block the tool execution chain
```

The message is still reviewed by the user before the commit exists, as rule 1 requires. This section only defines what that message must look like.

## 3. Docstrings and comments

### Docstrings

Every module, public class and public function carries a docstring in the standard documentation format of the language it is written in.

- **TypeScript** (`src/**/*.ts`): JSDoc. Put a `/** ... */` block on every exported symbol. The type signature carries the types; use `@param`, `@returns` and `@throws` only for the part of the contract the signature cannot express, such as units, ordering and failure conditions. Use inline JSDoc annotations where a value shape is not visible from the declaration.
- **Python** (`src/runtime/python_sdk/**/*.py`, `seed/**/*.py`): **reStructuredText** docstrings in the Sphinx convention. Follow the PEP 257 layout, which is a one line summary, a blank line, then the body, and use field lists for the contract, written as `:param name:`, `:type name:`, `:returns:`, `:rtype:` and `:raises ValueError:`. Write the format name in full where it matters and do not abbreviate it.
- **Go** (test fixtures under `test/`): standard Go doc comments that begin with the name of the identifier they describe.

The source of the loader is TypeScript. A `.js` file beside a `.ts` source is build output produced by `pnpm build` and is committed only until release artifacts replace it. Change the `.ts` file, rebuild, and never edit or document the generated `.js` file.

A docstring states a contract. It does not restate the signature. Say what the code does, what it owns, what it may throw and which invariant the caller must uphold. Units, ordering guarantees and lifetime rules belong here.

### Comments

Keep comments to a minimum. Prefer a clearer name or a smaller function over a comment that explains the code.

- **Do not** write a comment that restates the code, narrates the diff, keeps a changelog or leaves commented out code behind.
- **Do not** scatter one off notes through a function, and do not use decorative banners, separator runs or emoji markers to organise code.
- **Do** keep a comment when it records something the code cannot express, such as a non obvious invariant, a workaround for a bug in a dependency or in the runtime, a security relevant reason or an ordering constraint that is easy to break. Place that comment immediately next to the code it constrains and give the reason rather than the history.
- Knowledge that must outlive the function belongs in `docs/` or `README.md`, not in an inline comment.

Existing comments that violate this rule are not a licence to imitate them, and they are not yours to clean up either. Leave them where they are unless the user asks for a cleanup pass. See the note at the top of this file.

## 4. Documentation layers

Each document has one job. When a sentence does not fit the document it is in, move the sentence to the document that owns it instead of stretching the boundary.

| Document | Audience | Holds |
| --- | --- | --- |
| `AGENTS.md` | AI coding agents, maintainers | coding conventions and development rules, and nothing else |
| `CONTEXT.md` | agents, maintainers | technical detail: architecture axioms, invariants, command recipes, pitfalls, protocol notes |
| `README.md` | ordinary users of this plugin | short, readable, task oriented material about what it does and how to use it |
| `docs/` | third party plugin authors | precise, normative, professional reference material |

### `AGENTS.md`

Rules and conventions only. An invariant or a technical fact that lands here has landed in the wrong file. Move it to `CONTEXT.md`, then reference the section by name if the rule depends on it.

### `CONTEXT.md`

**All technical detail converges here.** A fact precise enough to need care, such as a detection order, an ordering constraint, a timeout, a wire format or a workaround for a dependency bug, belongs in `CONTEXT.md` rather than in `AGENTS.md` or `README.md`. Create the file if it is missing. Keep it current, because a behavioural change that leaves `CONTEXT.md` stale is an incomplete change.

### `README.md`

Written for a user who wants to install the plugin and get it working, not for someone reading the source. Prefer shortening over explaining.

- Lead with what the project is and what the user gets from it, then how to install and use it.
- Keep the path to a first success short and copy pastable.
- Cut implementation detail, which means no internal file walkthroughs, no protocol frames, no design rationale and no exhaustive configuration tables. Move that material to `CONTEXT.md`.
- A technical statement that survives here must still be true. Simplification is not permission to be inaccurate.

### `docs/`

Material addressed to third party plugin developers. The audience is a professional integrator, so keep the register technical and the statements normative. Give exact field names, exact signatures, explicit invariants, explicit error conditions and an explicit statement of what is not supported. Do not simplify for a general reader and do not soften a constraint into a suggestion.

### Cross-cutting

- One fact, one home. Link to it instead of repeating it, because duplicated prose drifts out of sync. **`CONTEXT.md` is the exception.** It exists so that an agent can load the working model of the system from one file, so it repeats a fact that also lives in `docs/ABI.md`, in `AGENTS.md` or in `README.md` whenever the second copy saves the reader another file, and it keeps detail those documents leave out. That repetition is deliberate, so a change updates the `CONTEXT.md` copy even when the authoritative statement lives elsewhere.
- A change to behaviour, to the ABI or to an invariant must update the owning document in the same change, including `CONTEXT.md` whenever it describes the affected area.

## 5. Technical changes: document the new state, delete the old one

A change is not a story about a change. Once it lands, the repository describes only how the system works now.

### In source and documentation

- **Write the new behaviour in the present tense, as the only behaviour.** Do not write "used to be", "previously", "now we instead" or "changed in v0.2". Do not compare before and after, and do not add version history tables to reference material.
- **Delete what the change made obsolete** in the same commit. That covers dead functions and branches, the superseded code path, retired configuration keys and their defaults, stale examples, stale screenshots, stale schema fragments, tests that assert the old contract, and documentation sections that are no longer true.
- **Rename in place rather than aliasing.** Substitute the new name everywhere. Do not leave the old name pointing at the new one "for clarity".
- Leaving obsolete material behind with a note, a `// removed` marker or a deprecation comment is not acceptable. It is the same debt in smaller pieces.
- If removing the old behaviour leaves a documentation section empty, remove the section rather than filling it with an explanation of what disappeared.

### In the commit message

- **State the turning point in the fewest possible words.** A body clause such as "replaces the per-call spawn with a single long-lived process" is the whole requirement, since the subject already carries the new behaviour.
- Do **not** write a migration narrative, a rationale essay or a recap of the diff in the commit body. Rule 2 asks for the reason for the change, which is not a licence to explain the behaviour that was replaced.
- Name the old behaviour only as far as needed to identify what was replaced.

### Compatibility transitions

- **Do not build one unless it is genuinely required.** Old behaviour is removed, not supported in parallel. A shim, a legacy fallback or a dual code path is a deliberate exception and never a courtesy.
- When a transition is genuinely required, for example for a published ABI, a persisted on disk format or a configuration file that users already have, do only the minimum necessary. Read the old input, convert it, and document the conversion where the operator would look for it.
- Every transition is bounded. State the removal condition or the next version that drops it, and record the transition in `CONTEXT.md`.
- Everything in a transition is temporary and must read as temporary. Never let the old shape return to the general documentation as though it were a supported form.

## 6. Working with the DeepSeek Harness runtime

`dsh-mloader` only takes effect inside a running `dsh` process, because it is a Cordis plugin loaded from a profile and the plugins it hosts are mounted at startup. Two kinds of work therefore belong to the user rather than to the agent.

### Restarting `dsh`

- **Never restart, kill or otherwise interrupt a running `dsh` service.** Do not use `pkill`, `kill` or a supervisor restart, and do not start a second `dsh` on a different port in order to "verify" a change.
- When a change needs the service restarted to take effect, stop at the handoff. Finish the code, state plainly what changed and why a restart is required, then ask the user to restart and report back.
- Make the handoff precise. Give the exact command to run and the exact thing to look for, such as the terminal lines that should appear or the tool and slash command to try. A vague request to restart and check wastes the handoff.
- Treat the result the user reports as the verification. Do not re-derive it by restarting the service yourself.

### Asking for help when debugging

- **Proactively ask the user to run a step when they can do it better than you.** This is the expected move and not a last resort. The agent works through a limited shell, while the user has a real interactive terminal, a browser and the live session that produced the problem.
- Ask for a human hand when the step needs any of the following:
  - restarting or observing `dsh`, or working with the Web UI at its real URL, in other words anything that exists only in the live session;
  - a TTY, an interactive prompt or keystrokes;
  - credentials, a logged in account, a device or network access you do not have;
  - a reproduction of user visible state, such as what the model actually received, what the terminal printed or what the browser rendered.
- Make the request cheap to answer. Ask for one command or one action at a time, quote it exactly, and state the expected output so that a mismatch is obvious.
- Ask early. Spending a long turn on a brittle workaround for something the user can do in seconds is the wrong trade, so ask when in doubt.
- Say what you still need and what you will do with the answer, so the user knows the request is not idle curiosity.

## 7. Prose style in comments and documentation

Comments and documentation are read by people, so write them as prose a person can read once and understand.

- **Avoid the em-dash (`—`) and do not use dash characters as connectors.** This applies to code comments, JSDoc, docstrings and every Markdown file in the repository. Use a comma, a colon, a semicolon, a full stop or parentheses, or split the sentence in two.
- Do not use runs of hyphens, equals signs or box drawing characters as decorative separators in comments. Section breaks belong in headings.
- Write complete sentences. Every sentence has a subject and a verb, and it says one thing. If a sentence needs three clauses to stay true, it needs to be three sentences.
- Keep the flow natural. Read a paragraph back before committing it. If a phrase exists only to join two ideas that do not belong together, delete the join and rewrite both ideas.
- Prefer the plain word. Use "use" rather than "utilise", "because" rather than "due to the fact that", and "must" rather than "it is required that".
- Keep the terminology consistent with the code. If a function is named `registrar`, the prose says registrar everywhere, not "ledger" in one paragraph and "registry" in the next.
- Avoid abbreviations and jargon that a reader of this repository would have to look up, except for names that the code itself uses.
- Punctuation carries the emphasis. Reach for a colon, a list or a shorter sentence rather than an intensifier.

This rule applies to every sentence you write, including the ones in this file. It is not a mandate to rewrite prose that already exists. See the note at the top of this file.

### Line wrapping

- **Write a paragraph as one complete text line.** Do not break it at a column, a word count or any other width, and do not treat a long line as a problem to be fixed. No limit applies to the number of characters in a line. This covers every Markdown document in the repository and every commit message, the subject line included.
- **The renderer wraps the line, not the author.** Front ends such as the GitHub web interface set their own width and reflow a paragraph to fit the window, so a complete line arrives there as readable prose. A break written into the source reaches the renderer as a hard break inside the paragraph, which renders wrongly and interrupts reading. A line that looks presentable in a plain text editor is therefore the wrong shape for the documents this repository publishes.
- **Keep the newline that ends a block.** A heading, a table row, a list item, a code block, a block quote and the blank line between two blocks each stay on their own line. Only the newline that a soft wrap would have inserted inside a paragraph goes away.

`.markdownlint.json` records this policy: it turns the line length rule off and allows a heading to repeat when the repeats are not siblings. `CONTEXT.md` names the file in the repository map.

## 8. Language: English unless i18n requires otherwise

English is the working language of this repository. Write in English by default, and treat any other language as the exception.

- **Applies to everything:** source comments, JSDoc, docstrings, commit messages, documentation in `docs/`, `README.md`, `CONTEXT.md`, error and log messages, test descriptions, test fixture data and issue style notes.
- **The only standing exception is i18n.** A file that exists to provide translations, a localised string table, or a user facing message that ships in several locales stays in the language its locale requires.
- Characters and words that come from another language for a specific technical reason are fine as they are. Identifiers, protocol tokens, file names, upstream error strings you are quoting and proper nouns are not translated.
- **Do not annotate the exception.** When a string is intentionally non English, leave it and move on. No note, no comment, no translation in brackets, no explanation of why it is not English.

Existing non English text is not a defect to be fixed on sight, and it is not yours to translate. Leave it where it is unless the user asks for a cleanup pass. See the note at the top of this file.

## 9. `AGENTS.ignore.md`: record what was already settled

This repository has a second instruction file, `AGENTS.ignore.md`, whose job is to stop the same disagreement from happening twice. **Do not create it in advance and do not create it to be tidy.** It exists only when one of these has actually happened:

- the agent makes the same mistake in an area more than once, even after correcting it there;
- the technical direction the agent plans or starts to implement does not match what the user expects;
- some other edge case keeps recurring.

When one of those happens, create `AGENTS.ignore.md`, or append to it if it already exists, and record three things.

- **The wrong route or direction.** State what the agent did or intended to do, and why it was wrong. Write it as a route not to take again, precise enough that a future agent recognises the situation before walking into it.
- **The final decision reached with the user.** State what was settled, and say that it is settled. This is the part that carries authority, so write it as a rule and not as a discussion summary.
- **Upstream information, when there is any.** Record the dependency, library, runtime or protocol detail that explains the decision. This item is optional. If there is no upstream cause, leave it out rather than filling the space.

Style rules from sections 3, 7 and 8 apply to this file as well. It is instructions, not a journal, so keep it short, keep it current, and delete an entry once the situation it guards against can no longer occur.

Read `AGENTS.ignore.md` before changing an area it covers. When it and this file disagree about a settled decision, `AGENTS.ignore.md` wins, because it records the user's actual decision about that specific area.
