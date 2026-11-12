# Agreemetry

**Independent judgments. Transparent consensus. Reproducible reliability.**

[![CI](https://github.com/agreemetry/agreemetry/actions/workflows/ci.yml/badge.svg)](https://github.com/agreemetry/agreemetry/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Website: [agreemetry.org](https://agreemetry.org)

Agreemetry is an open-source web platform for research teams in which two or more people independently classify, code, screen or rate the same material, resolve their disagreements, and report interrater reliability. It serves any field that relies on human judgment:

- systematic review screening;
- qualitative and thematic coding;
- evidence and claim verification;
- rubric scoring and assessment;
- expert panels and clinical or content adjudication;
- checking automated classifiers, including generative AI output, against human raters.

Each study is configured through the website, not in code.

The name joins *agreement* and *-metry*, the suffix for measurement in biometry and geometry: the measurement of agreement.

## What it does

| Stage | What Agreemetry provides |
|---|---|
| **Configure** | Projects from templates. Variables of binary, nominal, ordinal, numeric, multi-label and free-text types; categories; the number of judgments per item; everyone rates everything or a balanced, seeded distribution; an agreement rule (unanimous, majority or a threshold); the disclosure point; resolution options and rationales; blinded fields. |
| **Import** | CSV, Excel or JSON, with column mapping and validation for duplicate identifiers, missing values, existing identifiers and encoding. Every original field is kept. Shared context documents can be keyed to items. |
| **Assess independently** | A personal queue in a seeded order unique to each adjudicator, drafts saved automatically, keyboard shortcuts. Blinded fields never reach adjudicators, and other judgments stay hidden until the disclosure point. |
| **Detect disagreement** | Once an item has all its judgments, each variable is compared under the project rule. An incomplete item is never counted as agreement, and a tie is never a majority. |
| **Resolve** | A live queue of disputed items with the judgments side by side, a discussion thread, standard options and rationales, approvals, escalation to a lead, and versioned final decisions. Nothing is overwritten silently. |
| **Reliability** | From the original independent judgments only, with intervals and warnings: raw agreement, Cohen's and weighted kappa, Fleiss' kappa, Krippendorff's alpha (four levels), Gwet's AC1, the prevalence- and bias-adjusted kappa, six intraclass correlations, pairwise and per-category results, subgroups, and the accuracy of reference raters such as an automated classifier. |
| **Monitor** | A dashboard of progress, agreement, disagreements, resolutions, escalations and reliability, filtered by batch, adjudicator, variable, status or any field. |
| **Export** | Tidy CSV, Excel, JSON, a printable report, a ZIP with a data dictionary, codebook and loaders for R, Python and Stata, and a re-importable project archive. |
| **Audit** | An append-only log of every submission, reopening, proposal, approval, finalization, escalation, import and configuration change. |

## Accounts, labs and integration

- **Researcher accounts.** On a shared server, researchers register with their email address (or a configured provider such as GitHub or Google), complete a short profile with an optional affiliation and ORCID iD, and accept the deployment's terms.
- **Labs.** A lab is a group account for a team, lab or centre. It owns projects; its owners and administrators administer every lab project, so work continues when people move on. A direct role on a project always wins, so a lab administrator who rates a lab project stays blind. Joining a lab needs the invitee's consent.
- **API.** Personal tokens, read-only or read-write, optionally limited to one project and always expiring, let scripts and other platforms push items, follow progress through an events feed, and read published results. A token carries its owner's roles, so every blinding rule still applies. Signed webhooks announce events without carrying any judgment or item content. See [docs/API.md](docs/API.md).

## Two ways to run it

| Mode | When to use it | Where rules are enforced |
|---|---|---|
| **Local workspace** (default build) | Demonstrations, a single machine, or adjudicators on separate machines exchanging *adjudicator packages*. | In the browser. Convenient, but not a security boundary. |
| **Shared server** (Supabase) | Teams working at the same time, with registration, labs, the API, and server-enforced blinding and roles. | Postgres row-level security and audited functions (`supabase/migrations`). |

The frontend is a static site suitable for GitHub Pages; the shared-server mode adds a Supabase project. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Quick start

```bash
npm ci
npm run dev          # http://localhost:5173
```

The first start creates a *Workspace administrator* identity and three demonstration projects with simulated judgments: title and abstract screening with three reviewers, rubric scoring with weighted kappa and intraclass correlations, and multi-label thematic coding with distributed assignment.

Requires Node.js 20 or later.

## Tests and validation

```bash
npm test             # statistics, workflow, labs, permissions, exports, and the SQL schema in embedded Postgres
npm run build && npx vite preview --port 4173 &
npm run test:e2e -- http://localhost:4173/ e2e-shots "<path to chrome or msedge>"
```

- **Statistics** reproduce published worked examples (Krippendorff 2011; Fleiss 1971; Shrout and Fleiss 1979) and match scikit-learn, statsmodels, the `krippendorff` package and scipy to ten decimals. See [docs/STATISTICS.md](docs/STATISTICS.md).
- **The SQL schema** runs in PGlite, an embedded Postgres. Its item states equal the TypeScript states on every demonstration item, and the tests cover blinding, roles, labs, API tokens, the events feed, published results and webhooks.

## Documentation

| Document | Contents |
|---|---|
| [User guide](docs/USER_GUIDE.md) | Roles, setting up a project, rating, resolving, reliability, labs, exporting |
| [Statistics](docs/STATISTICS.md) | Coefficients, intervals, missing data, warnings, validation, references |
| [API](docs/API.md) | Tokens, endpoints, events, results, webhooks, examples in curl, Python and R |
| [Deployment](docs/DEPLOYMENT.md) | GitHub Pages, Supabase, custom domains, email, sign-in providers |
| [Running a public instance](docs/HOSTING.md) | What an operator is responsible for: terms, privacy, ethics, backups |
| [Architecture and security](docs/SECURITY_AND_ARCHITECTURE.md) | Layers, integrity guarantees, blinding, labs, tokens |
| [Data formats](docs/DATA_FORMATS.md) | Import formats, exported tables, archives, packages |
| [Design system](docs/DESIGN.md) | What each colour means, typography, chart conventions, how the palette was checked |

## Repository

```
src/core/        domain model, workflow, agreement, policy, resolution, statistics, import and export (pure TypeScript)
src/data/        backends: local (IndexedDB) and Supabase; demonstration data; first-launch seed
src/ui/          React interface (no UI framework), charts, pages
supabase/        database schema, security functions and policies
tests/           unit, integration, SQL and end-to-end tests; statistical reference fixtures
docs/            user, statistics, API, deployment, hosting, architecture and data format guides
```

## Contributing

Contributions of every kind are welcome: bug reports, documentation, translations, statistical checks, and code. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md), never a public issue. How decisions are made is in [GOVERNANCE.md](GOVERNANCE.md).

## How Agreemetry was built

Agreemetry was designed and directed by its maintainer and written with substantial help from an AI coding assistant (Claude, by Anthropic). Every change was reviewed, and the statistics are validated against published examples and independent implementations as described above. Contributors may use AI tools under the same conditions; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Citing Agreemetry

If Agreemetry supports your research, please cite it. GitHub shows a citation from [CITATION.cff](CITATION.cff) under *Cite this repository*.

## Licence and name

Agreemetry is released under the [Apache License 2.0](LICENSE). The licence covers the code, not the name: see [TRADEMARKS.md](TRADEMARKS.md) for how the name may be used, including by forks.
