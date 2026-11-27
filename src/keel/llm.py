"""Model providers. Production uses LangChain chat models; ``claude_code`` is a dev-only adapter.

``claude_code`` shells out to the local Claude Code CLI (``claude -p``) with a JSON schema, so a developer
signed in to Claude Code can run Keel against a real model without an API key. It is slow (seconds per call)
and meant for local development and live tests, not production traffic.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import typing
import uuid

from langchain_core import language_models, messages, outputs
from langchain_core.utils import function_calling
from sqlalchemy import orm

from keel import connections

log = logging.getLogger(__name__)

CLAUDE_CODE_TIMEOUT_S = 240  # A multi-tool turn on a busy model can take a couple of minutes.
DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-5",
    "openai": "gpt-4.1",
    "azure_openai": "gpt-4.1",
    "ollama": "qwen2.5:14b",
    "claude_code": "sonnet",
}
PROVIDERS = ("anthropic", "openai", "azure_openai", "ollama", "claude_code", "replay")


class ModelUnavailable(RuntimeError):
    """No model is configured or the provider package is missing."""


def _render(msgs: list[messages.BaseMessage]) -> tuple[str, str]:
    system_parts: list[str] = []
    lines: list[str] = []
    for m in msgs:
        text = m.content if isinstance(m.content, str) else json.dumps(m.content)
        if isinstance(m, messages.SystemMessage):
            system_parts.append(text)
        elif isinstance(m, messages.HumanMessage):
            lines.append(f"USER:\n{text}")
        elif isinstance(m, messages.AIMessage):
            if text:
                lines.append(f"ASSISTANT:\n{text}")
            for tc in m.tool_calls:
                lines.append(
                    f"ASSISTANT CALLED TOOL {tc['name']} (id {tc['id']}) WITH {json.dumps(tc['args'])}"
                )
        elif isinstance(m, messages.ToolMessage):
            lines.append(f"TOOL RESULT (id {m.tool_call_id}):\n{text}")
        else:
            lines.append(f"{m.type.upper()}:\n{text}")
    return "\n\n".join(system_parts), "\n\n".join(lines)


class ChatClaudeCode(language_models.BaseChatModel):
    """LangChain chat model backed by the Claude Code CLI. Supports tool calling via structured output."""

    model: str = "sonnet"
    binary: str = "claude"
    timeout_s: float = CLAUDE_CODE_TIMEOUT_S

    @property
    def _llm_type(self) -> str:
        return "claude-code-cli"

    def bind_tools(
        self, tools: typing.Sequence[typing.Any], *, tool_choice: typing.Any = None, **kwargs: typing.Any
    ) -> typing.Any:
        """Bind tools; the CLI is asked for JSON with ``reply`` and ``tool_calls``."""
        formatted = [function_calling.convert_to_openai_tool(t) for t in tools]
        return self.bind(tools=formatted, tool_choice=tool_choice, **kwargs)

    def _generate(
        self,
        msgs: list[messages.BaseMessage],
        stop: list[str] | None = None,
        run_manager: typing.Any = None,
        tools: list[dict] | None = None,
        tool_choice: typing.Any = None,
        **kwargs: typing.Any,
    ) -> outputs.ChatResult:
        system, transcript = _render(msgs)
        schema = None
        if tools:
            names = [t["function"]["name"] for t in tools]
            must = tool_choice not in (None, "auto", "none")
            schema = {
                "type": "object",
                "properties": {
                    "reply": {
                        "type": "string",
                        "description": "Text for the user. Empty when only calling tools.",
                    },
                    "tool_calls": {
                        "type": "array",
                        "minItems": 1 if must else 0,
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "enum": names},
                                "args": {"type": "object"},
                            },
                            "required": ["name", "args"],
                        },
                    },
                },
                "required": ["reply", "tool_calls"],
            }
            specs = "\n".join(json.dumps(t["function"]) for t in tools)
            system += (
                "\n\nYou can call these tools (JSON Schema for each):\n"
                + specs
                + "\n\nRespond with JSON: put tool calls in `tool_calls` (name + args matching the schema) and leave "
                "`reply` empty while you still need tool results. When you have what you need, return no tool calls "
                "and put your final answer in `reply`."
                + (" You must call at least one tool now." if must else "")
            )
        cmd = [
            self.binary,
            "-p",
            "--model",
            self.model,
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--setting-sources",
            "",
            "--no-session-persistence",
        ]
        if system:
            cmd += ["--system-prompt", system]
        if schema:
            cmd += ["--json-schema", json.dumps(schema)]
        with tempfile.TemporaryDirectory(prefix="keel-cc-") as cwd:
            proc = subprocess.run(
                cmd,
                check=False,
                input=transcript or "(no message)",
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
                cwd=cwd,
                env={**os.environ, "CLAUDE_CODE_ENTRYPOINT": "keel"},
            )
        if proc.returncode != 0:
            raise RuntimeError(
                f"claude CLI failed ({proc.returncode}): {proc.stderr.strip()[:300] or proc.stdout[:300]}"
            )
        data = json.loads(proc.stdout)
        if data.get("is_error"):
            raise RuntimeError(f"claude CLI error: {str(data.get('result'))[:300]}")
        usage = data.get("usage") or {}
        meta = {"model": self.model, "cost_usd": data.get("total_cost_usd")}
        um = {
            "input_tokens": int(usage.get("input_tokens", 0)),
            "output_tokens": int(usage.get("output_tokens", 0)),
            "total_tokens": int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)),
        }
        if schema:
            out = data.get("structured_output") or json.loads(data.get("result") or "{}")
            calls = [
                {
                    "name": c["name"],
                    "args": c.get("args") or {},
                    "id": f"call_{uuid.uuid4().hex[:12]}",
                    "type": "tool_call",
                }
                for c in out.get("tool_calls", [])
            ]
            msg = messages.AIMessage(
                content=out.get("reply", ""), tool_calls=calls, response_metadata=meta, usage_metadata=um
            )
        else:
            msg = messages.AIMessage(
                content=data.get("result", ""), response_metadata=meta, usage_metadata=um
            )
        return outputs.ChatResult(generations=[outputs.ChatGeneration(message=msg)])


def build(
    provider: str, model: str = "", api_key: str = "", base_url: str = ""
) -> language_models.BaseChatModel | None:
    """Create a chat model. Returns None for ``replay`` (the rule-based brain)."""
    model = model or DEFAULT_MODELS.get(provider, "")
    try:
        if provider == "replay" or not provider:
            return None
        if provider == "claude_code":
            if shutil.which("claude") is None:
                raise ModelUnavailable(
                    "The claude CLI isn't on PATH. Install Claude Code and sign in, or pick another provider."
                )
            return ChatClaudeCode(model=model)
        if provider == "anthropic":
            from langchain_anthropic import chat_models as anthropic_models

            return anthropic_models.ChatAnthropic(
                model=model, api_key=api_key or None, base_url=base_url or None, max_tokens=2048
            )
        if provider == "openai":
            from langchain_openai import chat_models as openai_models

            return openai_models.ChatOpenAI(model=model, api_key=api_key or None, base_url=base_url or None)
        if provider == "azure_openai":
            from langchain_openai import chat_models as openai_models

            return openai_models.AzureChatOpenAI(
                azure_deployment=model,
                api_key=api_key or None,
                azure_endpoint=base_url or None,
                api_version=os.environ.get("OPENAI_API_VERSION", "2024-10-21"),
            )
        if provider == "ollama":
            from langchain_ollama import chat_models as ollama_models

            return ollama_models.ChatOllama(model=model, base_url=base_url or "http://localhost:11434")
    except ImportError as exc:
        raise ModelUnavailable(
            f"The {provider} provider isn't installed. Run: pip install 'keel-steward[{provider.split('_')[0]}]'"
        ) from exc
    raise ModelUnavailable(f"Unknown model provider {provider!r}. Use one of: {', '.join(PROVIDERS)}.")


def for_org(session: orm.Session, org_id: str) -> language_models.BaseChatModel | None:
    """The org's configured model, or None when it runs on the rule-based brain."""
    res = connections.resolve(session, org_id, "model")
    if not res.configured:
        return None
    try:
        return build(
            res.config.get("provider", ""),
            res.config.get("model", ""),
            res.secrets.get("api_key", ""),
            res.config.get("base_url", ""),
        )
    except ModelUnavailable as exc:
        log.warning("model unavailable, using rules: %s", exc)
        return None


def test(provider: str, model: str = "", api_key: str = "", base_url: str = "") -> tuple[bool, str]:
    """Send one tiny prompt. Returns (ok, one plain line)."""
    try:
        chat = build(provider, model, api_key, base_url)
    except ModelUnavailable as exc:
        return False, str(exc)
    if chat is None:
        return True, "Replay mode: Keel uses built-in rules, no model calls."
    try:
        reply = chat.invoke("Reply with the single word: ready")
    except Exception as exc:
        return False, f"The model call failed: {str(exc).splitlines()[0][:200]}"
    text = reply.content if isinstance(reply.content, str) else str(reply.content)
    return True, f"{provider} answered: {text.strip()[:40]}"
