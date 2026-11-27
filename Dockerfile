# syntax=docker/dockerfile:1.7
# Keel: web UI build, then a slim Python runtime. One image runs web, worker, migrate and runner.

FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN mkdir -p ../src/keel && npm run build

FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project --extra all
COPY src/ ./src/
COPY --from=web /app/src/keel/web_dist ./src/keel/web_dist
RUN uv sync --frozen --no-dev --extra all

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 keel
COPY --from=build --chown=keel:keel /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 KEEL_HOST=0.0.0.0 KEEL_PORT=8420
USER keel
WORKDIR /home/keel
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8420/healthz').status==200 else 1)"
ENTRYPOINT ["keel"]
CMD ["serve"]
