/**
 * End-to-end smoke test of a built Agreemetry (local workspace) in a real Chrome or Edge.
 *   npm run build && npx vite preview --port 4173 &
 *   node tests/e2e/smoke.mjs http://localhost:4173/ <screenshot-folder> "<path to chrome.exe or msedge.exe>"
 * Fails on any page error or console error, and on missing key content.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [base = 'http://localhost:4173/', out = 'e2e-shots', exe = 'C:/Program Files/Google/Chrome/Application/chrome.exe'] = process.argv.slice(2);
if (!/^https?:\/\//.test(base)) throw new Error(`The first argument is the address of the app, for example http://localhost:4173/ (got "${base}").`);
mkdirSync(out, { recursive: true });
const errors = [];
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
page.on('dialog', (d) => void d.accept());

const shot = async (name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
const text = () => page.evaluate(() => document.body.innerText);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (t, sel = 'button, a, label') => {
  const ok = await page.evaluate((t, sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(t) && !e.disabled);
    if (el) el.click();
    return !!el;
  }, t, sel);
  if (!ok) throw new Error(`Not found: ${t}`);
};
const waitText = async (t, timeout = 30000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, t);
const go = async (hash) => {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await sleep(700);
};
const check = (cond, msg) => {
  if (!cond) throw new Error(`Check failed: ${msg}`);
  console.log(`ok  ${msg}`);
};
/** Set a form control found by its field label (label.field > span) or by aria-label, the way a person would. */
const setField = async (label, value) => {
  const ok = await page.evaluate((label, value) => {
    const byField = [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(label));
    const el = byField?.querySelector('input, select, textarea') ?? document.querySelector(`[aria-label="${label}"]`);
    if (!el) return false;
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.textContent.trim().startsWith(value) || o.value === value);
      if (!opt) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, label, value);
  if (!ok) throw new Error(`Field not found or value missing: ${label} = ${value}`);
  await sleep(150);
};
const signInAs = async (name) => {
  if (await page.$('button[aria-label="Sign out"]')) {
    await page.evaluate(() => document.querySelector('button[aria-label="Sign out"]').click());
  }
  await waitText('Choose your workspace identity');
  await clickText(name);
  await waitText('Projects');
};
const openProject = async (name) => {
  await go('#/');
  await waitText(name);
  await page.evaluate((n) => [...document.querySelectorAll('.projcard')].find((c) => c.textContent.includes(n)).click(), name);
  await sleep(800);
  return (await page.evaluate(() => window.location.hash)).split('/')[2];
};

// Sign-in and the demonstration projects -----------------------------------------------------------------
await page.goto(base, { waitUntil: 'networkidle0' });
await waitText('Choose your workspace identity', 60000);
await shot('01_sign_in');
await signInAs('Workspace administrator');
await waitText('Demonstration: title and abstract screening');
await shot('02_projects');
check((await page.$$('.projcard')).length >= 3, 'demonstration projects are listed');

const pid = await openProject('title and abstract screening');
await waitText('Unresolved disagreements');
await shot('03_demo_screening_dashboard');
await go(`#/p/${pid}/reliability`);
await waitText("Fleiss' kappa");
await shot('04_demo_screening_reliability');
await go(`#/p/${pid}/disagreements`);
await waitText('Independent judgments');
await page.evaluate(() => document.querySelector('table.data tbody tr.clickable')?.click());
await waitText('Propose a resolution');
await shot('05_demo_resolve');
await go(`#/p/${pid}/export`);
await clickText('Prepare preview');
await waitText('final_classifications.csv');
check(!(await text()).includes('Publish results to the API'), 'publishing to the API is offered only on the shared server');
await shot('06_demo_export');

// A copy of the rubric demonstration, rated by one adjudicator: blinding, drafts and submission ---------------
const rubric = await openProject('rubric scoring');
await go(`#/p/${rubric}/settings/lifecycle`);
await clickText('Duplicate with items');
await page.waitForFunction((r) => window.location.hash.startsWith('#/p/') && !window.location.hash.includes(r), { timeout: 30000 }, rubric);
const copy = (await page.evaluate(() => window.location.hash)).split('/')[2];
check(copy && copy !== rubric, 'a project is duplicated with its items');
await go(`#/p/${copy}/settings/team`);
await waitText('Add a member');
await setField('Existing account', 'Avery (demo)');
await setField('Role', 'Adjudicator');
await clickText('Add to project');
await waitText('Member added.');
await go(`#/p/${copy}/settings/lifecycle`);
await clickText('active');
await waitText('Project is active.');

await signInAs('Avery (demo)');
await openProject('(copy)');
await waitText('Your judgment');
await shot('07_assess_adjudicator');
const assess = await text();
check(!/applicant_group|early career|established/.test(assess), 'blinded fields do not reach the adjudicator');
await page.keyboard.press('3');
await sleep(2200);
check((await text()).includes('Draft'), 'a keyboard choice is saved as a draft automatically');
await page.type('input[type="number"]', '70');
await sleep(300);
await page.keyboard.down('Control');
await page.keyboard.press('Enter');
await page.keyboard.up('Control');
await waitText('1 of 30 submitted');
check(true, 'Ctrl+Enter submits and moves to the next item');

// Researcher profile ------------------------------------------------------------------------------------
await go('#/account');
await waitText('Researcher profile');
await setField('ORCID iD', '0000-0002-1825-0098');
await waitText('This ORCID iD is not valid');
await setField('ORCID iD', 'https://orcid.org/0000-0002-1825-0097');
await setField('Affiliation', 'Example University');
await clickText('Save profile');
await waitText('Profile saved.');
check((await text()).includes('need the shared server deployment'), 'API tokens explain that they need the shared server');
await shot('08_account');

// Labs ---------------------------------------------------------------------------------------------------
await signInAs('Workspace administrator');
await go('#/labs');
await waitText('No labs yet');
await clickText('New lab');
await setField('Name', 'Smoke Test Lab');
await clickText('Create lab');
await waitText('@smoke-test-lab');
await setField('Person', 'Blake (demo)');
await setField('Lab role', 'Administrator');
await clickText('Add', 'button');
await waitText('Added to the lab.');
check((await text()).includes('Blake (demo)'), 'a member is added to the lab');
await shot('09_lab');

await go(`#/p/${copy}/settings/lab`);
await waitText('personal project');
await setField('Owner', 'Smoke Test Lab');
await clickText('Move to this lab');
await waitText('The project now belongs to the lab.');
await go(`#/p/${copy}/settings/team`);
await waitText('Administrator through the lab');
check(true, 'lab administrators administer the lab project');
await go(`#/p/${copy}/settings/integrations`);
await waitText('need the shared server deployment');
await go('#/');
await waitText('Smoke Test Lab');
check(true, 'the project list shows the owning lab');
await go('#/labs');
await waitText('1 project');
await shot('10_labs');

// Dark mode and phone width ---------------------------------------------------------------------------------
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
await go(`#/p/${pid}/dashboard`);
await waitText('Workflow status');
await shot('11_dashboard_dark');
await page.setViewport({ width: 390, height: 844 });
for (const h of [`#/p/${pid}/dashboard`, '#/labs', '#/account']) {
  await go(h);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 1, `no horizontal page scroll at phone width on ${h.split('/').slice(-1)[0] || 'projects'} (overflow ${overflow}px)`);
}
await shot('12_mobile_account');

await browser.close();
if (errors.length) {
  console.error('Errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('smoke test passed');
