"""The serialized lifecycle and the independent runtime stop path."""

import asyncio
import json
import sqlite3
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING
from uuid import uuid4

from .control import Revocation
from .http import HttpError
from .operations import MAX_ORDINARY_PENDING, Operation, mutation
from .registration_input import canonical_json
from .search_input import SearchRequest
from .search_storage import EMPTY_RESULT, SavedSearch, inspect_search, save_safety_pause, save_search
from .storage import Receipt, storage_unavailable

if TYPE_CHECKING:
    from .realtime import Realtime
    from .runtime import RecordsRuntime

SAVE_WAIT = 0.15


@dataclass
class SafetySave:
    session: str
    owner: str | None
    failure: str | None = None
    task: asyncio.Task[Receipt] | None = None
    persistence: str = "Pending"
    error: dict[str, object] | None = None


class SessionCoordinator:
    def __init__(self, runtime: "RecordsRuntime", realtime: "Realtime"):
        self.runtime = runtime
        self.realtime = realtime
        self.release_results: dict[str, SafetySave] = {}
        self.emergency_results: dict[str, tuple[str | None, SafetySave | None]] = {}
        self.emergency_save: SafetySave | None = None
        self.emergency_fallback: asyncio.TimerHandle | None = None
        self._safety_occupied = False
        self._emergency_occupied = False

    async def action(self, request: SearchRequest) -> Receipt:
        runtime = self.runtime
        runtime.check_started()
        session_id = uuid4().hex if request.mode else request.resource_id
        fingerprint = request.fingerprint()
        if (not request.mode and session_id == self.realtime.safety_session
                and request.revision == self.realtime.active_revision):
            # Safety cannot wait for a records read, an occupied admission lock, or the writer.
            try:
                self.realtime.authorize_search(request.client, request.secret, session_id, None)
            except HttpError:
                pass  # Eligible receipt recovery still precedes rejection of a stale lease.
            else:
                self.realtime.suspend_search(session_id)
        async with runtime._admission:
            prior, owner = await asyncio.to_thread(inspect_search, runtime.storage, request, fingerprint)
            if prior:
                return prior
            pending = runtime._pending.get(request.action_id)
            previous = pending[0] if pending else runtime._terminal.get(request.action_id)
            if previous and previous.fingerprint != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            if pending:
                return pending[0].response
            # Validate new work against current domain facts after the pending/receipt checks.
            prior, owner = await asyncio.to_thread(inspect_search, runtime.storage, request, fingerprint, transition=True)
            if prior:
                return prior
            generation = self.realtime.authorize_search(
                request.client, request.secret, None if request.mode else session_id, request.mode,
            )
            if not request.mode:
                self.realtime.suspend_search(session_id)
            full = (runtime.ordinary_pending() >= MAX_ORDINARY_PENDING
                    if request.mode else self._safety_occupied)
            if runtime._stopping or full:
                raise HttpError(503, "CAPACITY_REACHED", "Search saving capacity is occupied. Retry shortly.", True,
                                permission_revoked=not request.mode)

            operation = Operation(fingerprint, mutation(request.action_id, "Pending", 202), owner,
                                  slot="ordinary" if request.mode else "safety")
            if not request.mode:
                self._safety_occupied = True
            task = asyncio.create_task(self.finish_action(request, operation, session_id, generation))
            runtime._pending[request.action_id] = (operation, task)
            runtime._terminal.pop(request.action_id, None)
            self.realtime.operation_changed(session_id, operation.payload())
        done, _ = await asyncio.wait((task,), timeout=SAVE_WAIT)
        return task.result() if done else operation.response

    async def finish_action(
        self, request: SearchRequest, operation: "Operation", session: str, generation: int,
    ) -> Receipt:
        runtime = self.runtime
        loop = asyncio.get_running_loop()

        async def authorize(final: bool) -> None:
            current = self.realtime.authorize_search(
                request.client, request.secret, None if request.mode else session, request.mode,
            )
            if generation != current:
                raise HttpError(403, "LEASE_EXPIRED", "The control lease is no longer current.")
            if final and request.mode:
                self.realtime.prepare_start(session)

        def check(final: bool) -> None:
            asyncio.run_coroutine_threadsafe(authorize(final), loop).result()

        saved: SavedSearch | None = None
        try:
            async with runtime._save:
                saved = await asyncio.to_thread(
                    save_search, runtime.storage, request, operation.fingerprint, session, runtime.preparing(), check,
                )
                assert saved.receipt is not None
                response = saved.receipt
        except HttpError as error:
            response = mutation(request.action_id, "Failed", error.status, error)
        except (OSError, sqlite3.Error):
            try:
                existing, _ = await asyncio.to_thread(inspect_search, runtime.storage, request, operation.fingerprint)
            except (OSError, sqlite3.Error, HttpError):
                # Without a readable receipt the caller must reconcile by repeating the identical request.
                unknown = HttpError(503, "STORAGE_UNAVAILABLE", "The search save outcome is unconfirmed.", True)
                return Receipt(bytes(unknown.response(action_id=request.action_id).body).decode(), unknown.status, None)
            unavailable = storage_unavailable()
            response = existing or mutation(request.action_id, "Failed", unavailable.status, unavailable)
        finally:
            runtime._pending.pop(request.action_id, None)
            if request.mode:
                self.realtime.resolve_start(session, saved is not None and saved.session is not None)
            else:
                self._safety_occupied = False

        complete = replace(operation, response=response)
        if request.action == "stop" and response.status == 200:
            runtime._retention_changed.set()
        if saved and saved.removed and saved.owner:
            self.realtime.search_ended(session)
            self.realtime.object_removed(saved.owner)
        else:
            runtime.publish_terminal(request.action_id, complete)
            if saved and saved.session:
                self.realtime.search_committed(saved.session)
            self.realtime.operation_changed(session, complete.payload(), saved.session if saved else None)
        return response

    def revoked(self, revocation: Revocation) -> None:
        if revocation.session is None or revocation.reason in ("EmergencyStop", "SessionEnded"):
            return
        request = revocation.request_id or str(uuid4())
        job = self.begin_pause(request, revocation.session)
        if revocation.request_id and self.realtime.lease_request_used(request):
            self.release_results[request] = job

    def begin_pause(self, request: str, session: str, failure: str | None = None) -> SafetySave:
        runtime = self.runtime
        if self.emergency_fallback is not None and failure:
            self.emergency_fallback.cancel()
            self.emergency_fallback = None
        owner = self.realtime.active_owner
        job = SafetySave(session, owner, failure)
        occupied = self._emergency_occupied if failure else self._safety_occupied
        if occupied or runtime._stopping:
            error = HttpError(503, "CAPACITY_REACHED", "Safety was applied. Pause saving capacity is occupied.", True)
            job.persistence = "Failed"
            job.error = json.loads(bytes(error.response().body))
        else:
            slot = "emergency" if failure else "safety"
            if failure:
                self._emergency_occupied = True
            else:
                self._safety_occupied = True
            operation = Operation("", mutation(request, "Pending", 202), owner,
                                  request_id=request, slot=slot)
            key = "request:" + request
            job.task = asyncio.create_task(self.finish_pause(key, operation, job))
            runtime._pending[key] = (operation, job.task)
            self.realtime.operation_changed(session, operation.payload())
        return job

    async def finish_pause(self, key: str, operation: "Operation", job: SafetySave) -> Receipt:
        runtime = self.runtime
        saved = None
        request = operation.request_id
        assert request is not None
        try:
            async with runtime._save:
                saved = await asyncio.to_thread(
                    save_safety_pause, runtime.storage, job.session, self.realtime.failure if job.failure else None,
                )
            receipt = Receipt(canonical_json({
                "action_id": request, "persistence": "Committed",
                "result": {**EMPTY_RESULT, "session": saved.session}, "error": None,
            }), 200, None)
        except (OSError, sqlite3.Error, HttpError):
            error = storage_unavailable()
            receipt = mutation(request, "Failed", error.status, error)
        finally:
            runtime._pending.pop(key, None)
            if job.failure:
                self._emergency_occupied = False
            else:
                self._safety_occupied = False
        job.persistence = "Committed" if saved is not None else "Failed"
        job.error = json.loads(receipt.body)["error"] if saved is None else None
        job.task = None
        complete = replace(operation, response=receipt)
        if saved and saved.owner:
            job.owner = saved.owner
            runtime.publish_terminal(key, complete)
            if saved.session:
                self.realtime.search_committed(saved.session)
            self.realtime.operation_changed(job.session, complete.payload(), saved.session)
        elif saved is None:
            runtime.publish_terminal(key, complete)
            self.realtime.operation_changed(job.session, complete.payload())
        return receipt

    async def wait_for_save(self, job: SafetySave | None) -> None:
        if job is not None and job.task is not None:
            await asyncio.wait((job.task,), timeout=SAVE_WAIT)

    def emergency_revoke(self) -> str | None:
        session = self.realtime.emergency_revoke()
        if session is None:
            return None
        previous = self.realtime.failure
        if previous is None or previous["session_id"] != session:
            self.realtime.set_failure({
                "failure_id": uuid4().hex, "session_id": session, "cause": "EmergencyStop",
                "observed_at_ms": self.runtime.storage.clock(), "restored": False, "acknowledged": False,
            })
        # An authorized stalled body cannot indefinitely withhold durable emergency persistence.
        if self.emergency_fallback is None:
            self.emergency_fallback = asyncio.get_running_loop().call_later(
                SAVE_WAIT, self.persist_emergency, str(uuid4()), session,
            )
        return session

    def persist_emergency(self, request: str, session: str | None) -> SafetySave | None:
        if session is None or self.realtime.safety_session != session:
            self.emergency_fallback = None
            return None
        failure = self.realtime.failure
        if not failure or session != failure["session_id"]:
            return None
        previous = self.emergency_save
        if previous is not None and previous.failure == failure["failure_id"] and previous.persistence != "Failed":
            if self.emergency_fallback is not None:
                self.emergency_fallback.cancel()
                self.emergency_fallback = None
            return previous
        self.emergency_save = self.begin_pause(request, session, str(failure["failure_id"]))
        return self.emergency_save

    async def emergency(self, request: str, client: str | None, session: str | None) -> tuple[int, dict[str, object]]:
        previous = self.emergency_results.get(request)
        if self.realtime.lease_request_used(request) or (previous is not None and previous[0] != client):
            self.persist_emergency(str(uuid4()), session)
            raise HttpError(409, "REQUEST_ID_CONFLICT", "This runtime request ID was already used.")
        if previous is None:
            if self.realtime.request_at_capacity():
                self.persist_emergency(str(uuid4()), session)
                raise HttpError(503, "CAPACITY_REACHED", "Emergency request capacity is occupied.")
            self.realtime.emergency_requests.add(request)
            job = self.persist_emergency(request, session)
            self.emergency_results[request] = (client, job)
        else:
            job = previous[1]
            if job is None or job.session != session:
                self.persist_emergency(str(uuid4()), session)
        await self.wait_for_save(job)
        eligible = job is not None and job.session == self.realtime.safety_session
        if job is not None and job.owner is not None and not eligible:
            eligible = job.owner in await asyncio.to_thread(self.runtime.storage.eligible_owners, {job.owner})
        persistence = job.persistence if job else "Committed"
        error = job.error if job else None
        return {"Pending": 202, "Committed": 200, "Failed": 503}[persistence], {
            "request_id": request, "backend_boot_id": self.runtime.boot_id, "permission_revoked": True,
            "session_id": job.session if job and eligible else None,
            "failure_id": job.failure if job and eligible else None,
            "persistence": persistence, "error": error,
        }
