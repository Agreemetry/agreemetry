# Security policy

Agreemetry protects research judgments and the blinding between adjudicators. We take reports seriously and are grateful for them.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, discussion or pull request for a security problem.

Please include what is affected, how to reproduce it, and what an attacker could gain. We aim to acknowledge a report within five working days, agree a fix and disclosure timeline with you, and credit you in the advisory unless you prefer otherwise.

## What counts

In scope, for the shared-server deployment:

- a way to see judgments, blinded fields, names or documents that your role should not see;
- a way to change, delete or backdate submitted judgments, final decisions or the audit log;
- privilege escalation between project roles, lab roles or accounts;
- a way to use, forge or widen an API token beyond its scope, project or expiry;
- webhook payloads that leak content, or signature checks that can be bypassed;
- cross-site scripting or injection in the interface.

Out of scope:

- the local workspace, whose rules run in the browser by design and are documented as not being a security boundary;
- weaknesses of a particular deployment's configuration, such as a leaked service-role key, unless the documentation caused them;
- denial of service through volume.

## Supported versions

Security fixes go into the latest release on `main`. Operators should apply new releases and migrations promptly.
