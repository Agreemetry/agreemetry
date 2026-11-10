# Bundled projects (local only)

Project archives placed here (`<name>.agreemetry.json.gz` plus an `index.json` listing them) are loaded on the first launch of a local workspace. This folder is ignored by git, so study material placed here is never committed, and the deploy workflow removes it from the public site unless the repository variable `PUBLISH_BUNDLED_PROJECTS` is `true`. See docs/DEPLOYMENT.md.
