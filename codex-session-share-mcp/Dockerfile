FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    SESSION_SHARE_DATA_DIR=/data

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir . \
    && groupadd --gid 10001 session-share \
    && useradd --uid 10001 --gid 10001 --no-create-home session-share \
    && mkdir -p /data \
    && chown -R 10001:10001 /app /data

USER 10001:10001

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).read()"

CMD ["codex-session-share-server"]
