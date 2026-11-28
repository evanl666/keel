# Knowledge

What the steward answers from. Each doc has a **label** (public, internal, confidential, restricted) that
decides who may see it and where it may be quoted; restricted docs are never quoted anywhere.

## Three ways in

1. **By hand**: the team's **Knowledge → Add**. Title, text, label, and an optional review date.
2. **Synced sources**: **Knowledge → Sources → Add** (team admins):
   - **A web page**: `https://wiki.acme.com/payments/oncall`. Keel fetches it, strips scripts and navigation,
     and keeps the text. Pages behind a login aren't supported yet; export them or use a GitHub folder.
   - **A GitHub folder**: `acme/handbook/docs/payments`. Every `.md`, `.mdx`, `.markdown`, `.txt` and `.rst`
     file under it becomes a doc, linked to the file on GitHub. Uses the GitHub credentials from setup.

   Sources sync every 24 hours and on **Sync now**. Changed files update their doc, deleted files remove it,
   and a failure shows one line on the source (e.g. "The page answered 404.") and retries within the hour.
   Removing a source removes its docs.
3. **Learned**: when nobody knows an answer and a teammate answers in the Slack thread, Keel suggests saving it
   (**Learning → Open questions**).

`keel apply` adds docs from files in your repo (`knowledge: [{path: docs/x.md, label: internal}]`), matching
by title, so re-running it updates instead of duplicating.

## Keeping it right

- **Edit** or **delete** any hand-written doc. Synced docs change at their source.
- **Review dates**: a doc can have a "review by" date. Past it, the doc is marked *stale* in the UI and counted
  in the `keel_knowledge_stale` metric. **Mark reviewed** pushes the date a quarter out.
- Answers cite the docs they used: in Slack as links (`Sources: Refunds · On-call`), in the web UI as links to
  the doc.

## Search

BM25 over ~900-character chunks, top 4 passages per question. That's enough for team-sized notes (hundreds of
docs). Chinese, Japanese and Korean text is split into character pairs, so `退款审批找谁？` finds a doc about
退款审批.
