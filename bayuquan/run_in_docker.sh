#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
IMAGE=${ANUGA_DOCKER_IMAGE:-anuga-core:local}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" "$REPO_ROOT"
fi

docker run --rm \
    --workdir /workspace \
    --volume "$REPO_ROOT:/workspace" \
    "$IMAGE" \
    python -m bayuquan.run_constant_inflow "$@"
