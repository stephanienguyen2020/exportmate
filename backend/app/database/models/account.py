import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY
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
    """A tenant. The profile fields also feed the AI assistant's knowledge of the company."""

    __tablename__ = "companies"
    id: Mapped[uuid.UUID] = id_column()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    business_role: Mapped[str] = mapped_column(String(50), nullable=False)
    origin: Mapped[str] = mapped_column(String(100), nullable=False)
    # Stops between origin and destination, in order, e.g. ["Singapore"]. Empty means direct.
    transit: Mapped[list[str]] = mapped_column(
        ARRAY(String(100)), nullable=False, default=list, server_default="{}"
    )
    destination: Mapped[str] = mapped_column(String(100), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    products: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Main materials and where they come from, e.g. "Acacia (Vietnam), birch veneer (Russia)".
    materials: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    certifications: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    website: Mapped[str | None] = mapped_column(String(300))
    founded_year: Mapped[int | None] = mapped_column(Integer)
    team_size: Mapped[str | None] = mapped_column(String(20))  # a band, e.g. "51-200"
    created_at: Mapped[datetime] = created_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


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
