from sqlalchemy.orm import Session as DbSession

from app.models import AuditEvent


def audit(
    db: DbSession,
    actor_type: str,
    actor_id: str | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    **details: object,
) -> None:
    """Append-only audit log (§14). Never put names, external refs or file paths with IDs in details."""
    db.add(
        AuditEvent(
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or None,
        )
    )
