# Design system

Agreemetry's interface is built to support three kinds of work: rating material without bias, reading where a team agrees and disagrees, and interpreting reliability correctly. Colour is the main tool for the second and third, so every colour has one job and keeps it on every page. This document records those jobs, the values, how they were checked, and the rules for contributors.

The tokens live in [`src/ui/styles.css`](../src/ui/styles.css). Components refer to tokens by role, never to raw colour values.

## Principles

1. **Colour carries meaning, never decoration.** Each hue family stands for one idea. If a colour appears, it says something.
2. **Disagreement is information, not an error.** Red is reserved for errors and destructive actions. Disagreements use orange, so the interface never implies that a rater who disagrees has made a mistake.
3. **A rater working blind sees no agreement cues.** On the rating page, a rater's own progress (submitted, draft) uses the neutral brand indigo, never the agreement teal, because nothing is compared until disclosure. The rating options themselves are never coloured: colouring "include" green and "exclude" red would prime the judgment.
4. **Identity is stable.** Adjudicator R1 has the same colour on the dashboard, in every chart and on every judgment card.
5. **Colour never stands alone.** Every state badge has an icon and a word; every chart has a legend with counts, a tooltip and a table view; every tile has a label.
6. **Light and dark are each selected,** with steps chosen and checked for their own background, not produced by inverting one theme.

## Colour families

### Workflow states

The states form three families, ordered so the workflow bar reads from settled to pending.

| Family | State | Meaning | Light | Dark |
|---|---|---|---|---|
| Settled (teal) | Agreed | Independent judgments meet the agreement rule | `#20a28c` | `#23a48d` |
| | Resolved | A disagreement was settled through the resolution process | `#005f93` | `#3479c2` |
| Open (warm, by how much attention it needs) | Resolution proposed | A resolution is waiting for approval | `#d8981a` | `#bf8812` |
| | Escalated | Handed to the lead | `#a3352d` | `#c43c4c` |
| | Disagreement | Judgments are in and fail the rule, no action yet | `#e5742c` | `#d67a2e` |
| Pending (slate) | In progress | Some of the required judgments are in | `#64748b` | `#8a96aa` |
| | Awaiting judgments | None of the required judgments are in | `#94a3b8` | `#5d687c` |
| | Unassigned | No adjudicator yet | `#cbd5e1` | `#39424f` |

The pending states are deliberately low in colour: grey means there is nothing to compare yet. Within the slate ramp, more contrast with the background means further along.

Each state also has a text colour and a soft background for badges and highlighted values (for example `--dispute-ink` on `--dispute-soft`). The dashboard tiles use the same families: the agreement tile is teal, the disagreement tile orange, the resolved tile deep ocean, and the unresolved tile brick when anything is outstanding.

### Adjudicators

| Pseudonym | Light | Dark |
|---|---|---|
| R1 | `#2a78d6` blue | `#4a8fe6` |
| R2 | `#c2457a` magenta | `#d25f8f` |
| R3 | `#7a5cd6` violet | `#9077e6` |
| R4 | `#8f7400` gold | `#a88a12` |

These hues stay clear of the teal and warm families, so a rater is never mistaken for a workflow state. The colour comes from the pseudonym's number (`raterColor` in [`src/ui/components.tsx`](../src/ui/components.tsx)). Beyond four adjudicators no colour is assigned; hues are never generated or cycled, and charts with more than four series show a table instead.

### Brand and interface

| Role | Light | Dark | Used for |
|---|---|---|---|
| Brand indigo (`--accent`) | `#3b48c4` | `#97a2f7` | Actions, navigation, selection, the rater's own progress, and single estimates in charts |
| Page | `#f4f6fa` | `#0e1219` | Background behind cards |
| Surface | `#ffffff` | `#161b24` | Cards, tables, charts |
| Ink | `#101828` | `#e8ecf3` | Main text |
| Secondary ink | `#3f4a5c` | `#b6bfcd` | Descriptions |
| Muted | `#5d6779` | `#8f99ab` | Hints, axis labels |
| Error (`--critical`) | `#c4321f` | `#e5544a` | Errors and destructive actions only |

The logo is two overlapping circles, indigo and teal: two independent judgments, with the region where they agree filled in the agreement teal.

## Charts

- **Workflow bar.** One stacked bar in the state colours, with the legend grouped as Settled, Open and Pending and a count beside each state.
- **Reliability estimates.** Points and 95% intervals in brand indigo on one shared scale. The region below 0 is shaded faintly and the lines at 0 and 1 are labelled *chance* and *perfect*, so a negative coefficient reads as "worse than chance" without explanation. Interpretation bands stay in the caption as conventions, not standards.
- **Agreement matrix.** Two one-hue ramps: cells on the diagonal (same category, agreement) in teal, cells off it (disagreement) in orange, each darker with more items. Where disagreements concentrate shows at once, for example between adjacent points of a rubric.
- **Adjudicator charts.** Category use and judgments over time use the rater colours.
- Charts are drawn on a 640-unit canvas and capped at 760 pixels wide so their text stays at reading size.

## Typography

[Inter](https://rsms.me/inter/) (variable weight), bundled with the application through `@fontsource-variable/inter` under the SIL Open Font License 1.1. The browser only downloads the character subsets a page uses, and no font is fetched from a third party, so adjudicators' browsers make no outside requests. Numbers in tables use tabular figures so columns align.

## How the colours were checked

**Palette checks.** The state and rater palettes were run through a palette validator that computes, rather than estimates, four things:
- lightness within a band suitable for marks;
- enough colour that a hue does not read as grey;
- separation between neighbouring colours under simulated red-green colour vision deficiency (OKLab distance times 100, target at least 8);
- separation for full colour vision (at least 15).

Results on the final values:

| Set | Lightness and colour | Worst neighbour, colour vision deficiency | Worst neighbour, full colour vision | Contrast with background |
|---|---|---|---|---|
| States, light | pass | 19.8 | 19.9 | pass, except amber at 2.49:1 |
| States, dark | pass | 12.3 | 15.2 | pass |
| Raters, light | pass | 15.0 | 19.1 | pass |
| Raters, dark | pass | 13.6 | 16.8 | pass |

Amber falls below 3:1 against white by design. It always appears with a label and a count (legend, badge text), which is the required mitigation. The first candidate order put amber beside orange in the workflow bar and failed the full-colour-vision check (13.9). The order was changed so that escalated sits between them.

**Text contrast.** Every text colour meets 4.5:1 on its background in both themes. Main and secondary text are above 8:1. The state text colours on their soft backgrounds range from 4.84:1 (disagreement text, light) to 8.84:1 (proposed text, dark).

**Behaviour.** The automated tests and the browser test (light, dark and phone width) run on every change.

## Rules for contributors

- Use the tokens. Do not write colour values in components; if a new role is needed, add a token in both themes and document it here.
- Pick the family by meaning. A new workflow state joins the family it belongs to and must pass the palette checks against its neighbours in the workflow bar.
- Keep red for errors. Keep agreement teal out of anything a blind rater sees.
- Give every coloured mark a word next to it: a label, a legend entry, a tooltip or a table.
- Check both themes and phone width before opening a pull request.
