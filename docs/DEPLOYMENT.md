# Deployment

Agreemetry is a static React site plus, for teams, a Supabase project (Postgres, authentication and realtime). No other server is needed. Before opening a deployment to other researchers, read [HOSTING.md](HOSTING.md): an operator takes on responsibilities that the code cannot.

## 1. The website on GitHub Pages

1. In the repository, open **Settings > Pages** and set the source to **GitHub Actions**.
2. Pushing to `main` runs `.github/workflows/deploy-pages.yml`. It tests, builds and publishes `dist/` to `https://<owner>.github.io/<repository>/`.
3. Without Supabase variables the site is the local-workspace build: each visitor's data stays in their own browser.

A Pages site is public even when the repository is private.

### Custom domain

To serve the site from your own domain, for example `agreemetry.org`:

1. Register the domain with any accredited registrar. Turn on automatic renewal, two-factor sign-in, the registrar lock and contact privacy.
2. In GitHub, verify the domain for the account or organization that owns the repository (**Settings > Pages > Verified domains**). Verification stops anyone else from claiming it.
3. At the registrar, add DNS records:
   - for the apex domain, `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153` (and the matching `AAAA` records listed in GitHub's documentation);
   - for `www`, a `CNAME` record to `<owner>.github.io`.
4. In **Settings > Pages**, enter the custom domain and tick **Enforce HTTPS** once the certificate is issued.
5. Set the repository variable `BASE_PATH` to `/`, because the site now lives at the root of the domain, and re-run the deploy workflow.
6. Point other domains you hold (for example the `.app` version) at the main one with the registrar's forwarding, rather than serving the site twice.

A workflow deployment needs no `CNAME` file; the domain is kept in the Pages settings.

## 2. The shared server on Supabase

1. Create a Supabase project. The free plan suits trials; a deployment others rely on needs a paid plan, because free projects pause after a period of inactivity and have small limits.
2. Apply the migrations in order, either with the CLI (`supabase link --project-ref <ref>` then `supabase db push`) or by running each file in `supabase/migrations/` in the SQL editor, oldest first:
   - `20261109000000_agreemetry.sql`: projects, items, judgments, resolutions, audit, blinding and every workflow rule;
   - `20261110000000_accounts_labs_api.sql`: researcher profiles, labs, API tokens, the events feed, published results and webhooks.

   Both enable row-level security on every table and give clients no access to raw rows.
3. Check that the API token hook is registered. The second migration sets `pgrst.db_pre_request` on the `authenticator` role. In the SQL editor, `select rolconfig from pg_roles where rolname = 'authenticator';` should list `pgrst.db_pre_request=public.agm_pre_request`. If it does not, run:

   ```sql
   alter role authenticator set pgrst.db_pre_request = 'public.agm_pre_request';
   notify pgrst, 'reload config';
   ```
4. **Authentication.**
   - Under **Authentication > Providers**, enable Email (magic link). New addresses create accounts, which is how researchers register.
   - Under **Authentication > URL configuration**, set the Site URL to the site's address and add it to the redirect URLs.
   - Set up custom SMTP (**Authentication > Emails > SMTP settings**) with a transactional email service sending from your domain. Supabase's built-in sender is rate-limited and meant for testing only.
   - Optionally enable GitHub, Google or other providers, then list them in `VITE_AUTH_PROVIDERS`.
5. **Webhooks (optional).** Enable the `pg_net` extension (**Database > Extensions**) so webhooks are sent. `pgcrypto` is enabled by default and signs them. Without `pg_net`, deliveries are still recorded and the events feed works.
6. **Repository variables** (**Settings > Secrets and variables > Actions > Variables**):

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | The project URL |
   | `VITE_SUPABASE_ANON_KEY` | The anon (publishable) key, which is public by design |
   | `VITE_AUTH_PROVIDERS` | Optional, for example `github,google` |
   | `VITE_TERMS_URL`, `VITE_PRIVACY_URL` | Your terms of use and privacy notice, shown at registration |
   | `VITE_OPERATOR_NAME` | Who runs the deployment, shown at registration |
   | `BASE_PATH` | `/` with a custom domain; leave unset for `<owner>.github.io/<repository>/` |

   Never put the service-role key in the repository, the frontend, or any variable the build reads.
7. Re-run the deploy workflow. The site shows *Sign in or register*, and the top bar says *Shared server*.

### First launch on the shared server

1. Register with your email and complete your profile.
2. Optionally create a lab under **Labs** and invite colleagues; they accept the invitation after signing in.
3. Create a project, or import a project archive under **Projects > Import archive**. Configuration, documents, items and context documents are imported; judgments are not, because the server records judgments only from signed-in adjudicators.
4. Under **Settings > Team**, invite adjudicators and a lead by email. Each invitation becomes a membership when the person first signs in with that address.
5. Set the project to **active** under **Settings > Lifecycle**.

## 3. Bundled projects

A deployment can preload project archives on first launch of the local workspace. Put `<name>.agreemetry.json.gz` files and an `index.json` (`{"projects":[{"file":"<name>.agreemetry.json.gz","title":"...","description":"..."}]}`) in `public/projects/`. That folder is ignored by git, so private study material is never committed, and the deploy workflow removes it from the public site unless the repository variable `PUBLISH_BUNDLED_PROJECTS` is `true`.

## 4. Local development

```bash
cp .env.example .env.local   # optional: fill in Supabase values to develop against a shared server
npm ci
npm run dev
```

On Windows machines with Application Control policies, Rollup's native binary may be blocked. The repository therefore overrides Rollup with its WebAssembly build (`package.json`, `overrides`), which works on every platform.

## 5. Backups

- **Local workspace:** export the project archive (Export page) regularly. Browser storage can be cleared by the browser or the user.
- **Shared server:** use Supabase's database backups (point-in-time recovery on paid plans). In addition, export the archive and the ZIP at milestones, for example at disclosure and after resolution, and keep them with the study records.
