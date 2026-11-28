# People, invites and SSO

## Roles

| Role | Can |
| --- | --- |
| **Org admin** | Everything: people, invites, all teams, connections, audit export |
| **Team admin** | Their team's settings, members, steward, knowledge sources, approvals |
| **Member** | Ask, add and edit knowledge, approve drafts in their teams, read their teams' audit |

People only see teams they're on (org admins see all). Knowledge above someone's clearance is hidden from them
in the UI, in answers, and in Slack DMs.

## Invites (password sign-in)

**People → Invite**: email, org role, and teams with a role on each. Keel shows a link once; send it any way you
like. It works once, expires in 7 days, and can be withdrawn. Re-inviting the same email replaces the old link.
The person picks a name and password (at least 10 characters) and lands signed in.

**People** also lets an org admin change someone's org role, disable them (their session stops working at
once), or remove them. Keel won't let the last org admin demote, disable or remove themselves.

Login is throttled: 5 wrong passwords for an email (or from an IP) lock it for 15 minutes
(`KEEL_LOGIN_MAX_FAILURES`, `KEEL_LOGIN_LOCKOUT_MINUTES`).

## SSO (OpenID Connect)

Works with Okta, Entra ID (Azure AD), Google Workspace, Keycloak, Auth0, and any OIDC provider.

1. In your IdP, create an OIDC **web** app:
   - Redirect URI: `https://<your keel>/api/auth/sso/callback`
   - Scopes: `openid email profile` (plus `groups` if your IdP needs it to send groups)
2. Set, then restart:

   ```bash
   KEEL_OIDC_ISSUER=https://acme.okta.com          # the issuer URL (Keel reads /.well-known/openid-configuration)
   KEEL_OIDC_CLIENT_ID=...
   KEEL_OIDC_CLIENT_SECRET=...
   KEEL_OIDC_ADMIN_GROUP=keel-admins                # members of this group become org admins
   KEEL_OIDC_GROUPS_CLAIM=groups                    # the claim that lists groups (Entra: "groups" or "roles")
   ```

3. The sign-in page shows **Sign in with SSO**.

On each sign-in Keel checks the ID token's signature against the IdP's keys, plus issuer, audience, expiry and
nonce. Anyone your IdP lets into the app gets a member account on first sign-in, so limit who's assigned to the
app in your IdP. A pending invite for the same email is applied on first sign-in (its role and teams).

### Teams from IdP groups

In a team's **Settings → SSO groups**, list the IdP groups whose members belong on the team (e.g.
`eng-payments`). On each SSO sign-in Keel adds the person to every team whose groups they're in. It never
removes anyone: leaving a group doesn't take someone off a team (a team admin does that), so a misconfigured
claim can't empty a team.

With `keel apply`, set `sso_groups:` and `members:` per team; see the README.

## Audit

Every sign-in, invite, role change, approval and write is in **Audit**. Org admins can export it:
**Audit → Export** (CSV or JSON lines), or `GET /api/audit/export?format=csv&since=2026-01-01`. The export is
audited too. `KEEL_AUDIT_RETENTION_DAYS` deletes older rows (checked every 6 hours; 0 keeps everything).
