"""The ``keel`` command line."""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import typing
import webbrowser

import rich
import rich.console
import rich.markup
import rich.panel
import rich.table
import typer

app = typer.Typer(
    help="Keel: one AI steward per team.", no_args_is_help=True, add_completion=False, rich_markup_mode="rich"
)
console = rich.console.Console()
# Progress, notes and errors: stderr keeps stdout clean for --json and pipes.
notes = rich.console.Console(stderr=True)
SEVERITY_STYLE = {"high": "bold red", "medium": "yellow", "low": "cyan"}
GRADE_STYLE = {"A": "bold green", "B": "green", "C": "yellow", "D": "dark_orange", "F": "bold red"}
RUNNER_POLL_S = (
    5.0  # Idle wait between polls; a runbook is never so urgent that 5 s matters, and it keeps load low.
)
RUNNER_COMMAND_TIMEOUT_S = 600  # Ten minutes covers a rollout restart; longer means something is stuck.
RUNNER_OUTPUT_CHARS = 4000  # Tail of a command's output sent back; enough to explain a failure.
BROWSER_DELAY_S = 1.5  # Let uvicorn bind before the browser asks for the page.


def _banner() -> None:
    console.print(
        rich.panel.Panel.fit("[bold]⚓ Keel[/]  [dim]one AI steward per team[/]", border_style="magenta")
    )


def _serve(host: str, port: int, open_browser: bool) -> None:
    import uvicorn

    from keel.api import app as webapp

    url = (
        os.environ.get("KEEL_BASE_URL")
        or f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}"
    )
    if open_browser:
        threading.Timer(BROWSER_DELAY_S, webbrowser.open, args=(url,)).start()
    console.print(f"  Open [bold cyan]{url}[/]   [dim]Ctrl+C to stop[/]\n")
    uvicorn.run(
        webapp.create_app(), host=host, port=port, log_level=os.environ.get("KEEL_LOG_LEVEL", "warning")
    )


@app.command()
def demo(
    port: int = typer.Option(8420, help="Port to serve on."),
    fresh: bool = typer.Option(False, "--fresh", help="Start the story over."),
    no_browser: bool = typer.Option(False, "--no-browser", help="Don't open a browser."),
) -> None:
    """Run the demo: three teams, three stewards, a scripted day. No accounts or keys needed."""
    from keel import config

    home = config.DEFAULT_HOME
    home.mkdir(parents=True, exist_ok=True)
    db_file = home / "demo.db"
    if fresh and db_file.exists():
        db_file.unlink()
    os.environ.setdefault("KEEL_DATABASE_URL", f"sqlite:///{db_file}")
    os.environ["KEEL_DEMO"] = "1"
    os.environ.setdefault("KEEL_BASE_URL", f"http://localhost:{port}")
    config.reset()
    _banner()
    console.print("  Demo org [bold]Acme[/]: Payments 🦉 Pip · Platform 🦫 Bolt · Mobile 🐙 Echo")
    console.print(
        "  Press [bold]Play next event[/] in the app to run the story. Nothing leaves this machine."
    )
    _serve("127.0.0.1", port, not no_browser)


@app.command()
def serve(
    host: str = typer.Option(None, help="Bind address (KEEL_HOST)."),
    port: int = typer.Option(None, help="Port (KEEL_PORT)."),
) -> None:
    """Run the web app (and the worker, unless KEEL_RUN_WORKER_IN_PROCESS=0)."""
    from keel import config

    cfg = config.get()
    cfg.effective_secret_key()
    _banner()
    _serve(host or cfg.host, port or cfg.port, False)


@app.command()
def worker() -> None:
    """Run a background worker. Run several for more throughput; they share the queue safely on Postgres."""
    import logging

    from keel import config, db
    from keel import worker as worker_mod

    logging.basicConfig(
        level=config.get().log_level.upper(), format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    if config.get().auto_migrate:
        db.migrate()
    w = worker_mod.Worker()
    console.print(f"⚓ worker [bold]{w.id}[/] polling the queue")
    try:
        w.run_forever()
    except KeyboardInterrupt:
        w.stop()


@app.command()
def migrate() -> None:
    """Upgrade the database schema. Safe to run from many replicas at once."""
    from keel import db

    before = db.current_revision()
    db.migrate()
    console.print(f"[green]✓[/] Schema at {db.current_revision()} (was {before or 'empty'}).")


@app.command()
def secret() -> None:
    """Print a new random KEEL_SECRET_KEY."""
    typer.echo(secrets.token_urlsafe(48))


@app.command()
def checkup(
    repo: str = typer.Argument(..., help="owner/name, e.g. vercel/next.js"),
    token: str = typer.Option("", envvar="GITHUB_TOKEN", help="GitHub token (raises the rate limit)."),
    api_url: str = typer.Option("https://api.github.com", help="GitHub Enterprise API URL."),
    badge: pathlib.Path = typer.Option(None, "--badge", help="Also write a README badge SVG here."),
    card: pathlib.Path = typer.Option(None, "--card", help="Also write a 1200×630 share card SVG here."),
) -> None:
    """A 30-second health checkup of a GitHub repo: what a steward would fix first."""
    from keel import checkup as ck

    repo = repo.removeprefix("https://github.com/").strip("/")
    with console.status(f"Checking [bold]{repo}[/]…"):
        try:
            findings, stats = ck.analyze(repo, token=token, api_url=api_url)
        except ck.CheckupError as exc:
            console.print(f"[red]✗[/] {exc}")
            raise typer.Exit(1) from exc
    sc = ck.score(findings)
    g = ck.grade(sc)
    _write_svg(badge, ck.badge(sc, g), "Badge")
    _write_svg(card, ck.card(repo, findings, stats), "Share card")
    console.print(
        rich.panel.Panel.fit(
            f"[{GRADE_STYLE[g]}]{g}[/]  [bold]{sc}[/]/100   {repo}",
            title="⚓ Keel checkup",
            border_style="magenta",
        )
    )
    st = rich.table.Table(show_header=False, box=None, pad_edge=False)
    for k, v in stats.items():
        st.add_row(f"[dim]{k.replace('_', ' ')}[/]", str(v))
    console.print(st)
    if not findings:
        console.print("\n[green]Nothing to fix. This repo is in good shape.[/]")
        return
    t = rich.table.Table(show_lines=False, header_style="bold")
    t.add_column("", width=2)
    t.add_column("Finding")
    t.add_column("Detail", overflow="fold")
    for f in sorted(findings, key=lambda f: ck.SEVERITY_COST[f.severity], reverse=True):
        t.add_row(
            {"high": "🔴", "medium": "🟠", "low": "🔵"}[f.severity],
            f"[{SEVERITY_STYLE[f.severity]}]{f.title}[/]",
            f.detail + (f"\n[dim]{f.url}[/]" if f.url else ""),
        )
    console.print(t)
    console.print("\n[dim]A Keel steward would keep these on a ledger and nudge owners. Try: keel demo[/]")


def _write_svg(path: pathlib.Path | None, content: str, what: str) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    notes.print(f"[green]✓[/] {what} written to [bold]{path}[/]")


def _cli_model(provider: str, model: str) -> typing.Any:
    """A chat model for one-off CLI commands, or None for the rules. Exits with one plain line on failure."""
    from keel import llm

    if not provider or provider == "replay":
        return None
    try:
        return llm.build(
            provider,
            model,
            os.environ.get("KEEL_MODEL_API_KEY", ""),
            os.environ.get("KEEL_MODEL_BASE_URL", ""),
        )
    except llm.ModelUnavailable as exc:
        console.print(f"[red]✗[/] {exc}")
        raise typer.Exit(1) from exc


PROMISE_STYLE = {
    "kept": "green",
    "overdue": "bold red",
    "quiet": "yellow",
    "dropped": "dim",
    "follow_up": "cyan",
    "open": "white",
}


@app.command()
def promises(
    repo: str = typer.Argument(..., help="owner/name, e.g. vercel/next.js"),
    days: int = typer.Option(30, "--days", min=1, max=365, help="How far back to look."),
    token: str = typer.Option("", envvar="GITHUB_TOKEN", help="GitHub token (raises the rate limit)."),
    api_url: str = typer.Option("https://api.github.com", help="GitHub Enterprise API URL."),
    provider: str = typer.Option(
        "",
        envvar="KEEL_MODEL_PROVIDER",
        help="Model that double-checks each promise (rules alone without one).",
    ),
    model: str = typer.Option("", envvar="KEEL_MODEL_NAME", help="Model name for the provider."),
    badge: pathlib.Path = typer.Option(None, "--badge", help="Also write a README badge SVG here."),
    card: pathlib.Path = typer.Option(None, "--card", help="Also write a 1200×630 share card SVG here."),
    markdown: pathlib.Path = typer.Option(
        None, "--markdown", help="Also write a Markdown summary (e.g. $GITHUB_STEP_SUMMARY)."
    ),
    as_json: bool = typer.Option(False, "--json", help="Print the full report as JSON."),
) -> None:
    """Promise archaeology: find "I'll fix it by Friday" in a repo's comments and see which were kept."""
    import json

    from keel import checkup as ck
    from keel import promises as pr

    chat = _cli_model(provider, model)
    with notes.status(f"Reading {days} days of comments on [bold]{repo}[/]…"):
        try:
            report = pr.scan(repo, days=days, token=token, api_url=api_url, model=chat)
        except ck.CheckupError as exc:
            notes.print(f"[red]✗[/] {exc}")
            raise typer.Exit(1) from exc
    _write_svg(badge, pr.badge(report), "Badge")
    _write_svg(card, pr.card(report), "Share card")
    if markdown is not None:
        with markdown.open("a", encoding="utf-8") as fh:
            fh.write(pr.markdown(report) + "\n")
        console.print(f"[green]✓[/] Summary written to [bold]{markdown}[/]")
    if as_json:
        typer.echo(json.dumps(report.as_dict(), indent=2, default=str))
        return
    st = report.stats
    console.print(
        rich.panel.Panel.fit(
            f"[bold]{pr.rate_text(st['kept_rate'])}[/] kept   {st['promises']} promises in "
            f"{report.scanned_comments} comments   {report.repo}",
            title="⚓ Keel promise check",
            border_style="magenta",
        )
    )
    if not report.promises:
        console.print("\n[green]No promises found in that window.[/] Try a longer one with --days 90.")
        return
    t = rich.table.Table(header_style="bold", show_lines=False)
    t.add_column("Status")
    t.add_column("Who")
    t.add_column("Promise", overflow="fold")
    t.add_column("Said", justify="right")
    order = {s: i for i, s in enumerate(("overdue", "quiet", "open", "follow_up", "dropped", "kept"))}
    for p in sorted(report.promises, key=lambda p: (order[p.status], -p.age_days)):
        t.add_row(
            f"[{PROMISE_STYLE[p.status]}]{pr.STATUS_LABEL[p.status]}[/]",
            f"@{p.who}",
            rich.markup.escape(p.what) + f"\n[dim]“{rich.markup.escape(p.quote)}”  {p.url}[/]",
            f"{round(p.age_days)}d ago" + (f"\n[dim]due {p.due}[/]" if p.due else ""),
        )
    console.print(t)
    if st["kept_rate"] is None:
        console.print(f"[dim]Too few settled promises for a rate (need {pr.MIN_JUDGED}).[/]")
    hint = "" if chat else " Add --provider for a model to double-check each promise."
    console.print(
        "[dim]Kept = the issue or PR closed as completed after the promise. Not checked: "
        + "; ".join(report.not_checked)
        + "."
        + hint
        + "[/]"
    )


@app.command()
def wrapped(
    team: str = typer.Argument(..., help="Team slug, e.g. payments"),
    days: int = typer.Option(30, "--days", min=1, max=366, help="Period to recap."),
    card: pathlib.Path = typer.Option(None, "--card", help="Also write a 1200×630 share card SVG here."),
    as_json: bool = typer.Option(False, "--json", help="Print the recap as JSON."),
) -> None:
    """Team Wrapped: a team's month of promises as a recap card (Spotify Wrapped for work)."""
    import json

    import sqlalchemy as sa

    from keel import db, llm, models, steward
    from keel import wrapped as wr

    db.migrate()
    with db.session() as s:
        org = s.scalar(sa.select(models.Org).limit(1))
        row = steward.team_by_slug(s, org.id, team) if org else None
        if row is None:
            notes.print(f"[red]✗[/] No team called {team!r}. Run [bold]keel demo[/] or create one first.")
            raise typer.Exit(1)
        facts = wr.compute(s, row, days=days)
        facts["headline"] = wr.headline(llm.for_org(s, org.id), facts)
    _write_svg(card, wr.card(facts), "Share card")
    if as_json:
        typer.echo(json.dumps(facts, indent=2, default=str))
        return
    rate = facts["on_time_rate"]
    console.print(
        rich.panel.Panel.fit(
            f"[bold]{facts['persona']['name']}[/]\n{rich.markup.escape(facts['headline'])}",
            title=f"⚓ {facts['team']} Wrapped · {facts['from']} → {facts['to']}",
            border_style="magenta",
        )
    )
    t = rich.table.Table(show_header=False, box=None, pad_edge=False)
    t.add_row("[dim]kept on time[/]", "n/a" if rate is None else f"{round(rate * 100)}%")
    t.add_row("[dim]kept · new[/]", f"{facts['kept']} · {facts['made']}")
    t.add_row("[dim]longest on-time streak[/]", str(facts["longest_on_time_streak"]))
    if facts["fastest"]:
        t.add_row("[dim]fastest close[/]", f"{facts['fastest']['key']} in {facts['fastest']['hours']:g} h")
    if facts["best_partner"]:
        t.add_row(
            "[dim]best partner[/]", f"{facts['best_partner']['team']} ({facts['best_partner']['count']})"
        )
    if facts["top_closers"]:
        t.add_row("[dim]top closers[/]", ", ".join(f"{c['who']} ({c['kept']})" for c in facts["top_closers"]))
    if facts["busiest_day"]:
        t.add_row("[dim]busiest day[/]", facts["busiest_day"])
    if facts["oldest_open"]:
        o = facts["oldest_open"]
        t.add_row("[dim]still open[/]", f"{o['key']} {rich.markup.escape(o['title'])} ({o['days']} days)")
    console.print(t)


@app.command()
def mcp(
    user: str = typer.Option(
        "",
        "--as",
        envvar="KEEL_MCP_USER",
        help="Email of the Keel user the tools act as (sets what they can see).",
    ),
) -> None:
    """Run an MCP server on stdio so Claude Code, Cursor or any MCP client can talk to your teams' stewards."""
    from keel import mcp_server

    mcp_server.serve(user)


@app.command()
def apply(
    file: pathlib.Path = typer.Option(..., "-f", "--file", exists=True, help="keel.yaml"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show the plan without changing anything."),
) -> None:
    """Create or update teams, stewards, services and knowledge from a YAML file (GitOps)."""
    from keel import db, gitops

    db.migrate()
    plan = gitops.load(file)
    with db.session() as s:
        changes = gitops.apply(s, plan, base_dir=file.parent, dry_run=dry_run)
    for verb, what in changes:
        icon = {"create": "[green]+[/]", "update": "[yellow]~[/]", "keep": "[dim]=[/]", "skip": "[red]![/]"}[
            verb
        ]
        console.print(f"  {icon} {rich.markup.escape(what)}")
    n = sum(1 for v, _ in changes if v in ("create", "update"))
    console.print(f"\n{'Would change' if dry_run else 'Changed'} {n} thing{'s' if n != 1 else ''}.")


@app.command()
def runner(
    server: str = typer.Option(..., envvar="KEEL_SERVER", help="Keel base URL."),
    token: str = typer.Option(..., envvar="KEEL_RUNNER_TOKEN", help="Shared runner token."),
    allow: pathlib.Path = typer.Option(..., "--allow", exists=True, help="YAML: runbook id → command."),
    name: str = typer.Option("", help="Runner name shown in the activity feed."),
    once: bool = typer.Option(False, "--once", help="Handle at most one run, then exit."),
) -> None:
    """Run approved runbooks next to your services. Outbound only; runs only commands in --allow."""
    import httpx
    import yaml

    allowed: dict[str, str] = yaml.safe_load(allow.read_text()) or {}
    name = name or os.uname().nodename
    headers = {"Authorization": f"Bearer {token}"}
    console.print(f"🏃 runner [bold]{name}[/] → {server}  ({len(allowed)} allowed runbooks)")
    while True:
        try:
            r = httpx.post(
                f"{server.rstrip('/')}/api/runner/next", json={"runner": name}, headers=headers, timeout=30
            )
            r.raise_for_status()
            op = r.json()["op"]
        except httpx.HTTPError as exc:
            console.print(f"[yellow]Couldn't reach Keel ({type(exc).__name__}); retrying.[/]")
            op = None
        if op:
            ok, output = _run_allowed(allowed, op)
            console.print(f"{'[green]✓' if ok else '[red]✗'}[/] {op['summary']}")
            httpx.post(
                f"{server.rstrip('/')}/api/runner/report",
                headers=headers,
                timeout=30,
                json={"id": op["id"], "ok": ok, "output": output[-RUNNER_OUTPUT_CHARS:]},
            ).raise_for_status()
        if once and op:
            return
        if not op:
            if once:
                console.print("Nothing to run.")
                return
            time.sleep(RUNNER_POLL_S)


def _run_allowed(allowed: dict[str, str], op: dict[str, typing.Any]) -> tuple[bool, str]:
    """Run the local allow-listed command for this runbook. The server's command text is never executed."""
    cmd = allowed.get(op.get("runbook") or "")
    if not cmd:
        return False, f"Runbook {op.get('runbook')!r} isn't in this runner's allow-list."
    try:
        p = subprocess.run(
            shlex.split(cmd), capture_output=True, text=True, timeout=RUNNER_COMMAND_TIMEOUT_S, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"{type(exc).__name__}: {exc}"
    return p.returncode == 0, (p.stdout + p.stderr).strip() or f"exit {p.returncode}"


@app.command()
def backup(out: pathlib.Path = typer.Option(None, "-o", help="Output file.")) -> None:
    """Back up the database (pg_dump custom format, or a SQLite copy)."""
    from keel import config

    url = config.get().database_url
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    if url.startswith("sqlite"):
        out = out or pathlib.Path(f"keel-{stamp}.db")
        src = sqlite3.connect(url.split("///", 1)[1])
        with sqlite3.connect(out) as dst:
            src.backup(dst)
        src.close()
    else:
        if not shutil.which("pg_dump"):
            console.print("[red]✗[/] pg_dump isn't installed. Install the PostgreSQL client tools.")
            raise typer.Exit(1)
        out = out or pathlib.Path(f"keel-{stamp}.dump")
        subprocess.run(
            ["pg_dump", "--format=custom", "--no-owner", "--file", str(out), _libpq(url)], check=True
        )
    console.print(f"[green]✓[/] Backed up to {out} ({out.stat().st_size // 1024} KB).")


@app.command()
def restore(
    file: pathlib.Path = typer.Argument(..., exists=True),
    yes: bool = typer.Option(False, "--yes", help="Don't ask."),
) -> None:
    """Restore a backup made with ``keel backup``. Replaces current data."""
    from keel import config

    url = config.get().database_url
    if not yes:
        typer.confirm(f"Replace all data in {url.split('@')[-1]} with {file}?", abort=True)
    if url.startswith("sqlite"):
        shutil.copyfile(file, url.split("///", 1)[1])
    else:
        subprocess.run(
            ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", _libpq(url), str(file)],
            check=True,
        )
    console.print("[green]✓[/] Restored.")


def _libpq(url: str) -> str:
    return url.replace("postgresql+psycopg://", "postgresql://")


@app.command()
def doctor() -> None:
    """Check configuration, database, integrations and the web UI."""
    from keel import config, connections, db, models
    from keel.api import app as webapp

    cfg = config.get()
    rows: list[tuple[bool | None, str, str]] = []
    try:
        cfg.effective_secret_key()
        rows.append((True, "Secret key", "set" if cfg.secret_key else "generated for demo use"))
    except RuntimeError as exc:
        rows.append((False, "Secret key", str(exc)))
    rows.append(
        (
            None if cfg.is_sqlite else True,
            "Database",
            "SQLite (demo and tests only)" if cfg.is_sqlite else cfg.database_url.split("@")[-1],
        )
    )
    if db.ping():
        cur, head = db.current_revision(), db.head_revision()
        rows.append(
            (
                cur == head,
                "Schema",
                f"at {cur}" if cur == head else f"at {cur}, needs {head}: run keel migrate",
            )
        )
        with db.session() as s:
            import sqlalchemy as sa

            org = s.scalar(sa.select(models.Org))
            for kind in ("model", "slack", "github"):
                res = connections.resolve(s, org.id if org else "", kind)
                rows.append(
                    (
                        True if res.configured else None,
                        kind.title(),
                        f"configured ({res.source})" if res.configured else "not connected (optional)",
                    )
                )
    else:
        rows.append((False, "Database", "not reachable"))
    rows.append(
        (
            (webapp.WEB_DIST / "index.html").exists(),
            "Web UI",
            "built" if (webapp.WEB_DIST / "index.html").exists() else "not built: cd web && npm run build",
        )
    )
    rows.append(
        (True if cfg.sso_enabled else None, "SSO", "OIDC on" if cfg.sso_enabled else "off (passwords)")
    )
    t = rich.table.Table(show_header=False, box=None)
    for ok, what, line in rows:
        t.add_row({True: "[green]✓[/]", False: "[red]✗[/]", None: "[dim]·[/]"}[ok], f"[bold]{what}[/]", line)
    console.print(t)
    if any(ok is False for ok, _, _ in rows):
        raise typer.Exit(1)


@app.command()
def version() -> None:
    """Print the version."""
    from keel.api import app as webapp

    typer.echo(webapp.version())


if __name__ == "__main__":
    app(sys.argv[1:])
