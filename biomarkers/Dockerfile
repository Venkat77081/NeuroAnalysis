# syntax=docker/dockerfile:1
# NeuroCapture biomarker analysis (M15, decision 057). Runs at the hospital next to the connector.
# Build from the repo root (it needs config/):  docker build -f biomarkers/Dockerfile -t neurocapture-biomarkers .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NCBIO_CONFIG_DIR=/srv/config NCBIO_MODELS_DIR=/srv/models
# MediaPipe needs EGL/GLES even on the CPU.
RUN apt-get update && apt-get install -y --no-install-recommends libegl1 libgles2 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY config/analysis.json config/biomarker-registry.json ./config/
COPY biomarkers/pyproject.toml ./
COPY biomarkers/ncbio ./ncbio
RUN pip install --no-cache-dir . && python -m ncbio models && useradd --system --uid 10003 analysis
USER analysis
ENTRYPOINT ["python", "-m", "ncbio"]
