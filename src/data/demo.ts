/**
 * Demonstration projects with SIMULATED judgments. They are built by running the real workflow
 * (assessments, comparisons, proposals, approvals, escalation, reopening) through the same service the
 * application uses, so they double as an end-to-end exercise. Every name says "Demonstration".
 */
import type { Item, Project, RatingValue } from '../core/types';
import { MemDb, Service } from './service';
import { rng } from '../core/util';
import { computeAllStatuses } from '../core/workflow';
import { fullData } from './service';

const TOPICS = ['peer tutoring', 'spaced retrieval practice', 'worked examples', 'formative feedback', 'block scheduling', 'inquiry laboratories', 'reading circles', 'growth mindset messages', 'adaptive homework', 'teacher coaching', 'outdoor learning', 'summer bridge programmes'];
const OUTCOMES = ['mathematics attainment', 'reading comprehension', 'science attitudes', 'attendance', 'course completion', 'retention in STEM majors'];
const DESIGNS = ['a cluster randomized trial', 'a quasi-experimental study', 'a cross-sectional survey', 'a qualitative case study', 'a systematic review', 'a pilot evaluation'];
const SETTINGS = ['primary schools', 'secondary schools', 'community colleges', 'first-year university courses', 'after-school programmes'];

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function makeItems(projectId: string, n: number, make: (i: number, r: () => number) => { id: string; batch: string; fields: Record<string, string | number> }, seed: string): Item[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const x = make(i, r);
    return { id: `${projectId}_it${String(i + 1).padStart(3, '0')}`, projectId, externalId: x.id, batch: x.batch, category: '', fields: x.fields, importedAt: '', seq: i + 1 };
  });
}

/** A rater who reports the true value with probability acc, otherwise a nearby or random value. */
function noisy(r: () => number, truth: string, codes: string[], acc: number, ordinal = false): string {
  if (r() < acc) return truth;
  if (ordinal) {
    const i = codes.indexOf(truth);
    const j = Math.max(0, Math.min(codes.length - 1, i + (r() < 0.5 ? -1 : 1)));
    return codes[j === i ? (i + 1) % codes.length : j];
  }
  const others = codes.filter((c) => c !== truth);
  return pick(r, others);
}

export function seedDemos(db: MemDb, adminId: string): Project[] {
  const admin = new Service(db, adminId);
  const people = ['Avery (demo)', 'Blake (demo)', 'Casey (demo)', 'Drew (demo lead)'].map((n) => admin.createUser(n));
  const [a, b, c, lead] = people;
  const projects: Project[] = [];

  // 1. Screening, three reviewers, majority rule ------------------------------------------------------
  {
    let p = admin.createProject({ name: 'Demonstration: title and abstract screening (3 reviewers)', description: 'Simulated screening of fictional study records by three reviewers. Unanimity is required; a 2 to 1 split goes to resolution, where adopting the majority is one option. Shows multi-rater reliability, discussion, escalation and a reopened decision. All judgments are simulated.', objectives: 'Decide eligibility of each record for a fictional review of classroom interventions.', templateId: 'screening' });
    p = { ...p, status: 'active', config: { ...p.config, requiredAdjudicators: 3, agreement: { ...p.config.agreement, rule: 'unanimous' }, assignment: { mode: 'all', seed: 'demo-screening' } }, provenance: 'Generated records; no real studies.' };
    p = admin.updateProject(p);
    const truthOf = new Map<string, string>();
    const items = makeItems(p.id, 48, (i, r) => {
      const topic = pick(r, TOPICS);
      const outcome = pick(r, OUTCOMES);
      const design = pick(r, DESIGNS);
      const setting = pick(r, SETTINGS);
      const eligible = design.includes('trial') || design.includes('quasi') ? (r() < 0.8 ? 'include' : 'maybe') : r() < 0.15 ? 'maybe' : 'exclude';
      truthOf.set(`S${i + 1}`, eligible);
      return {
        id: `S${String(i + 1).padStart(3, '0')}`, batch: i < 24 ? 'search 1' : 'search 2',
        fields: { title: `Effects of ${topic} on ${outcome} in ${setting}: ${design}`, abstract: `This fictional record describes ${design} of ${topic} in ${setting}, reporting ${outcome}. It was generated for the Agreemetry demonstration and does not describe a real study.`, year: 2018 + Math.floor(r() * 8), source: pick(r, ['Database A', 'Database B']) },
      };
    }, 'demo-screen-items');
    admin.importItems(p.id, items);
    for (const u of [a, b, c]) admin.upsertMembership({ projectId: p.id, userId: u.id, role: 'adjudicator', pseudonym: '', active: true, adjudicates: true });
    admin.upsertMembership({ projectId: p.id, userId: lead.id, role: 'lead', pseudonym: '', active: true, adjudicates: false });
    const codes = ['include', 'exclude', 'maybe'];
    const stored = fullData(db, p.id).items;
    const accs = [0.9, 0.82, 0.76];
    [a, b, c].forEach((u, k) => {
      const s = new Service(db, u.id);
      const r = rng(`demo-screen-${k}`);
      stored.forEach((it, idx) => {
        if (k === 2 && idx >= 42) return; // the third reviewer has not finished
        const truth = truthOf.get(`S${it.seq}`)!;
        const decision = noisy(r, truth, codes, accs[k]);
        const values: Record<string, RatingValue> = { decision, reason: decision === 'exclude' ? pick(r, ['population', 'design', 'outcome']) : null, note: '' };
        s.saveAssessment(p.id, { itemId: it.id, values, comment: '', evidence: '', submit: idx < 46 || k === 0, expectedVersion: 0 });
      });
    });
    const st = computeAllStatuses(fullData(db, p.id));
    const disputed = [...st.values()].filter((x) => x.state === 'disagreement');
    // Resolve the first few by discussion, escalate one, finalize one by the lead and reopen it.
    // Majority decisions on two 2 to 1 splits.
    disputed.filter((x) => x.comparisons.decision.modalShare > 0.5).slice(0, 2).forEach((x) => {
      const pr = new Service(db, x.submitted[0]).proposeResolution(p.id, { itemId: x.itemId, optionId: 'majority', values: {}, rationaleIds: ['rule'], freeText: '', references: '' });
      for (const o of x.submitted.filter((v) => v !== x.submitted[0])) new Service(db, o).approveResolution(p.id, pr.id);
    });
    const open = computeAllStatuses(fullData(db, p.id));
    disputed.splice(0, disputed.length, ...[...open.values()].filter((x) => x.state === 'disagreement'));
    disputed.slice(0, 3).forEach((x, i) => {
      const [u1, u2] = x.submitted;
      new Service(db, u1).addDiscussion(p.id, x.itemId, 'The abstract names a comparison group, so the design criterion is met.');
      const prop = new Service(db, u1).proposeResolution(p.id, { itemId: x.itemId, optionId: 'new', values: { decision: 'include' }, rationaleIds: ['reinterpretation', 'discussion'], freeText: 'Agreed after discussion that the design is eligible.', references: '' });
      const others = x.submitted.filter((v) => v !== u1);
      for (const o of others.slice(0, i === 2 ? 1 : others.length)) new Service(db, o).approveResolution(p.id, prop.id);
      void u2;
    });
    if (disputed[3]) new Service(db, disputed[3].submitted[0]).escalate(p.id, disputed[3].itemId, 'Unclear whether a pilot counts as an evaluation; needs the lead.');
    if (disputed[4]) {
      const ls = new Service(db, lead.id);
      const pr = ls.proposeResolution(p.id, { itemId: disputed[4].itemId, optionId: 'insufficient', values: { decision: null }, rationaleIds: ['insufficient'], freeText: 'Abstract too short to decide; retrieve the full text.', references: '' });
      ls.finalizeResolution(p.id, pr.id);
      admin.reopenResolution(p.id, pr.id, 'Full text obtained; decision to be revisited.');
    }
    projects.push(p);
  }

  // 2. Rubric scoring, two raters, ordinal and numeric ---------------------------------------------------
  {
    let p = admin.createProject({ name: 'Demonstration: rubric scoring of proposals (2 raters)', description: 'Simulated rubric levels and scores for fictional proposals. Shows weighted kappa, Krippendorff\'s ordinal and interval alpha, and intraclass correlations. All judgments are simulated.', objectives: 'Rate the quality of each fictional proposal.', templateId: 'rubric' });
    p = admin.updateProject({ ...p, status: 'active', config: { ...p.config, display: { titleField: 'title', bodyField: 'summary', visibleFields: ['call'], blindedFields: ['applicant_group'] }, assignment: { mode: 'all', seed: 'demo-rubric' } }, provenance: 'Generated proposals; no real applicants.' });
    const quality = new Map<number, number>();
    const items = makeItems(p.id, 30, (i, r) => {
      const q = 1 + Math.floor(r() * 4);
      quality.set(i + 1, q);
      return { id: `P${String(i + 1).padStart(2, '0')}`, batch: 'round 1', fields: { title: `Proposal ${i + 1}: ${pick(r, TOPICS)} for ${pick(r, OUTCOMES)}`, summary: 'A fictional proposal summary generated for the demonstration.', call: pick(r, ['Call A', 'Call B']), applicant_group: pick(r, ['early career', 'established']) } };
    }, 'demo-rubric-items');
    admin.importItems(p.id, items);
    for (const u of [a, b]) admin.upsertMembership({ projectId: p.id, userId: u.id, role: 'adjudicator', pseudonym: '', active: true, adjudicates: true });
    const stored = fullData(db, p.id).items;
    [a, b].forEach((u, k) => {
      const s = new Service(db, u.id);
      const r = rng(`demo-rubric-${k}`);
      for (const it of stored) {
        const q = quality.get(it.seq)!;
        const level = noisy(r, String(q), ['1', '2', '3', '4'], 0.7, true);
        const score = Math.max(0, Math.min(100, Math.round(q * 22 + (r() - 0.5) * 24 + (k === 1 ? 4 : 0))));
        s.saveAssessment(p.id, { itemId: it.id, values: { quality: level, score }, comment: '', evidence: '', submit: true, expectedVersion: 0 });
      }
    });
    const st = computeAllStatuses(fullData(db, p.id));
    const disputed = [...st.values()].filter((x) => x.state === 'disagreement');
    for (const x of disputed.slice(0, 4)) {
      const [u1, u2] = x.submitted;
      const sv = new Service(db, u1);
      const pr = sv.proposeResolution(p.id, { itemId: x.itemId, optionId: 'retain', retainedUserId: u2, values: {}, rationaleIds: ['definition'], freeText: '', references: 'Rubric anchor 3' });
      new Service(db, u2).approveResolution(p.id, pr.id);
    }
    projects.push(p);
  }

  // 3. Thematic coding, three coders, two per excerpt -------------------------------------------------------
  {
    let p = admin.createProject({ name: 'Demonstration: thematic coding with distributed assignment', description: 'Simulated multi-label coding of fictional interview excerpts. Three coders, two per excerpt by balanced rotation. Shows per-label reliability and Krippendorff\'s alpha with varying raters. All judgments are simulated.', objectives: 'Apply codes to excerpts.', templateId: 'thematic' });
    const cfg = p.config;
    cfg.variables[0] = { ...cfg.variables[0], categories: [{ value: 'belonging', label: 'Belonging' }, { value: 'workload', label: 'Workload' }, { value: 'feedback', label: 'Feedback' }, { value: 'identity', label: 'Science identity' }] };
    p = admin.updateProject({ ...p, status: 'active', config: { ...cfg, requiredAdjudicators: 2, assignment: { mode: 'fixed_k', k: 2, seed: 'demo-thematic' } }, provenance: 'Generated excerpts; no real participants.' });
    const truth = new Map<number, string[]>();
    const items = makeItems(p.id, 36, (i, r) => {
      const t = ['belonging', 'workload', 'feedback', 'identity'].filter(() => r() < 0.35);
      truth.set(i + 1, t);
      return { id: `E${String(i + 1).padStart(2, '0')}`, batch: 'interviews', fields: { excerpt_id: `Excerpt ${i + 1}`, excerpt: `A fictional student remark touching on ${t.length ? t.join(' and ') : 'none of the codes'}.`, source: `Interview ${1 + (i % 6)}` } };
    }, 'demo-thematic-items');
    admin.importItems(p.id, items);
    for (const u of [a, b, c]) admin.upsertMembership({ projectId: p.id, userId: u.id, role: 'adjudicator', pseudonym: '', active: true, adjudicates: true });
    admin.generateAssignments(p.id);
    const d = fullData(db, p.id);
    for (const asg of d.assignments) {
      const it = d.items.find((x) => x.id === asg.itemId)!;
      const r = rng(`demo-thematic-${asg.userId}-${it.id}`);
      const t = truth.get(it.seq)!;
      const codes = ['belonging', 'workload', 'feedback', 'identity'].filter((x) => (t.includes(x) ? r() < 0.88 : r() < 0.08));
      new Service(db, asg.userId).saveAssessment(p.id, { itemId: it.id, values: { codes, memo: '' }, comment: '', evidence: '', submit: true, expectedVersion: 0 });
    }
    projects.push(p);
  }
  return projects;
}
