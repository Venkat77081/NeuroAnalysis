"""Reading recordings from the hospital's own bucket (M12) with the connector's own credentials."""

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from ncconnector.config import get_settings
from ncconnector.platform import PlatformError


def read_object(location: dict) -> bytes:
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
