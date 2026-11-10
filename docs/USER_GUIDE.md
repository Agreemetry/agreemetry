# User guide

## Roles

| Role | Can |
|---|---|
| Administrator | Configure projects, manage the team, import items, monitor, resolve, finalize, reopen final decisions, export, and read the audit log. Sees every judgment and every blinded field. |
| Lead or final reviewer | See disclosed judgments, take part in discussion, finalize proposals, and decide escalated items. |
| Adjudicator | Rate assigned items independently, then help resolve their own disputed items after disclosure. |

A lead or administrator can also adjudicate (Settings, Team, *Also adjudicates*). Because they can see other judgments, theirs are not blind, and the dashboard says so.

## Setting up a project

1. **Projects > New project.** Pick the closest template: screening, thematic coding, verification, rubric, expert panel, or blank.
2. **Settings > Coding form.** Add the questions. Each one has:
   - a code, which becomes the column name in exports;
   - a type;
   - categories, ordered lowest to highest for ordinal questions;
   - whether it is required;
   - whether it is compared for agreement.

   Free-text questions are never compared.
3. **Settings > Team.** Add adjudicators, a lead and other administrators. Pseudonyms (R1, R2, L1) are what other members and exports see.
4. **Settings > Workflow.**
   - **Judgments per item.**
   - **Who rates what.** Either everyone rates every item, or items are distributed: a fixed number per item, balanced across adjudicators and reproducible from the seed. For distribution, save the settings and press *Generate assignments*.
   - **Presentation order.** A seeded order that differs for each adjudicator reduces order effects.
   - **Agreement rule.**
     - *Unanimous*: every judgment must match.
     - *Strict majority*: more than half must match. A tie is never a majority.
     - *Threshold*: a stated share must match.
     - Also set the numeric tolerance and how multi-label sets are compared.
   - **Disclosure.**
     - Per item, once its judgments are in.
     - When every item is complete. This is the strictest: no one learns another's tendencies while still rating.
     - Manually, by an administrator.
5. **Settings > Resolution.**
   - **Mechanism.**
     - *Discussion*: a proposal becomes final when the other adjudicators approve it.
     - *Discussion with escalation.*
     - *Majority confirmed by a lead.*
     - *Lead decides.*
   - **Approvals required.**
   - **Whether a rationale or written explanation is required.**
   - **The options.** In an option label, `{adjudicator}` becomes each adjudicator's pseudonym, so *Retain R2's original decision* appears once for each person who rated the item.
6. **Settings > Display and blinding.**
   - Choose the title field, the text field and an optional context key, an item field that selects a shared context document.
   - Mark *Blinded* every field adjudicators must not see, such as the condition, the source or the automated scores.
7. **Settings > Reference raters** (optional). Point to item fields holding another rater's codes, such as a classifier or an earlier coding. They are compared with each adjudicator and with the final classification, and never enter interrater reliability.
8. **Items > Import items.** Upload CSV, Excel or JSON, choose the identifier column, validate, then import. Use *Import context documents* for shared reference texts.
9. **Settings > Lifecycle > active.**

## Rating

- **Assess** shows your queue on the left, the item and its context document in the middle, and your judgment on the right.
- Choices save as a draft after a short pause.
- **Submit and next** (Ctrl and Enter) records your judgment and moves to your next unfinished item.
- Keys 1 to 9 pick a category for the first question. The bracket keys `[` and `]` move between items.
- Before disclosure, and only if the project allows it, you can reopen a submitted judgment to correct it, giving a reason. After disclosure it is locked.

## Resolving disagreements

**Disagreements** lists items whose required judgments are all in and fail the agreement rule. Open one to see the item, every independent judgment (with the disputed question highlighted), the discussion thread, and any pending proposal.

To propose a resolution:

1. Choose an option. Retaining one adjudicator's decision fills in that person's values.
2. Set the final values.
3. Tick one or more standard rationales and add your own explanation and references.

Other adjudicators approve. Leads and administrators can finalize directly, and escalated items are theirs to decide. An administrator can reopen a final decision with a reason; the earlier decision stays in the history as superseded.

## Reliability and monitoring

**Dashboard** shows, for any filter:

- items, judgments, items awaiting other adjudicators, agreement, disagreements, and resolved and unresolved items;
- escalations and completion;
- progress per adjudicator, the reliability summary, and judgments over time.

**Reliability** shows, for each question:

- the recommended coefficient and every applicable coefficient, with intervals, interval methods and notes;
- warnings, a cross-tabulation and category use by adjudicator;
- specific agreement and pairwise results.

Use **Restrict by field** and **Subgroups** for subsets, such as an unselected random sample, or results by condition. Blinded fields are available here to administrators.

## Exporting

**Export** offers a complete ZIP, an Excel workbook, JSON, the re-importable project archive, the codebook, and each table as CSV. Adjudicators appear by pseudonym unless you tick *Include display names*. **Report (PDF)** opens a printable summary; use the browser's print dialog and choose *Save as PDF*.

## Working without a shared server

In the local workspace, an administrator can send each adjudicator a **package**. It holds only that person's items, without blinded fields and without anyone else's judgments.

1. The adjudicator opens Agreemetry, chooses *Open an adjudicator package*, and rates.
2. From the dashboard, they choose *Return my judgments*.
3. The administrator imports the returned file on the Export page.

Submitted judgments already present are never overwritten.

## Accounts and labs

**Registering (shared server).** Enter your email address on the sign-in page; the link you receive creates your account. If the deployment offers them, you can continue with a provider such as GitHub or Google instead. At first sign-in you choose the name colleagues will see and may add your affiliation, ORCID iD and research field, then accept the deployment's terms. Change the profile at any time under **Account**.

**Labs.** A lab is a group account for a team, lab or centre.

| Lab role | Can |
|---|---|
| Owner | Everything an administrator can, plus add or remove owners and delete the lab |
| Administrator | Edit the lab, invite people, change roles, and administer every lab project |
| Member | See the lab's people and project list, and create projects in the lab |

- Create a lab under **Labs > New lab**. Invite people by email; they join when they accept under **Labs** after signing in. In the local workspace, people are added directly.
- A project belongs to a person or to a lab. Choose the owner when you create a project, or later under **Settings > Lab**.
- The lab's owners and administrators become administrators of every lab project, marked *Administrator through the lab* on the Team page. A role someone already has on a project is never replaced, so a lab administrator who rates a lab project stays blind.
- Members see the names of lab projects but open only the projects they are added to.
- A lab with projects cannot be deleted; move the projects out first.

## Integration (shared server)

- **API tokens** under **Account** let scripts and other platforms use the project as you would. Prefer read-only tokens limited to one project. See [API.md](API.md).
- **Settings > Integrations** shows the API address and the project identifier, and manages webhooks: signed messages sent to another system when chosen events happen. They carry identifiers only, never judgments or item content.
- **Export > Publish results to the API** stores the current final classifications and reliability tables as a dated snapshot that tokens can read. Nothing is published automatically.
