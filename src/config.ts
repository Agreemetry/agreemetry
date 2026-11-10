/**
 * Deployment settings, read from VITE_* variables at build time (see .env.example and docs/DEPLOYMENT.md).
 * None of them is secret: everything here ends up in the public JavaScript bundle.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const config = {
  /** Identity providers enabled in Supabase Auth, offered next to the email link, e.g. "github,google". */
  authProviders: (env.VITE_AUTH_PROVIDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Terms of use and privacy notice of this deployment, shown at registration. */
  termsUrl: env.VITE_TERMS_URL?.trim() ?? '',
  privacyUrl: env.VITE_PRIVACY_URL?.trim() ?? '',
  /** Who runs this deployment, shown at registration (for example a lab, department or person). */
  operator: env.VITE_OPERATOR_NAME?.trim() ?? '',
  repositoryUrl: 'https://github.com/agreemetry/agreemetry',
};

const PROVIDER_LABEL: Record<string, string> = { github: 'GitHub', google: 'Google', azure: 'Microsoft', gitlab: 'GitLab', bitbucket: 'Bitbucket', linkedin_oidc: 'LinkedIn' };
export const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
