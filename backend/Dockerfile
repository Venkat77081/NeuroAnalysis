# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
COPY analysis ./analysis
COPY alembic ./alembic
COPY alembic.ini ./
# Optional extra CA (e.g. a corporate TLS proxy): docker build --secret id=extra_ca,src=<ca.pem> ...
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir . && useradd --system --uid 10001 api \
    && mkdir -p /data/storage && chown api /data/storage
USER api
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
