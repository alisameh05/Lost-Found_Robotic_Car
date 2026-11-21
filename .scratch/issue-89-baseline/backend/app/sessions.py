"""The serialized lifecycle and the independent runtime stop path."""

import asyncio
import json
import sqlite3
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING
from uuid import uuid4

from .candidate import CandidateCapture, encode_evidence, save_candidate
from .control import MAX_RUNTIME_RECEIPTS, Revocation
from .http import HttpError
from .operations import MAX_ORDINARY_PENDING, Operation, mutation
from .realtime import REVOCATION_FAILURES
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
    observation: dict[str, object] | None = None
    task: asyncio.Task[Receipt] | None = None
    persistence: str = "Pending"
    error: dict[str, object] | None = None
    terminal_won: bool = False


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
        self._deferred_pause: str | None = None
        self._path_failures: dict[str, dict[str, object]] = {}
        self._failure_task: asyncio.Task[None] | None = None
        self._pending_resume: SearchRequest | None = None
        self._pending_stop: str | None = None
        self._candidate_task: asyncio.Task[None] | None = None
        self.preparing_candidate: str | None = None
        self._safety_admissions = 0
        self._safety_admission_idle = asyncio.Event()
        self._safety_admission_idle.set()
        self._cancellation_scope: tuple[str | None, int | None] = (None, None)
        self._cancelled_resumes: dict[str, Operation] = {}

    def resume_cancellations(self) -> dict[str, Operation]:
        # A no-op Pause can leave the original revision usable beyond operation-cache eviction.
        scope = self.realtime.safety_session, self.realtime.active_revision
        if scope != self._cancellation_scope:
            self._cancelled_resumes.clear()
            self._cancellation_scope = scope
        return self._cancelled_resumes

    def path_failure_changed(self, failure: dict[str, object]) -> None:
        self._path_failures[str(failure["failure_id"])] = failure
        if self._failure_task is None and not self.runtime._stopping:
            self._failure_task = asyncio.create_task(self.save_path_failures())

    async def save_path_failures(self) -> None:
        runtime = self.runtime
        try:
            while self._path_failures and not runtime._stopping:
                session = self.realtime.safety_session
                self._path_failures = {
                    key: value for key, value in self._path_failures.items() if value["session_id"] == session
                }
                if session is None or not self._path_failures:
                    return
                failures = tuple(self._path_failures.values())
                try:
                    async with runtime._save:
                        saved = await asyncio.to_thread(save_safety_pause, runtime.storage, session, failures)
                except (OSError, sqlite3.Error, HttpError):
                    self.realtime.observe_storage(False, self.realtime.monotonic())
                    await asyncio.sleep(SAVE_WAIT)
                    continue
                for failure in failures:
                    key = str(failure["failure_id"])
                    if self._path_failures.get(key) == failure:
                        del self._path_failures[key]
                if saved.session:
                    recovery_changed = self.realtime.reconcile_failures((), saved.restored)
                    self.realtime.publish_search_commit(saved.session, None, None, bool(runtime._pending),
                                                        recovery_changed=recovery_changed)
        finally:
            self._failure_task = None

    async def stop(self) -> None:
        if self.emergency_fallback is not None:
            self.emergency_fallback.cancel()
        if self._failure_task is not None:
            await self._failure_task
        if self._candidate_task is not None:
            await self._candidate_task

    def admit_candidate(self, work: CandidateCapture) -> None:
        assert self._candidate_task is None
        self.preparing_candidate = work.id
        self._candidate_task = asyncio.create_task(self.prepare_candidate(work))

    async def prepare_candidate(self, work: CandidateCapture) -> None:
        runtime, realtime = self.runtime, self.realtime
        loop = asyncio.get_running_loop()

        async def authorized() -> bool:
            return not runtime._stopping and realtime.candidate_current(work)

        def current() -> bool:
            return asyncio.run_coroutine_threadsafe(authorized(), loop).result()

        try:
            data = await asyncio.to_thread(encode_evidence, work.capture)
            async with runtime._save:
                saved = await asyncio.to_thread(save_candidate, runtime.storage, work, data, current)
                if saved and saved.session:
                    realtime.publish_search_commit(saved.session, None, None, bool(runtime._pending),
                                                   candidate=saved.match, capture=work)
        except (OSError, ValueError, sqlite3.Error, HttpError):
            if await authorized():
                realtime.observe_storage(False, realtime.monotonic())
                realtime.record_failure("StorageFault", work.session)
        finally:
            realtime.candidate_finished(work)
            self.preparing_candidate = None
            self._candidate_task = None

    async def action(self, request: SearchRequest) -> Receipt:
        runtime = self.runtime
        runtime.check_started()
        session_id = uuid4().hex if request.mode else request.resource_id
        fingerprint = request.fingerprint()
        superseded_resume = None
        safety_admission = False
        if (request.safety_action and session_id == self.realtime.safety_session
                and request.action_id not in runtime._pending and request.action_id not in runtime._terminal
                and request.revision == self.realtime.active_revision):
            # Safety cannot wait for a records read, an occupied admission lock, or the writer.
            try:
                self.realtime.authorize_search(request.client, request.secret, session_id, None)
            except HttpError:
                pass  # Eligible receipt recovery still precedes rejection of a stale lease.
            else:
                safety_admission = True
                self._safety_admissions += 1
                self._safety_admission_idle.clear()
                resume = self._pending_resume
                if resume and resume.resource_id == session_id and resume.revision == request.revision:
                    superseded_resume = resume.action_id
                else:
                    self.realtime.suspend_search(session_id, invalidate_candidate=False)
        try:
            admitted = await self.admit_action(request, session_id, fingerprint, superseded_resume)
        finally:
            if safety_admission:
                self._safety_admissions -= 1
                if not self._safety_admissions:
                    self._safety_admission_idle.set()
                    if self._deferred_pause is not None:
                        self.save_deferred_pause()
        if isinstance(admitted, Receipt):
            return admitted
        operation, task = admitted
        done, _ = await asyncio.wait((task,), timeout=SAVE_WAIT)
        return task.result() if done else operation.response

    async def admit_action(
        self, request: SearchRequest, session_id: str, fingerprint: str, superseded_resume: str | None,
    ) -> Receipt | tuple[Operation, asyncio.Task[Receipt]]:
        runtime = self.runtime
        async with runtime._admission:
            prior, owner = await asyncio.to_thread(inspect_search, runtime.storage, request, fingerprint)
            if prior:
                return prior
            pending = runtime._pending.get(request.action_id)
            cancelled = self.resume_cancellations().get(request.action_id)
            previous = pending[0] if pending else cancelled or runtime._terminal.get(request.action_id)
            if previous and previous.fingerprint != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            if pending:
                return pending[0].response
            if cancelled:
                return cancelled.response
            if request.action == "resume" and previous and 400 <= previous.response.status < 500:
                # An identical transport retry cannot reopen a superseded Resume.
                return previous.response
            # Validate new work against current domain facts after the pending/receipt checks.
            prior, owner = await asyncio.to_thread(inspect_search, runtime.storage, request, fingerprint,
                                                   transition=True, superseded_resume=superseded_resume)
            if prior:
                return prior
            generation = self.realtime.authorize_search(
                request.client, request.secret, None if request.mode else session_id, request.mode,
            )
            if request.safety_action:
                self.realtime.suspend_search(session_id)
            full = (self._safety_occupied if request.safety_action
                    else runtime.ordinary_pending() >= MAX_ORDINARY_PENDING)
            if runtime._stopping or full:
                raise HttpError(503, "CAPACITY_REACHED", "Search saving capacity is occupied. Retry shortly.", True,
                                permission_revoked=request.safety_action)

            operation = Operation(fingerprint, mutation(request.action_id, "Pending", 202), owner,
                                  slot="safety" if request.safety_action else "ordinary")
            if request.action == "resume":
                if runtime._pending or self._safety_admissions:
                    raise HttpError(503, "NOT_READY", "Wait for the pending save before resuming.", True)
                if len(self.resume_cancellations()) >= MAX_RUNTIME_RECEIPTS:
                    raise HttpError(503, "CAPACITY_REACHED", "Resume action capacity is occupied.")
                self.realtime.begin_resume(session_id, request.revision)
                self._pending_resume = request
            if request.safety_action:
                self._safety_occupied = True
            if request.action == "stop":
                self._pending_stop = session_id
            task = asyncio.create_task(self.finish_action(request, operation, session_id, generation, superseded_resume))
            runtime._pending[request.action_id] = (operation, task)
            runtime._terminal.pop(request.action_id, None)
            self.realtime.operation_changed(session_id, operation.payload())
            return operation, task

    async def finish_action(
        self, request: SearchRequest, operation: "Operation", session: str, generation: int,
        superseded_resume: str | None,
    ) -> Receipt:
        runtime = self.runtime
        loop = asyncio.get_running_loop()

        def authorize(final: bool) -> None:
            if request.action in ("confirm", "reject") and self._pending_stop == session:
                raise HttpError(409, "INVALID_TRANSITION", f"Stop superseded {request.action}.")
            current = self.realtime.authorize_search(
                request.client, request.secret, None if request.mode else session, request.mode,
            )
            if generation != current:
                raise HttpError(403, "LEASE_EXPIRED", "The control lease is no longer current.")
            if request.action == "resume":
                self.realtime.check_resume(session, request.revision)
            if final and request.mode:
                self.realtime.prepare_start(session)

        async def authorize_on_loop(final: bool) -> None:
            authorize(final)

        def check(final: bool) -> None:
            asyncio.run_coroutine_threadsafe(authorize_on_loop(final), loop).result()

        saved: SavedSearch | None = None
        uncertain = False
        cancelled = False
        owner_unavailable = False
        try:
            async with runtime._save:
                try:
                    saved = await asyncio.to_thread(
                        save_search, runtime.storage, request, operation.fingerprint, session, runtime.preparing(), check,
                        superseded_resume,
                    )
                    assert saved.receipt is not None
                    response = saved.receipt
                except HttpError as error:
                    owner_unavailable = error.code in ("EXPIRED", "NOT_FOUND")
                    response = mutation(request.action_id, "Failed", error.status, error)
                except (OSError, sqlite3.Error):
                    try:
                        existing, owner = await asyncio.to_thread(
                            inspect_search, runtime.storage, request, operation.fingerprint,
                        )
                    except (OSError, sqlite3.Error, HttpError):
                        # With no readable receipt the caller can reconcile with the identical request.
                        uncertain = True
                        unknown = HttpError(503, "STORAGE_UNAVAILABLE", "The search save outcome is unconfirmed.", True)
                        return Receipt(bytes(unknown.response(action_id=request.action_id).body).decode(),
                                       unknown.status, None)
                    unavailable = storage_unavailable()
                    response = existing or mutation(request.action_id, "Failed", unavailable.status, unavailable)
                    if existing:
                        recovered = json.loads(existing.body)["result"]["session"]
                        target = None
                        if request.mode:
                            try:
                                target = await asyncio.to_thread(runtime.storage.read_object, owner, runtime.preparing())
                            except (OSError, sqlite3.Error, HttpError):
                                # A later eligible projection can still reconcile the committed receipt.
                                pass
                        saved = SavedSearch(recovered, owner, removed=recovered is None, receipt=existing, target=target,
                                            acknowledged=request.failure_ids)
                if request.action == "resume":
                    # Keep the saved result disarmed while a potential safety retry proves its identity.
                    while self._safety_admissions:
                        await self._safety_admission_idle.wait()
        finally:
            pending = runtime._pending.pop(request.action_id, None)
            eligible = pending is None or pending[0].visible
            if request.mode:
                self.realtime.resolve_start(session, saved is not None and saved.session is not None, uncertain=uncertain)
            if request.action == "resume":
                cancelled = self.realtime.resume_superseded(session)
                grant = False
                if saved and saved.session:
                    try:
                        authorize(False)
                    except HttpError:
                        pass
                    else:
                        grant = True
                if not grant and (uncertain or (saved and saved.session)):
                    # A lost writer result cannot grant authority. Ensure a possibly saved Resume is paused.
                    self.realtime.suspend_search(session)
                    self._deferred_pause = session
                    self.save_deferred_pause()
                if uncertain and self.realtime.active_revision == request.revision:
                    stopped = HttpError(409, "INVALID_TRANSITION", "The unconfirmed Resume was stopped.")
                    self.resume_cancellations()[request.action_id] = replace(
                        operation, response=mutation(request.action_id, "Failed", stopped.status, stopped),
                    )
                self.realtime.finish_resume(session, grant)
                self._pending_resume = None
            if request.safety_action:
                self.safety_slot_released()
            if request.action == "stop":
                self._pending_stop = None

        complete = replace(operation, response=response)
        if cancelled and saved is None and self.realtime.active_revision == request.revision:
            self.resume_cancellations()[request.action_id] = complete
        if request.action in ("confirm", "stop") and response.status == 200:
            runtime._retention_changed.set()
        if saved and saved.removed and saved.owner:
            self.realtime.search_ended(session)
            runtime.hide_removed_owner(saved.owner, request.action_id)
        elif not eligible:
            expired = HttpError(410, "EXPIRED", "The retention period for this record has ended.")
            return mutation(request.action_id, "Failed", expired.status, expired)
        elif owner_unavailable and operation.owner:
            runtime.hide_removed_owner(operation.owner, request.action_id)
        else:
            runtime.publish_terminal(request.action_id, complete)
            if saved and saved.session:
                recovery_changed = self.realtime.reconcile_failures(saved.acknowledged, saved.restored)
                self.realtime.publish_search_commit(saved.session, complete.payload(), saved.target, bool(runtime._pending),
                                                    recovery_changed=recovery_changed)
            else:
                self.realtime.operation_changed(session, complete.payload())
        return response

    def revoked(self, revocation: Revocation) -> None:
        if (revocation.session is None or revocation.reason in ("EmergencyStop", "SessionEnded")
                or revocation.reason in REVOCATION_FAILURES):
            return
        if self._safety_occupied:
            # A user action can lose its lease at the writer guard. Remember the
            # active pause obligation without admitting a second pending operation.
            self._deferred_pause = revocation.session
            if revocation.request_id is None:
                return
        request = revocation.request_id or str(uuid4())
        job = self.begin_pause(request, revocation.session, visible=revocation.request_id is not None)
        if revocation.request_id and self.realtime.lease_request_used(request):
            self.release_results[request] = job

    def safety_slot_released(self) -> None:
        self._safety_occupied = False
        if self._deferred_pause is not None:
            asyncio.get_running_loop().call_soon(self.save_deferred_pause)

    def save_deferred_pause(self) -> None:
        if self._safety_occupied or self._safety_admissions:
            return
        session, self._deferred_pause = self._deferred_pause, None
        if session is not None and self.realtime.safety_session == session and not self.runtime._stopping:
            self.begin_pause(str(uuid4()), session, visible=False)

    def begin_pause(
        self, request: str, session: str, observation: dict[str, object] | None = None, *, visible: bool = True,
    ) -> SafetySave:
        runtime = self.runtime
        failure = str(observation["failure_id"]) if observation else None
        if self.emergency_fallback is not None and failure:
            self.emergency_fallback.cancel()
            self.emergency_fallback = None
        owner = self.realtime.active_owner
        job = SafetySave(session, owner, failure, observation)
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
                                  request_id=request, slot=slot, visible=visible)
            key = "request:" + request
            job.task = asyncio.create_task(self.finish_pause(key, operation, job))
            runtime._pending[key] = (operation, job.task)
            if visible:
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
                    save_safety_pause, runtime.storage, job.session, (job.observation,) if job.observation else (),
                )
            receipt = Receipt(canonical_json({
                "action_id": request, "persistence": "Committed",
                "result": {**EMPTY_RESULT, "session": saved.session}, "error": None,
            }), 200, None)
        except (OSError, sqlite3.Error, HttpError):
            error = storage_unavailable()
            receipt = mutation(request, "Failed", error.status, error)
        finally:
            pending = runtime._pending.pop(key, None)
            visible = operation.visible and (pending is None or pending[0].visible)
            if job.failure:
                self._emergency_occupied = False
            else:
                self.safety_slot_released()
        job.persistence = "Committed" if saved is not None else "Failed"
        job.terminal_won = saved is not None and saved.session is None
        job.error = json.loads(receipt.body)["error"] if saved is None else None
        job.task = None
        complete = replace(operation, response=receipt)
        if saved and saved.owner and saved.session:
            job.owner = saved.owner
            if visible:
                runtime.publish_terminal(key, complete)
            recovery_changed = self.realtime.reconcile_failures((), saved.restored)
            self.realtime.publish_search_commit(
                saved.session, complete.payload() if visible else None, None, bool(runtime._pending),
                recovery_changed=recovery_changed,
            )
        elif visible:
            # If Stop won, acknowledge the request without publishing an owner payload.
            if job.terminal_won:
                complete = replace(complete, owner=None)
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
        self.realtime.record_failure("EmergencyStop", session)
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
        failure = self.realtime.failure_for(session, "EmergencyStop")
        if not failure or session != failure["session_id"]:
            return None
        previous = self.emergency_save
        if previous is not None and previous.failure == failure["failure_id"] and previous.persistence != "Failed":
            if self.emergency_fallback is not None:
                self.emergency_fallback.cancel()
                self.emergency_fallback = None
            return previous
        self.emergency_save = self.begin_pause(request, session, failure)
        return self.emergency_save

    async def emergency(self, request: str, client: str | None, session: str | None) -> tuple[int, dict[str, object]]:
        previous = self.emergency_results.get(request)
        if self.realtime.lease_request_used(request) or (previous is not None and previous[0] != client):
            self.persist_emergency(str(uuid4()), session)
            raise HttpError(409, "REQUEST_ID_CONFLICT", "This runtime request ID was already used.")
        if previous is None:
            if self.realtime.request_at_capacity():
                if self.emergency_fallback:
                    self.emergency_fallback.cancel()
                    self.emergency_fallback = None
                failure = self.realtime.failure_for(session, "EmergencyStop")
                return 503, {
                    "request_id": request, "backend_boot_id": self.runtime.boot_id, "permission_revoked": True,
                    "session_id": session,
                    "failure_id": failure["failure_id"] if failure and failure["session_id"] == session else None,
                    "persistence": "Failed",
                    "error": {"code": "CAPACITY_REACHED", "message": "Emergency request capacity is occupied.",
                              "retryable": False},
                }
            self.realtime.emergency_requests.add(request)
            job = self.persist_emergency(request, session)
            self.emergency_results[request] = (client, job)
        else:
            job = previous[1]
            failure = self.realtime.failure_for(session, "EmergencyStop")
            if job is None or job.session != session or (failure and job.failure != failure["failure_id"]):
                self.persist_emergency(str(uuid4()), session)
        await self.wait_for_save(job)
        eligible = job is not None and job.session == self.realtime.safety_session
        if job is not None and not job.terminal_won and job.owner is not None and not eligible:
            eligible = job.owner in await asyncio.to_thread(self.runtime.storage.eligible_owners, {job.owner})
        persistence = job.persistence if job else "Committed"
        error = job.error if job else None
        return {"Pending": 202, "Committed": 200, "Failed": 503}[persistence], {
            "request_id": request, "backend_boot_id": self.runtime.boot_id, "permission_revoked": True,
            "session_id": job.session if job and eligible and not job.terminal_won else None,
            "failure_id": job.failure if job and eligible and not job.terminal_won else None,
            "persistence": persistence, "error": error,
        }
