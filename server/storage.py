"""SQLite storage for leads.

stdlib sqlite3 is sync — wrap each call in asyncio.to_thread so the aiohttp
event loop stays responsive.
"""

import asyncio
import os
import sqlite3
from typing import List, Optional, Sequence


COLUMNS: Sequence[str] = (
    "timestamp_iso",
    "name",
    "contact_type",
    "contact_value",
    "top_profession_id",
    "top_percent",
    "second_id",
    "second_percent",
    "third_id",
    "third_percent",
    "fourth_id",
    "fourth_percent",
    "source",
    "tg_user_id",
    "tg_username",
    "user_agent",
    "consent",
)


SCHEMA = f"""
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    {", ".join(c + " TEXT" for c in COLUMNS)}
);
"""


class LeadStore:
    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def append_row(self, values: List[Optional[str]]) -> None:
        if len(values) != len(COLUMNS):
            raise ValueError(f"expected {len(COLUMNS)} values, got {len(values)}")
        placeholders = ",".join("?" for _ in COLUMNS)
        sql = f"INSERT INTO leads ({','.join(COLUMNS)}) VALUES ({placeholders})"
        with self._connect() as conn:
            conn.execute(sql, [None if v is None else str(v) for v in values])


class AsyncLeadStore:
    def __init__(self, store: LeadStore):
        self._store = store
        self._lock = asyncio.Lock()

    async def append_row(self, values: List[Optional[str]]) -> None:
        async with self._lock:
            await asyncio.to_thread(self._store.append_row, values)
