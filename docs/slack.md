# Slack

Keel connects to Slack over **Socket Mode**: Keel opens the connection, so it works behind a firewall with no
public URL.

## Connect (3 minutes)

1. In Keel: **Setup → Slack → Download manifest** (or `curl $KEEL_BASE_URL/api/setup/slack-manifest`).
2. At [api.slack.com/apps](https://api.slack.com/apps): **Create New App → From a manifest**, pick your
   workspace, paste the manifest, **Create**.
3. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App-Level Tokens → Generate** with the `connections:write` scope. Copy it (`xapp-…`).
5. Paste both into Keel's Slack step. Keel tests them before saving and connects right away.

The manifest asks for: reading messages in channels the bot is in (`channels:history`, `groups:history`), DMs
(`im:history`, `im:write`), posting (`chat:write`), the `/keel` command, channel lists (`channels:read`,
`groups:read`) to turn `#payments` into its id, and `users:read.email` to match Slack users to Keel people.

## Point a team at its channel

In the team's **Settings**, type the channel as `#payments` or its id (`C0123ABCD`, from the channel's
**About** tab). Then **invite the bot to the channel**: `/invite @keel`.

Keel turns a name into an id:

- right away when you save, for public channels;
- for **private** channels, as soon as the bot is invited and someone posts there (Slack only lists private
  channels to a bot that's in them). It also retries every 6 hours.

The steward's status line says which state it's in: *Watching #payments*, or *Looking for #payments in Slack.
Invite the Keel app to it.*

## What people can do

| Where | What | Answer goes |
| --- | --- | --- |
| Team channel | `@keel who approves refunds over $10k?` | In the thread, with links to the docs it used |
| Team channel | "Can someone rotate the webhook secret by Friday?" | Logged as a commitment (no mention needed) |
| DM with the bot | Any question or request | In the DM. Answers use what *that person* may see |
| `/keel ask <question>` | A private answer | Only to you (ephemeral), with source links |
| `/keel` or `/keel status` | Open work and what's at risk | Only to you |
| `/keel teach <rule>` | A rule the steward follows from now on | Only to you |
| `/keel <anything else>` | A request | The steward replies in the team channel and tags you |
| `/keel help` | The list above | Only to you |

`/keel` works in the team's channel, and anywhere else for people who are on a team (it uses their first team).

### DMs: who is this?

Keel matches a Slack user to a Keel person **by email** the first time they write (that's what
`users:read.email` is for), then remembers the link. The person needs to be in Keel (invited, or signed in with
SSO) and on a team. If they aren't, the bot replies once with what to ask their admin for.

Answers in a DM never quote anything above the asker's clearance; Keel says how many sources it held back.

## What it posts

At **L1 Draft** every message waits in **Approvals** in the web UI before it's sent. At **L2 Assist** the
steward posts in its own team's channel on its own. See the README for levels.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Setup says "Slack didn't accept that bot token" | It's a user token or from another app. Use the `xoxb-` bot token and an `xapp-` app token |
| "Looking for #x in Slack" stays | The bot isn't in the channel: `/invite @keel` there, then post a message |
| `@keel` in a channel gets no answer | The channel isn't any team's, or the steward is paused or at L0 Observe |
| A DM gets "I can't tell which team you're on" | The person's Slack email isn't a Keel person on a team |
| `/keel` says "dispatch_failed" | Keel isn't running, or Socket Mode is off in the app settings |
