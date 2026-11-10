# Data formats

## Importing items

- **CSV.** UTF-8, with the comma, semicolon, tab or bar delimiter detected automatically. Quoted fields may hold commas, quotes and line breaks.
- **Excel** (.xlsx, .xls, .ods). Choose the sheet.
- **JSON.** An array of objects, or an object with an `items` array.

You choose the identifier column, plus optional batch and category columns, and the columns that must not be empty. Validation reports:

- duplicate identifiers;
- identifiers already in the project;
- missing identifiers;
- empty required values;
- signs of a wrong encoding.

Rows with errors are skipped and listed. Every column is kept unchanged as an item field.

**Context documents** are a table with a key, an optional title and a body (markdown). Each document is shown beside items whose context key field equals the key.

## Exported tables (CSV, Excel and JSON)

| Table | One row per | Contents |
|---|---|---|
| `items` | item | Agreemetry identifier, imported identifier, batch, category, import order and time, every original field (`field_<name>`) |
| `assessments_long` | item, adjudicator and variable | Value code, label, first submitted value, status (draft or submitted), version, times, comment, evidence |
| `assessments_wide` | item | Submitted values as `<variable>__<pseudonym>`: the input for reliability in other software |
| `agreement` | item | State, required and submitted judgments, agreement level, disputed variables, and per variable the outcome and the ratings |
| `final_classifications` | item | Final values and labels, and whether they come from agreement or resolution; the resolution option, retained adjudicator, rationale codes and labels, explanation, references, proposer, approvers, finalizer and time |
| `resolution_history` | proposal | Every proposed, final and superseded resolution, including reopenings and their reasons |
| `discussions`, `escalations` | message, escalation | The resolution record |
| `outstanding` | unfinished item | State, judgments still awaited (by pseudonym), disputed variables, whether disclosed |
| `reliability` | variable and statistic | Value, interval, interval method, standard error, items, role (primary, secondary or descriptive), kind (raw or chance-corrected), notes, reason if undefined |
| `reliability_pairwise` | variable and pair | Items, raw agreement, coefficient and interval |
| `reference_comparison` | reference and comparison | Agreement and kappa with each adjudicator, other references and the final classification; for binary scales, the confusion counts, sensitivity and specificity |
| `audit_log` | event | Time, actor pseudonym, action, entity, detail |
| `data_dictionary` | column | Every column of every table, the variable definitions and the category codes |

Conventions:

- comma-separated values with CRLF line endings, encoded in UTF-8;
- an empty cell means missing;
- times are UTC in ISO 8601;
- multi-label values are codes joined by `;`;
- adjudicators appear by project pseudonym unless names are requested.

The ZIP also contains:

- `project_config.json`;
- `codebook.md`;
- the re-importable `project_archive.agreemetry.json`;
- `load_in_R.R`, `load_in_python.py` and `load_in_stata.do`. For SPSS, import the CSV with the first row as variable names.

## Project archive (`.agreemetry.json`, optionally gzip-compressed)

```json
{
  "format": "agreemetry-project", "formatVersion": 1, "exportedAt": "...",
  "project": { "id": "...", "name": "...", "config": { "variables": [], "requiredAdjudicators": 2, "...": "..." }, "documents": [] },
  "users": [], "memberships": [], "items": [], "assignments": [], "contexts": [],
  "assessments": [], "resolutions": [], "discussions": [], "escalations": [], "audit": []
}
```

The types are defined in `src/core/types.ts`. In the local workspace an archive restores everything. On the shared server it restores configuration, documents, items and context documents.

## Adjudicator packages (local workspace)

| Package | Direction | Contents |
|---|---|---|
| Outgoing | Administrator to adjudicator | A project archive limited to one adjudicator: their items without blinded fields, and no one else's judgments |
| Returned | Adjudicator to administrator | `{"format": "agreemetry-assessments", "formatVersion": 1, "projectId", "userId", "pseudonym", "exportedAt", "assessments": [...]}` |

On import, submitted judgments already present are never overwritten, and invalid or unassigned judgments are skipped and counted.
