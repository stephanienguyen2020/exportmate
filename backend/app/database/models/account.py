import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class Role(str, enum.Enum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = id_column()
    firebase_uid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    alerts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    digest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_column()


class Company(Base):
    __tablename__ = "companies"
    id: Mapped[uuid.UUID] = id_column()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    business_role: Mapped[str] = mapped_column(String(50), nullable=False)
    origin: Mapped[str] = mapped_column(String(100), nullable=False)
    destination: Mapped[str] = mapped_column(String(100), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    created_at: Mapped[datetime] = created_column()


class Membership(Base):
    __tablename__ = "memberships"
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[Role] = mapped_column(pg_enum(Role, "member_role"), nullable=False)
    created_at: Mapped[datetime] = created_column()
