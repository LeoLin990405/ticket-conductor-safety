# Capability spike

Throwaway Forge app for WP0. Read [docs/SPIKES.md](../../docs/SPIKES.md) before deploying.

`app.id` in git is a placeholder. `forge register` in this directory replaces it. Do not commit that edit, and do not reuse the Ticket Conductor app id.

```bash
npm ci
forge lint
```

`forge lint` needs a Forge login. Without one it stops before printing manifest errors. The manifest was checked with the schema package shipped in Forge CLI 14.2.0. See the report for the result and for the dev-site commands (`your-site.atlassian.net`, product Jira, environment development).
