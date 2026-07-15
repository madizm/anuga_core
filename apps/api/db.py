"""SQLAlchemy database boundary."""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, url: str):
        arguments = (
            {"check_same_thread": False} if url.startswith("sqlite") else {}
        )
        self.engine = create_engine(url, pool_pre_ping=True,
                                    connect_args=arguments)
        self.session_factory = sessionmaker(
            bind=self.engine, expire_on_commit=False, class_=Session
        )

    def create_schema(self) -> None:
        Base.metadata.create_all(self.engine)

    def sessions(self) -> Generator[Session, None, None]:
        with self.session_factory() as session:
            yield session
