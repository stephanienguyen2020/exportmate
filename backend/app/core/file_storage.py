"""Uploaded files live in the Cloud Storage bucket REGULATION_DOCUMENT_BUCKET (locally too)."""

from functools import lru_cache

from google.cloud import storage

from app.core.config import get_settings
from app.core.errors import AppError


class CloudFileStorage:
    def __init__(self, bucket_name: str):
        self.bucket = storage.Client().bucket(bucket_name)

    def save_file(self, path: str, content: bytes, content_type: str) -> None:
        # if_generation_match=0: never overwrite an existing object.
        self.bucket.blob(path).upload_from_string(
            content, content_type=content_type, if_generation_match=0
        )

    def load_file(self, path: str) -> bytes:
        return self.bucket.blob(path).download_as_bytes()

    def delete_file(self, path: str) -> None:
        # The bucket is versioned: the bytes stay as a noncurrent version.
        self.bucket.blob(path).delete()


@lru_cache
def get_file_storage() -> CloudFileStorage:
    bucket_name = get_settings().regulation_document_bucket
    if not bucket_name:
        raise AppError(
            503,
            "storage_not_configured",
            "File storage is not set up (REGULATION_DOCUMENT_BUCKET).",
        )
    return CloudFileStorage(bucket_name)
