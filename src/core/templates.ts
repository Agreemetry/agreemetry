/**
 * Project templates. A template only pre-fills the configuration form; every field stays editable.
 */
import type { ProjectConfig, ProjectDocument, RationaleOption, ResolutionOption, Variable } from './types';

export function defaultResolutionOptions(): ResolutionOption[] {
  return [
    { id: 'retain', kind: 'retain_adjudicator', label: "Retain {adjudicator}'s original decision", description: 'Keep one adjudicator\'s independent judgment as final. One choice is listed per adjudicator who rated the item.', enabled: true },
    { id: 'majority', kind: 'majority', label: 'Adopt the majority decision', description: 'Available when a strict majority exists on every disputed variable.', enabled: true },
    { id: 'new', kind: 'new_classification', label: 'Reach a newly agreed classification', description: 'The adjudicators agree on a value none of them chose.', enabled: true },
    { id: 'modified', kind: 'modified', label: 'Modify the original classification after further review', enabled: true },
    { id: 'insufficient', kind: 'insufficient_evidence', label: 'Evidence is insufficient to decide', description: 'Final value may be left blank.', enabled: true },
    { id: 'ambiguous', kind: 'ambiguous', label: 'Ambiguous or indeterminate', description: 'Final value may be left blank.', enabled: true },
    { id: 'escalate', kind: 'escalate', label: 'Escalate for additional expert review', description: 'Moves the item to the lead or final reviewer.', enabled: true },
  ];
}

export function defaultRationales(): RationaleOption[] {
  return [
    { id: 'definition', label: 'Clarification of coding definitions', enabled: true },
    { id: 'reinterpretation', label: 'Reinterpretation of evidence', enabled: true },
    { id: 'rule', label: 'Application of a predefined decision rule', enabled: true },
    { id: 'overlooked', label: 'Identification of overlooked information', enabled: true },
    { id: 'inconsistent', label: 'Resolution of inconsistent coding', enabled: true },
    { id: 'insufficient', label: 'Insufficient or ambiguous evidence', enabled: true },
    { id: 'error', label: 'Correction of an initial classification error', enabled: true },
    { id: 'discussion', label: 'Consensus following structured discussion', enabled: true },
  ];
}

export function baseConfig(variables: Variable[]): ProjectConfig {
  return {
    variables,
    requiredAdjudicators: 2,
    assignment: { mode: 'all', seed: Math.random().toString(36).slice(2, 10) },
    order: 'random_per_adjudicator',
    agreement: { rule: 'unanimous', numericTolerance: 0, multilabelMode: 'per_label' },
    disclosure: 'item_complete',
    disclosed: false,
    allowAmendBeforeDisclosure: true,
    allowReviewSubmitted: true,
    resolution: {
      mechanism: 'discussion',
      options: defaultResolutionOptions(),
      rationales: defaultRationales(),
      allowMultipleRationales: true,
      requireRationale: true,
      requireFreeText: false,
      approvalsRequired: 0,
    },
    display: { titleField: 'title', bodyField: 'text', visibleFields: [], blindedFields: [] },
    references: [],
  };
}

export interface ProjectTemplate {
  id: string;
  name: string;
  summary: string;
  config: () => ProjectConfig;
  documents: () => ProjectDocument[];
}

const yesNo = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];

function doc(id: string, title: string, body: string, audience: 'all' | 'admin' = 'all'): ProjectDocument {
  return { id, title, body, audience };
}

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'screening',
    name: 'Systematic or scoping review screening',
    summary: 'Title and abstract or full-text eligibility, with exclusion reasons.',
    config: () => {
      const c = baseConfig([
        { id: 'decision', label: 'Eligibility', type: 'nominal', required: true, includeInAgreement: true, categories: [
          { value: 'include', label: 'Include' }, { value: 'exclude', label: 'Exclude' }, { value: 'maybe', label: 'Unsure, needs full text' }] },
        { id: 'reason', label: 'Main exclusion reason', type: 'nominal', required: false, includeInAgreement: false, categories: [
          { value: 'population', label: 'Population' }, { value: 'intervention', label: 'Intervention or exposure' }, { value: 'outcome', label: 'Outcome' },
          { value: 'design', label: 'Study design' }, { value: 'other', label: 'Other' }] },
        { id: 'note', label: 'Note', type: 'text', required: false, includeInAgreement: false },
      ]);
      c.display = { titleField: 'title', bodyField: 'abstract', visibleFields: ['year', 'source'], blindedFields: [] };
      return c;
    },
    documents: () => [doc('criteria', 'Eligibility criteria', 'State the population, concept, context and study designs that make a record eligible.')],
  },
  {
    id: 'thematic',
    name: 'Qualitative or thematic coding',
    summary: 'Multi-label codes applied to text excerpts.',
    config: () => {
      const c = baseConfig([
        { id: 'codes', label: 'Codes present', type: 'multilabel', required: true, includeInAgreement: true, categories: [
          { value: 'theme_a', label: 'Theme A' }, { value: 'theme_b', label: 'Theme B' }, { value: 'theme_c', label: 'Theme C' }] },
        { id: 'memo', label: 'Analytic memo', type: 'text', required: false, includeInAgreement: false },
      ]);
      c.display = { titleField: 'excerpt_id', bodyField: 'excerpt', visibleFields: ['source'], blindedFields: [] };
      return c;
    },
    documents: () => [doc('codebook', 'Codebook', 'Define each code with inclusion and exclusion criteria and an example.')],
  },
  {
    id: 'verification',
    name: 'Evidence extraction and verification',
    summary: 'Check extracted values or claims against a source.',
    config: () => {
      const c = baseConfig([
        { id: 'verdict', label: 'Is the extracted statement supported by the source?', type: 'nominal', required: true, includeInAgreement: true, categories: [
          { value: 'supported', label: 'Supported' }, { value: 'contradicted', label: 'Contradicted' }, { value: 'not_found', label: 'Not found in source' }] },
        { id: 'quote', label: 'Supporting quote', type: 'text', required: false, includeInAgreement: false },
      ]);
      c.display = { titleField: 'claim', bodyField: 'source_text', visibleFields: [], blindedFields: [] };
      return c;
    },
    documents: () => [doc('rules', 'Verification rules', 'Explain what counts as support and how to treat partial matches.')],
  },
  {
    id: 'rubric',
    name: 'Rubric-based evaluation',
    summary: 'Ordinal rubric levels and a numeric score per item.',
    config: () => {
      const c = baseConfig([
        { id: 'quality', label: 'Overall quality', type: 'ordinal', required: true, includeInAgreement: true, weights: 'quadratic', categories: [
          { value: '1', label: '1 Poor' }, { value: '2', label: '2 Fair' }, { value: '3', label: '3 Good' }, { value: '4', label: '4 Excellent' }] },
        { id: 'score', label: 'Score (0 to 100)', type: 'numeric', min: 0, max: 100, step: 1, numericLevel: 'interval', required: true, includeInAgreement: true },
      ]);
      c.agreement.numericTolerance = 10;
      return c;
    },
    documents: () => [doc('rubric', 'Rubric', 'Describe each level with anchors.')],
  },
  {
    id: 'expert',
    name: 'Expert assessment and consensus',
    summary: 'Several experts rate importance; majority agreement with lead finalization.',
    config: () => {
      const c = baseConfig([
        { id: 'importance', label: 'Importance', type: 'ordinal', required: true, includeInAgreement: true, weights: 'linear', categories: [
          { value: '1', label: '1 Not important' }, { value: '2', label: '2 Somewhat' }, { value: '3', label: '3 Important' }, { value: '4', label: '4 Critical' }] },
      ]);
      c.requiredAdjudicators = 3;
      c.agreement.rule = 'threshold';
      c.agreement.threshold = 0.7;
      c.resolution.mechanism = 'lead';
      return c;
    },
    documents: () => [doc('brief', 'Expert brief', 'Explain the decision the panel informs.')],
  },
  {
    id: 'blank',
    name: 'Blank project',
    summary: 'One yes or no question; add variables as needed.',
    config: () => baseConfig([{ id: 'judgment', label: 'Judgment', type: 'binary', required: true, includeInAgreement: true, categories: yesNo }]),
    documents: () => [doc('instructions', 'Instructions', 'Describe the task for adjudicators.')],
  },
];
