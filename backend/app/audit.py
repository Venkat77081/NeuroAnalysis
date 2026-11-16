from sqlalchemy.orm import Session as DbSession

from app.models import AuditEvent


def audit(
    db: DbSession,
    actor_type: str,
    actor_id: str | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    *,
    site_id: str | None = None,
    **details: object,
) -> None:
    """Append-only audit log (§14). `site_id` scopes it to a hospital (None = platform event).
    Never put names, MRNs, e-mail addresses, phone numbers or file paths with IDs in details."""
    db.add(
        AuditEvent(
            site_id=site_id,
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            details=details or None,
        )
    )
