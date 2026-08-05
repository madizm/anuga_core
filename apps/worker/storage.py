"""Atomic S3-compatible artifact storage."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from apps.api.config import Settings


@dataclass(frozen=True)
class StoredObject:
    uri: str
    size_bytes: int
    sha256: str


class ObjectStorage:
    def __init__(self, settings: Settings):
        self.bucket = settings.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
        )

    def ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self.client.create_bucket(Bucket=self.bucket)

    def upload_atomic(self, source: Path | str, key: str) -> StoredObject:
        path = Path(source)
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        # S3 multipart uploads become visible only after completion, and a
        # single-part upload is atomically visible as one object. Uploading the
        # immutable job key directly avoids a redundant server-side copy and
        # temporary-object delete for every frame.
        self.client.upload_file(str(path), self.bucket, key)
        return StoredObject(
            uri=f"s3://{self.bucket}/{key}",
            size_bytes=path.stat().st_size,
            sha256=digest.hexdigest(),
        )
