FROM python:3.12-slim-bookworm

ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

ENV PIP_INDEX_URL=${PYPI_INDEX_URL} \
    PIP_DEFAULT_TIMEOUT=120

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

# Compilers are required for ANUGA's C/Cython extensions. OpenMPI enables the
# optional parallel execution support.
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends \
        build-essential \
        git \
        libopenmpi-dev \
        openmpi-bin \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/anuga-src

# Keep the compiled ANUGA dependency layer independent from Web GIS service
# changes. This makes API/frontend iteration reuse the expensive native build.
COPY pyproject.toml meson.build _git_version.py README.rst LICENSE.txt ./
COPY anuga ./anuga
COPY scripts ./scripts

# meson-python needs NumPy and the build tools in the active environment.
RUN python -m pip install --no-cache-dir \
        "numpy>=2.0.0" \
        Cython \
        meson \
        meson-python \
        ninja \
        pybind11 \
        setuptools \
        wheel \
    && python -m pip install --no-cache-dir --no-build-isolation \
        ".[parallel,web-gis]" \
    && cd /tmp \
    && python -c "import anuga; print('Built ANUGA', anuga.__version__)"

# Keep service code on a path that cannot shadow the compiled ANUGA wheel.
WORKDIR /opt/webgis
COPY apps ./apps
COPY bayuquan ./bayuquan
COPY alembic.ini ./

RUN useradd --create-home --uid 1000 anuga \
    && install -d --owner=anuga --group=anuga /workspace
USER anuga
WORKDIR /workspace

CMD ["python", "-c", "import anuga; print(f'ANUGA {anuga.__version__} is ready')"]
