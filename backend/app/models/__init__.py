"""SQLAlchemy models (DEV_PLAN §13.1). Tables are added in M7; M0 ships only the declarative base."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
