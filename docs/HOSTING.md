# Running a public instance

Anyone may run Agreemetry under the Apache License 2.0. Running an instance that other researchers register on makes you the operator of a service that holds their research material. This page lists what that involves. It is practical guidance, not legal advice; ask your institution's research office, data protection officer or counsel where it matters.

## Before you open registration

1. **Terms of use.** Say who runs the service, what it is for, what users may upload, that there is no warranty or guaranteed availability, how accounts end, and how disputes are handled. Publish them and set `VITE_TERMS_URL`. Agreemetry records when each person accepts them.
2. **Privacy notice.** Say what personal data you keep (email address, name, optional affiliation, ORCID iD and research field, sign-in records kept by Supabase), why, where it is stored (your Supabase region), who can see it, how long you keep it, and how people can see, correct or delete it. If you have users in the European Union or the United Kingdom, the General Data Protection Regulation applies. Set `VITE_PRIVACY_URL`.
3. **Research material.** Users decide what they upload. Your terms should require that projects with identifiable or sensitive human-subjects data have the approvals their study requires, and you should consider whether your service may hold such data at all. Institutions with strict requirements can run their own instance instead.
4. **Security contact.** Keep [SECURITY.md](../SECURITY.md) current, enable GitHub's private vulnerability reporting, and apply updates promptly.
5. **Email.** Configure custom SMTP sending from your domain (see [DEPLOYMENT.md](DEPLOYMENT.md)); sign-in depends on it.

## Running it

- **Plan.** A free Supabase project pauses when idle and has small limits. A service others rely on needs a paid plan with backups.
- **Backups.** Keep database backups and test restoring them. Projects can also be exported as archives by their administrators.
- **Accounts.** An operator can deactivate an account (`profiles.active = false`) from the Supabase dashboard. Deactivation keeps the person's submitted judgments, because they are part of other people's research records.
- **Deletion requests.** Deleting a person must not silently rewrite other researchers' records. Remove or pseudonymise the profile (name, affiliation, ORCID iD, email) and keep the project pseudonym on judgments already submitted, and say so in the privacy notice.
- **Updates.** Watch the repository's releases, read the migration notes, and apply new migrations in order.

## The name

You may say that your service runs Agreemetry. If you modify the software, do not present your service as the official Agreemetry service. See [TRADEMARKS.md](../TRADEMARKS.md).
