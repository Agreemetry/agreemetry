# API

On a shared server, everything the app does goes through documented Postgres functions exposed by Supabase's REST interface (PostgREST). Scripts and other platforms call the same functions with a personal API token. A token acts as its owner, with the owner's roles, so every blinding and permission rule applies to it exactly as in the app.

The local workspace has no server and therefore no API; use its exports instead.

## Tokens

Create tokens under **Account > API tokens**. Each token:

- is read-only or read-write;
- can be limited to one project;
- expires after 7 to 366 days;
- is shown once; only a hash is stored;
- can be revoked at any time, and shows when it was last used.

A token cannot create tokens, change a profile, manage labs, publish results or manage webhooks; those need a signed-in session in the app. Prefer read-only tokens limited to one project, and keep tokens in a secret store or environment variable, never in code.

## Making a call

Every call is an HTTP `POST` to `<base>/rpc/<function>` with a JSON body of named arguments. The base address and the project identifier are shown under **Settings > Integrations**.

| Header | Value |
|---|---|
| `apikey` | The deployment's publishable (anon) key. It is public and identifies the deployment, not you. |
| `X-Agreemetry-Token` | Your token. This is the secret. |
| `Content-Type` | `application/json` |

```bash
export AGREEMETRY_BASE="https://<project>.supabase.co/rest/v1"
export AGREEMETRY_KEY="<publishable key>"
export AGREEMETRY_TOKEN="agm_..."

curl -s -X POST "$AGREEMETRY_BASE/rpc/api_project_status" \
  -H "apikey: $AGREEMETRY_KEY" -H "X-Agreemetry-Token: $AGREEMETRY_TOKEN" \
  -H "Content-Type: application/json" -d '{"p": "<project id>"}'
```

Errors return HTTP 4xx with a JSON body whose `message` explains the refusal, for example `This token cannot call import_items` or `You are not a member of this project`.

## Functions

### Read (read-only and read-write tokens)

| Function | Arguments | Returns | Who |
|---|---|---|---|
| `list_my_projects` | none | Your projects with your role and item counts | Any member |
| `get_project_view` | `p` | The project as you may see it: configuration, items without blinded fields, your judgments and, after disclosure, others' | Any member; administrators see everything |
| `api_project_status` | `p` | Items, counts by state, completion, and assigned and submitted counts per adjudicator pseudonym | Administrators |
| `api_events` | `p`, `after_id` (default 0), `max_rows` (default 500, at most 1,000) | Audit events after a cursor: `id`, time, actor pseudonym, action, entity. No details. Pass the returned `next` as `after_id` to continue | Administrators |
| `api_results` | `p`, `p_table` (optional) | The latest published results snapshot, or one table of it | Administrators |
| `get_my_profile` | none | Your profile | Anyone |

### Write (read-write tokens)

| Function | Arguments | Purpose |
|---|---|---|
| `import_items` | `p`, `p_items` (array of items), `p_contexts` (array) | Add items; at most a few thousand per call |
| `delete_items` | `p`, `ids` | Delete items without judgments |
| `add_assignments` | `p`, `p_rows` (`[{itemId, userId}]`) | Assign items |
| `create_project`, `update_project`, `set_project_status`, `import_archive` | see the migration | Manage projects |
| `upsert_membership`, `invite_member` | see the migration | Manage the team |
| `save_assessment`, `reopen_assessment` | see the migration | Record judgments, for example from an automated rater registered as an adjudicator |
| `propose_resolution`, `approve_resolution`, `finalize_resolution`, `escalate_item`, `add_discussion`, `open_disclosure` | see the migration | Resolution workflow |

An item for `import_items` is `{"externalId": "...", "batch": "", "category": "", "fields": {...}, "importedAt": "", "seq": 1}`; every key in `fields` is kept and can be displayed, blinded or used for subgroups.

The full signature of every function is in `supabase/migrations/`.

## Published results

Final classifications and reliability are computed by the same code as the downloads. An administrator publishes them from **Export > Publish results to the API** when they are ready; nothing is published automatically. A snapshot holds these tables, with adjudicators by pseudonym:

`final_classifications`, `agreement`, `outstanding`, `reliability`, `reliability_pairwise`, `reference_comparison`, `data_dictionary`

Their columns are described in [DATA_FORMATS.md](DATA_FORMATS.md). The last ten snapshots are kept.

## Examples

### Python

```python
import os
import requests

BASE, KEY, TOKEN = os.environ["AGREEMETRY_BASE"], os.environ["AGREEMETRY_KEY"], os.environ["AGREEMETRY_TOKEN"]
HEADERS = {"apikey": KEY, "X-Agreemetry-Token": TOKEN, "Content-Type": "application/json"}

def call(fn, **args):
    r = requests.post(f"{BASE}/rpc/{fn}", json=args, headers=HEADERS, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(r.json().get("message", r.text))
    return r.json()

project = "<project id>"
print(call("api_project_status", p=project)["states"])

# Follow progress incrementally.
cursor = 0
batch = call("api_events", p=project, after_id=cursor)
cursor = batch["next"]

# Read the published final classifications into pandas.
import pandas as pd
final = pd.DataFrame(call("api_results", p=project, p_table="final_classifications")["tables"]["final_classifications"])
```

### R

```r
library(httr2)

call <- function(fn, ...) {
  request(paste0(Sys.getenv("AGREEMETRY_BASE"), "/rpc/", fn)) |>
    req_headers(apikey = Sys.getenv("AGREEMETRY_KEY"), `X-Agreemetry-Token` = Sys.getenv("AGREEMETRY_TOKEN")) |>
    req_body_json(list(...)) |>
    req_perform() |>
    resp_body_json(simplifyVector = TRUE)
}

project <- "<project id>"
status <- call("api_project_status", p = project)
rel <- call("api_results", p = project, p_table = "reliability")$tables$reliability
```

### Pushing items from another platform

```python
items = [{"externalId": rec["id"], "batch": "2026-11", "category": "", "fields": rec, "importedAt": "", "seq": i + 1}
         for i, rec in enumerate(records)]
for start in range(0, len(items), 500):
    call("import_items", p=project, p_items=items[start:start + 500], p_contexts=[])
```

## Webhooks

Under **Settings > Integrations**, an administrator adds an `https://` address and chooses events. When one happens, Agreemetry sends a `POST` with a JSON body such as:

```json
{"id": 42, "event": "resolution.finalize", "projectId": "<project id>", "entity": "resolution", "entityId": "<resolution id>", "at": "2026-11-10T14:03:22.120Z"}
```

The body never contains judgments, names or item content: fetch details through the API with a token. Headers:

| Header | Content |
|---|---|
| `X-Agreemetry-Event` | The event name |
| `X-Agreemetry-Delivery` | The delivery number, the same as `id` in the body |
| `X-Agreemetry-Signature` | `sha256=` and the HMAC SHA-256 of the raw body with the webhook's signing secret |

Verify the signature over the raw request body before trusting it:

```python
import hashlib, hmac

def verified(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

Events: `assessment.submit`, `assessment.reopen`, `resolution.propose`, `resolution.approve`, `resolution.finalize`, `resolution.reopen`, `item.escalate`, `items.import`, `items.delete`, `assignments.generate`, `disclosure.open`, `project.status`, `project.update`, `project.lab`, `member.upsert`, `member.invite`, `member.accept_invite`, `member.lab_grant`, `member.lab_revoke`, `results.publish`, or `*` for all.

Delivery uses Supabase's `pg_net` extension, which sends once and does not retry. Treat webhooks as a prompt to look, and use `api_events` with a stored cursor as the reliable record: it lists every event, including any whose delivery failed.

## Limits and good practice

- Supabase applies its own request limits per project; keep batches to a few hundred items per call.
- Use one token per integration, so you can revoke one without breaking the others.
- A token limited to one project sees only that project, even in `list_my_projects`.
- An adjudicator's token sees what the adjudicator sees: blinded fields are removed and other judgments stay hidden until disclosure.
