"""Reading recordings from the hospital's own storage (M12, decision 037) with the connector's own
credentials: an S3 bucket, or an Azure Blob container."""

from functools import lru_cache

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from ncconnector.config import get_settings
from ncconnector.platform import PlatformError


def read_object(location: dict) -> bytes:
    if location.get("kind") == "azure":
        return _read_azure(location)
    s = get_settings()
    client = boto3.client(
        "s3",
        endpoint_url=location.get("endpoint") or s.s3_endpoint,
        region_name=location.get("region") or s.s3_region,
    )
    try:
        return client.get_object(Bucket=location["bucket"], Key=location["key"])["Body"].read()
    except (BotoCoreError, ClientError) as exc:
        raise PlatformError(503, {"code": "hospital_storage_unreachable"}) from exc


@lru_cache
def azure_service(account: str, endpoint: str | None):
    """The hospital's storage account, as the connector: an account key, or its Entra identity."""
    from azure.storage.blob import BlobServiceClient

    key = get_settings().azure_storage_key
    url = (endpoint or f"https://{account}.blob.core.windows.net").rstrip("/")
    if key:
        return BlobServiceClient(url, credential={"account_name": account, "account_key": key})
    from azure.identity import DefaultAzureCredential

    return BlobServiceClient(url, credential=DefaultAzureCredential())


def _read_azure(location: dict) -> bytes:
    from azure.core.exceptions import AzureError

    try:
        blob = azure_service(location["account"], location.get("endpoint")).get_blob_client(
            location["container"], location["key"]
        )
        return blob.download_blob().readall()
    except AzureError as exc:
        raise PlatformError(503, {"code": "hospital_storage_unreachable"}) from exc
