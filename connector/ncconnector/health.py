"""v29 (decision 052): the connector checks in with the platform so dashboards can show whether it
is online and its last 24 hours. The heartbeat is a signed, empty request: nothing about patients."""

from ncconnector import platform


def heartbeat() -> None:
    platform.call("POST", "/connector/v1/heartbeat")
