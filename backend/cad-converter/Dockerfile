FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    HOME=/tmp \
    GDAL_NUM_THREADS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      gdal-bin \
      libpcre2-dev \
      libtool \
      libxml2-dev \
      librsvg2-bin \
      pkg-config \
      poppler-utils \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

ARG LIBREDWG_VERSION=0.14
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
RUN curl --fail --location --silent --show-error \
      "https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz" \
      --output /tmp/libredwg.tar.xz \
    && echo "${LIBREDWG_SHA256}  /tmp/libredwg.tar.xz" | sha256sum --check --status \
    && mkdir -p /tmp/libredwg-src \
    && tar -xJf /tmp/libredwg.tar.xz --strip-components=1 -C /tmp/libredwg-src \
    && cd /tmp/libredwg-src \
    && ./configure --prefix=/usr/local --disable-bindings --disable-docs --disable-json \
    && make -C src -j4 \
    && make -C programs -j4 \
    && make -C src install \
    && make -C programs install \
    && ln -s /usr/local/bin/dwg2SVG /usr/local/bin/dwg2svg \
    && ldconfig \
    && rm -rf /tmp/libredwg-src /tmp/libredwg.tar.xz

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./
COPY tests/ ./tests/

RUN groupadd --gid 10001 cad && \
    useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cad

USER 10001:10001
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=2)"]

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1", "--no-access-log"]
