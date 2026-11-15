# syntax=docker/dockerfile:1
# NeuroCapture hospital connector. One image for hospitals (their network) and for managed clinics.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY pyproject.toml ./
COPY ncconnector ./ncconnector
COPY sql ./sql
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir . && useradd --system --uid 10002 connector \
    && mkdir -p /data && chown connector /data
USER connector
EXPOSE 8100
HEALTHCHECK --interval=10s --timeout=3s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8100/health').status==200 else 1)"
CMD ["uvicorn", "ncconnector.main:app", "--host", "0.0.0.0", "--port", "8100"]
