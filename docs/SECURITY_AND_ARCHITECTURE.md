# Architecture and security

## Layers

```
React interface (src/ui)  ->  Backend interface (src/data/backend.ts)
                               |- LocalBackend: in-memory database + IndexedDB + BroadcastChannel; rules from src/data/service.ts
                               |- SupabaseBackend: calls audited Postgres functions; rules enforced by the server
Core (src/core), pure TypeScript: types, workflow (assignment, comparison, item state, disclosure), policy (visibility),
resolution (options, approvals), statistics, analysis, import, export.
```

The same rules exist twice: in TypeScript for the local workspace, and in SQL for the shared server. `tests/sql.test.ts` runs the SQL in an embedded Postgres and checks that it produces the same item states as the TypeScript on every demonstration item, so the two cannot drift silently.

## Integrity guarantees

**Independent judgments.**

- A submitted judgment cannot be edited. It can be reopened only by its author, only before disclosure, only if the project allows it, and only with a reason.
- Each version is kept in the judgment's history and in the audit log.
- Optimistic version checks refuse stale writes from another window or user.

**No false agreement.**

- An item is compared only when it has the required number of submitted judgments.
- A missing optional answer never agrees with an answer.
- A tie is never a majority.

**Final decisions.**

- One final resolution per item, enforced by a unique index on the server.
- Reopening needs an administrator and a reason. The earlier decision becomes *superseded*, never deleted.
- A database trigger stops a final or superseded resolution from moving backwards.

**Audit.** Every write appends to the audit log. On the server, a trigger rejects any update or delete of audit rows.

**Configuration changes.** A change that would orphan recorded judgments is refused: removing a variable in use, changing its type, or removing or renaming a category code in use. Changes are versioned, and concurrent edits are detected.

## Blinding

**Hidden from adjudicators and leads:**

- Blinded fields are removed before data leave the server (shared server) or the service layer (local workspace).
- Administrator-only documents are removed, along with the provenance note.

**Other adjudicators' judgments.** These are visible only when both conditions hold:

1. the item has reached the disclosure point (per item, at project completion, or by an administrator);
2. the viewer has submitted their own judgment on it, or is a lead not rating it.

Until then an adjudicator sees only *awaiting* or *in progress* for their own items, never the dispute state.

**Order.** Presentation order differs per adjudicator; it is seeded and reproducible.

**Identity.** Members see each other by project pseudonym. Display names appear only to administrators, and in exports only on request.

## Shared server (Supabase)

- Row-level security is enabled on every table. No policy grants clients access to raw rows, except a user's own profile and the content-free change signals of projects they belong to.
- Every read and write is a `SECURITY DEFINER` function with a fixed `search_path`. It checks the caller's membership and role, applies the rules above, and writes the audit log. Execute rights are granted to signed-in users only.
- The browser holds only the publishable anon key and the user's session. The service-role key must never be used in the frontend.
- Registration and sign-in are by email link, or by an identity provider the operator enables. Agreemetry stores an email address and a display name, and optionally an affiliation, an ORCID iD and a research field that the person enters, plus when they accepted the deployment's terms.

## Labs

- A lab owns projects. Its owners and administrators get administrator memberships on the lab's projects, marked as coming from the lab. A person who already has a direct role on a project keeps it: the lab grant never replaces a project role, so a lab administrator who rates a lab project stays blind.
- When someone stops being a lab owner or administrator, or a project leaves the lab, the memberships that came from the lab are deactivated and recorded in the audit log. A change that would leave a project without an active administrator is refused as a whole.
- Joining a lab always needs the invitee's acceptance. Lab members see each other's names, affiliations and ORCID iDs; email addresses are visible to lab owners and administrators only.
- Only the dedicated function can place a project in a lab. A lab identifier written into a project document is overwritten by a trigger.

## API tokens

- A token carries 244 random bits (two version 4 UUIDs) after the prefix `agm_`. Only its SHA-256 hash is stored; the token is shown once.
- Requests carry the token in `X-Agreemetry-Token`. PostgREST's pre-request hook (`agm_pre_request`) looks up the hash, refuses revoked or expired tokens and inactive accounts, checks the called function against the token's scope, and only then sets the caller identity for that single request. A request with a signed-in session ignores the header.
- A project-limited token sees that project only, through every function including the project list.
- Tokens cannot create tokens, change profiles, manage labs, publish results or manage webhooks.

## Events, results and webhooks

- The events feed (`api_events`) and webhook payloads carry event names, identifiers and times only, never audit details, judgments, names or item content.
- Published results are an explicit administrator action, computed by the same code as the downloads, with adjudicators by pseudonym.
- Webhook signing secrets are stored in a table closed to clients and shown once. Deliveries are sent with `pg_net` and signed with HMAC SHA-256 when `pgcrypto` is available. A failed delivery never blocks the operation that caused it.

## Local workspace

Data live in the browser's IndexedDB. The access rules run in the browser, which is fine for a single machine, demonstrations, or adjudicator packages, but is not a security boundary: anyone with the browser profile can read the data. Export project archives regularly.

## Personal data

Agreemetry adjudicates research items, not people. It needs no personal data beyond a sign-in address and a display name; the profile fields are optional, and exports use pseudonyms by default. Operators of public instances should read [HOSTING.md](HOSTING.md). If items themselves contain personal or sensitive data, apply the controls your study requires before import, and do not publish such projects on a public site.
