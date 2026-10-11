# Changelog entries

What's changed since the last release, one file an entry. A release gathers them into
`CHANGELOG.md` and deletes them (`npm version` does it; see CONTRIBUTING.md).

A pull request that changes what ships (`src/`, `charts/`, `packaging/`, `build/`) adds a file
here:

- **Its name** is `<what>.<section>.md`, in lower case with hyphens: `create-alias.fixed.md`,
  `access-control.added.md`. The section is one of `added`, `changed`, `deprecated`, `removed`,
  `fixed`, `security`.
- **What's in it** is the entry, word for word as `CHANGELOG.md` will have it: it starts with
  `- `, and its other lines are set in by two spaces. Write it for whoever uses Lumovi: what they
  can do now, or what no longer goes wrong, not how it was built.

A change that adds to an entry still waiting here (a follow-up to the same feature) edits that
file rather than adding another.

Nothing to tell anyone (a refactor, a test, CI)? Say so in the pull request's text, on a line of
its own, with the reason:

    Changelog: none: tests only

`npm run changelog` prints what's waiting, as the next release will have it: each section's
entries in the order their pull requests reached `main`.
