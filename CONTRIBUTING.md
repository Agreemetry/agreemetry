# Contributing to Agreemetry

Thank you for helping. Agreemetry is used to make research decisions, so correctness, blinding and reproducibility come first. This guide explains how to propose changes.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the issue form: what you did, what you expected, what happened, the browser, and whether you use the local workspace or a shared server. Never attach research data.
- **Check the statistics.** Compare a coefficient with another package on your own data and report any difference, with the data shape and settings.
- **Improve the documentation**, including translations.
- **Propose a feature** with the feature form. Explain the research workflow it serves, not just the button.
- **Write code.** Pick an issue labelled `good first issue` or `help wanted`, or open an issue first for anything substantial, so we can agree on the approach before you invest time.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Development setup

```bash
git clone https://github.com/agreemetry/agreemetry.git
cd agreemetry
npm ci
npm run dev        # local workspace with demonstration projects at http://localhost:5173
npm test           # unit, workflow, labs and SQL tests
npm run typecheck
```

Node.js 20 or later is needed. The end-to-end test drives a real Chrome or Edge:

```bash
npm run build && npx vite preview --port 4173 &
npm run test:e2e -- http://localhost:4173/ e2e-shots "<path to chrome or msedge>"
```

To work on the shared-server mode, create a free Supabase project, apply `supabase/migrations/` in order, and put its URL and publishable key in `.env.local` (see `.env.example`).

## Rules for changes

- **The same rule lives in two places.** Workflow and permission rules exist in TypeScript (`src/core`, `src/data/service.ts`) for the local workspace and in SQL (`supabase/migrations`) for the shared server. A change to one needs the matching change to the other, with tests in `tests/workflow.test.ts` or `tests/labs.test.ts` and in `tests/sql.test.ts`.
- **Never weaken blinding.** Anything that shows judgments, blinded fields or names to someone new needs an explicit discussion in the issue first.
- **Schema changes are new migrations.** Never edit a migration that has been released; add a new file with a later timestamp.
- **Statistics need references.** A new or changed coefficient needs a published worked example or an independent implementation in `tests/reference/` that it matches.
- **Dependencies.** Avoid new runtime dependencies. If one is needed, explain why in the pull request; pin exact versions.
- **Accessibility and layout.** Interface changes must work with the keyboard, in dark mode, and at phone width without horizontal scrolling.
- **Plain language.** Documentation and interface text are read by researchers from many fields: short sentences, no unexplained abbreviations.
- **Keep data out.** Do not commit research data, credentials, tokens or `.env` files. `public/projects/` is ignored by git for this reason.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make focused commits. Every commit must be signed off (see below).
3. Run `npm run typecheck` and `npm test`; for interface changes, run the end-to-end test too.
4. Open a pull request using the template. Describe what changed, why, and how you tested it.
5. A maintainer reviews it. Expect questions; they are about the research consequences, not about you.

## Sign-off (Developer Certificate of Origin)

Agreemetry uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor licence agreement. Signing off a commit certifies that you wrote it or otherwise have the right to submit it under the project's licence. Add the line with:

```bash
git commit -s -m "Describe the change"
```

which appends `Signed-off-by: Your Name <you@example.org>`. Contributions are accepted under the [Apache License 2.0](LICENSE).

## AI-assisted contributions

You may use AI tools. You remain the author and are responsible for every line: understand it, test it, and make sure it does not reproduce code you have no right to submit. Say in the pull request which parts an AI tool helped with. Never paste research data, tokens or credentials into an AI tool.

## Recognition

Contributors are credited in the release notes. Substantial contributors are added to [CITATION.cff](CITATION.cff) by agreement with the maintainers.
