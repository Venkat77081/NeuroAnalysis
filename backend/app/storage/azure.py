"""Azure Blob Storage for take files (decision 037), next to S3 and the local disk.

Phones upload the same way as with S3: each part is a PUT to a short-lived URL. For Azure the URL is
a **Put Block** on one blob with a SAS that allows only create and write, for that blob only, for
`upload_url_ttl_s`. Completing commits the block list in part order. Block IDs are derived from the
upload ID and the part number, so the phone never needs Azure's IDs; it reports `azure-<n>` as the
part's ETag (Put Block answers 201 without an ETag) and the server ignores it. Integrity comes from
the SHA-256 check: the platform checks it for its own storage, and the hospital's connector checks
it for a hospital's own storage.

Two ways to sign the SAS:

- an account key (`NC_AZURE_STORAGE_KEY`); simple, for the platform's own storage account;
- a **user delegation key** from Microsoft Entra ID (managed identity, or the platform's app
  registration in a hospital's tenant). No storage key is stored, and the SAS can never allow more
  than the identity's role: a hospital gives NeuroCapture a write-only role, so the platform can
  upload but not read.
"""

import base64
import hashlib
import threading
from datetime import UTC, datetime, timedelta
from urllib.parse import quote
from uuid import uuid4

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.storage.blob import BlobBlock, BlobSasPermissions, BlobServiceClient, generate_blob_sas

from app.storage import Part

#: All block IDs of a blob must have the same length: 32 hex characters + "-" + 5 digits.
_ID_LEN = 38


def block_id(upload_id: str, number: int) -> str:
    """The block's ID as the SDK takes and returns it (it base64-encodes on the wire)."""
    raw = f"{upload_id}-{number:05d}"
    if len(raw) != _ID_LEN:
        raise ValueError("bad upload id")
    return raw


def wire_block_id(upload_id: str, number: int) -> str:
    """The same ID as Azure's REST API expects it in a Put Block URL (base64)."""
    return base64.b64encode(block_id(upload_id, number).encode()).decode()


def _number(upload_id: str, raw: str) -> int | None:
    if not raw.startswith(upload_id + "-"):
        return None
    try:
        return int(raw.rsplit("-", 1)[1])
    except ValueError:
        return None


class AzureBlobStorage:
    #: The platform may read objects back (checksum, readiness). False for a hospital's own storage.
    readable = True

    def __init__(
        self,
        service: BlobServiceClient,
        container: str,
        ttl_s: int,
        account_key: str | None = None,
    ) -> None:
        self.service = service
        self.container = container
        self.ttl_s = ttl_s
        self.account_key = account_key
        self._udk: tuple[datetime, object] | None = None
        self._lock = threading.Lock()

    # --- signing ---

    def _delegation_key(self):
        """User delegation keys last up to 7 days; one is reused until 1 hour before it ends."""
        now = datetime.now(UTC)
        with self._lock:
            if self._udk and self._udk[0] > now + timedelta(hours=1):
                return self._udk[1]
            expiry = now + timedelta(hours=12)
            key = self.service.get_user_delegation_key(now - timedelta(minutes=5), expiry)
            self._udk = (expiry, key)
            return key

    def _sas(self, key: str, permission: BlobSasPermissions, ttl_s: int) -> str:
        now = datetime.now(UTC)
        args = {
            "account_name": self.service.account_name,
            "container_name": self.container,
            "blob_name": key,
            "permission": permission,
            "start": now - timedelta(minutes=5),
            "expiry": now + timedelta(seconds=ttl_s),
            "protocol": "https" if self.service.url.startswith("https") else "https,http",
        }
        if self.account_key:
            return generate_blob_sas(account_key=self.account_key, **args)
        return generate_blob_sas(user_delegation_key=self._delegation_key(), **args)

    def _blob(self, key: str):
        return self.service.get_blob_client(self.container, key)

    # --- upload protocol (same as S3Storage) ---

    def create_upload(self, key: str) -> str:
        return uuid4().hex  # Azure has no upload session: blocks are staged under the blob itself

    def part_url(self, key: str, upload_id: str, number: int) -> str:
        sas = self._sas(key, BlobSasPermissions(create=True, write=True), self.ttl_s)
        bid = quote(wire_block_id(upload_id, number), safe="")
        return f"{self._blob(key).url}?comp=block&blockid={bid}&{sas}"

    def list_parts(self, key: str, upload_id: str) -> list[Part]:
        """Parts already staged (for resuming). A write-only identity may not list blocks: then
        nothing is reported and the phone sends every part again."""
        try:
            blocks = self._blob(key).get_block_list("uncommitted")[1]
        except (ResourceNotFoundError, HttpResponseError):
            return []
        out = []
        for b in blocks:
            n = _number(upload_id, b.id)
            if n is not None:
                out.append(Part(n, b.id, b.size))
        return sorted(out, key=lambda p: p.number)

    def complete(self, key: str, upload_id: str, parts: list[Part]) -> None:
        """Commits the blocks in part order. Azure refuses if a block is missing."""
        blocks = [
            BlobBlock(block_id=block_id(upload_id, p.number)) for p in sorted(parts, key=lambda x: x.number)
        ]
        try:
            self._blob(key).commit_block_list(blocks)
        except HttpResponseError as exc:
            raise ValueError("a part is missing") from exc

    def abort(self, key: str, upload_id: str) -> None:
        """Nothing to do: Azure discards uncommitted blocks after 7 days."""

    # --- reading back (platform storage only) ---

    def sha256(self, key: str) -> str:
        h = hashlib.sha256()
        for chunk in self._blob(key).download_blob().chunks():
            h.update(chunk)
        return h.hexdigest()

    def size(self, key: str) -> int:
        return self._blob(key).get_blob_properties().size

    def read(self, key: str) -> bytes:
        return self._blob(key).download_blob().readall()

    def download_url(self, key: str, ttl_s: int) -> str:
        """Short-lived read-only SAS (the hospital's connector fetches the encrypted file)."""
        return f"{self._blob(key).url}?{self._sas(key, BlobSasPermissions(read=True), ttl_s)}"


class HospitalAzureStorage(AzureBlobStorage):
    """A hospital's own storage account: the platform's identity has a write-only role there."""

    readable = False

    def sha256(self, key: str) -> str:
        raise PermissionError("write-only role: the hospital's connector verifies checksums")

    def read(self, key: str) -> bytes:
        raise PermissionError("write-only role")

    def size(self, key: str) -> int:
        raise PermissionError("write-only role")

    def download_url(self, key: str, ttl_s: int) -> str:
        raise PermissionError("write-only role")


def account_url(account: str, endpoint: str | None) -> str:
    """https://<account>.blob.core.windows.net, or an explicit endpoint (sovereign clouds, Azurite)."""
    return (endpoint or f"https://{account}.blob.core.windows.net").rstrip("/")
