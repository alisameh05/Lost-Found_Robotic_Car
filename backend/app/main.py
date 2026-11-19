import asyncio
import sqlite3
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractContextManager, asynccontextmanager, nullcontext

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from PIL import Image

from .config import Config
from .control import LeaseFailure, LeaseRejected, Revocation, parse_lease
from .http import (
    API_PREFIX,
    CLIENT_ROUTES,
    HEADER_LIMIT,
    LEASE_ROUTES,
    LIST_QUERIES,
    RECORDS_ROUTES,
    RETENTION_ROUTES,
    SEARCH_ROUTES,
    HttpError,
    authorize_address,
    authorize_capability,
    authorize_client,
    header,
    invalid_query,
    parse_query,
    preflight,
    require_empty_body,
    route_path,
)
from .owner import own_data_root
from .realtime import CHANNELS, Channel, ticket_request
from .registration_input import NAME_LIMIT, normalize_name, parse_registration
from .retention_input import parse_retention
from .runtime import PageError, RecordsRuntime
from .search_input import parse_emergency, parse_search
from .simulation import IncompatibleProfile, Simulation, load_simulation
from .storage import RecordsStorage, storage_unavailable

PAGE_ERRORS = {
    "cursor_expired": (400, "CURSOR_EXPIRED", "Refresh the first page.", False),
    "scope_mismatch": (400, "CURSOR_INVALID", "Refresh the first page or use the original page context.", False),
    "capacity": (503, "CAPACITY_REACHED", "Page capacity reached. Retry after pending reads complete.", True),
    "client_expired": (403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.", False),
}

LEASE_ERRORS: dict[LeaseFailure, tuple[int, str, bool]] = {
    "CLIENT_INVALID": (403, "Reconnect to obtain a current page identity.", False),
    "LEASE_EXPIRED": (403, "The control lease is no longer current.", False),
    "LEASE_REQUIRED": (403, "Release requires the current private control lease.", False),
    "LEASE_OWNED": (403, "Control is already held.", False),
    "OWNERSHIP_MISMATCH": (409, "The active search changed.", False),
    "REQUEST_ID_CONFLICT": (409, "This runtime request ID was already used.", False),
    "INVALID_TRANSITION": (409, "Confirm takeover to acquire available control.", False),
    "NOT_READY": (503, "Synchronize the current search workspace and try again.", True),
    "CAPACITY_REACHED": (503, "Control request capacity reached. Restart the disarmed service.", False),
    "COUNTER_EXHAUSTED": (503, "Restart the disarmed service before acquiring again.", False),
    "STORAGE_UNAVAILABLE": (503, "Control was released. The active search pause could not be saved.", False),
}


def validate_objects_query(query: dict[str, str]) -> None:
    name = normalize_name(query.get("name", ""))
    if len(name) > NAME_LIMIT:
        raise invalid_query("OUT_OF_RANGE", "/query/name")
    query["name"] = name
    if "status" in query and query["status"] not in ("Lost", "Found"):
        raise invalid_query("INVALID_VALUE", "/query/status")


def validate_page_limit(query: dict[str, str]) -> None:
    if "limit" in query:
        limit = query["limit"]
        if not limit.isascii() or not limit.isdecimal():
            raise invalid_query("INVALID_TYPE", "/query/limit")
        significant = limit.lstrip("0")
        if not significant or len(significant) > 3 or int(significant) > 100:
            raise invalid_query("OUT_OF_RANGE", "/query/limit")
        query["limit"] = significant


def _ignore_invalidation(_: str, __: Channel) -> None:
    pass


def _ignore_revocation(_: Revocation) -> None:
    pass


def create_app(
    config: Config, *, held_owner: bool = False, storage: RecordsStorage | None = None,
    simulation: Simulation | None = None, on_channel_invalidated: Callable[[str, Channel], None] = _ignore_invalidation,
    on_control_revoked: Callable[[Revocation], None] = _ignore_revocation,
) -> FastAPI:
    unavailable_code = "NOT_READY"
    if simulation is None:
        try:
            simulation = load_simulation(config.simulation_profile)
        except IncompatibleProfile:
            unavailable_code = "PROTOCOL_UNSUPPORTED"
        except (OSError, ValueError, KeyError, Image.DecompressionBombError):
            # Records/diagnostics remain available if fixture evidence could not be validated.
            pass

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owner: AbstractContextManager[None] = nullcontext() if held_owner else own_data_root(config.data_root)
        with owner:
            runtime = RecordsRuntime(storage or RecordsStorage(config.data_root))
            app.state.runtime = runtime
            realtime = runtime.enable_realtime(simulation, unavailable_code, on_channel_invalidated, on_control_revoked)
            startup = asyncio.create_task(runtime.initialize())
            tasks = (
                asyncio.create_task(realtime.capture()), asyncio.create_task(realtime.maintain_projection()),
                asyncio.create_task(realtime.maintain_control()),
            ) if simulation else ()
            try:
                yield
            finally:
                # Keep ownership until startup and admitted registrations have finished.
                try:
                    realtime.stop()
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                    await startup
                    await runtime.stop()
                finally:
                    await asyncio.to_thread(runtime.storage.close)

    app = FastAPI(
        lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False,
    )

    app.state.socket_message_limit = simulation.profile.bound("max_client_message_bytes") if simulation else 4096

    @app.middleware("http")
    async def protect(request: Request, next_route: Callable[[Request], Awaitable[Response]]) -> Response:
        options = request.method == "OPTIONS"
        origin_authorized = False
        try:
            if sum(len(key) + len(value) + 4 for key, value in request.scope["headers"]) > HEADER_LIMIT:
                raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request headers exceed the supported size.")
            path = route_path(request)
            authorize_address(request, config, options or path == "/bootstrap")
            origin_authorized = request.headers.get("origin") == config.origin
            if options:
                allowed = LIST_QUERIES.get(path, ()) if request.headers.get("access-control-request-method") == "GET" else ()
                parse_query(request.scope["query_string"], allowed)
                await require_empty_body(request)
                response = preflight(request, path)
            else:
                runtime: RecordsRuntime = request.app.state.runtime
                if path != "/bootstrap" or request.method != "GET":
                    authorize_capability(request, runtime)
                if request.method not in RECORDS_ROUTES.get(path, ()):
                    raise HttpError(404, "NOT_FOUND", "The requested operation is unavailable.")
                registering = path == "/objects" and request.method == "POST"
                if path == "/settings/retention":
                    if not header(request, "x-app-client-id", 403, "CLIENT_INVALID"):
                        raise HttpError(403, "CLIENT_INVALID", "Provide a page identity for the retention request.")
                elif registering:
                    header(request, "x-app-client-id", 403, "CLIENT_INVALID")
                elif path != "/bootstrap" and path not in LEASE_ROUTES | SEARCH_ROUTES:
                    authorize_client(request, runtime, required=path in CLIENT_ROUTES)
                allowed = LIST_QUERIES.get(path, ()) if not registering else ()
                query = {} if path == "/emergency-stop" else parse_query(request.scope["query_string"], allowed)
                if not registering and path not in RETENTION_ROUTES | LEASE_ROUTES | SEARCH_ROUTES | {"/websocket-tickets"}:
                    await require_empty_body(request)
                if path == "/objects" and not registering:
                    validate_objects_query(query)
                if allowed:
                    validate_page_limit(query)
                    request.state.page_query = query
                response = await next_route(request)
        except HttpError as exc:
            response = exc.response()
        except (OSError, sqlite3.Error):
            response = storage_unavailable().response()
        except Exception:
            response = HttpError(500, "INTERNAL_ERROR", "The records service could not complete the request.").response()
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = (
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" if options else "Origin"
        )
        if origin_authorized:
            response.headers["Access-Control-Allow-Origin"] = config.origin
            if "Location" in response.headers:
                response.headers["Access-Control-Expose-Headers"] = "Location"
            elif path == "/media/{id}" and response.status_code == 200:
                response.headers["Access-Control-Expose-Headers"] = "X-Content-Type-Options, Accept-Ranges"
        return response

    @app.get(API_PREFIX + "/bootstrap")
    async def bootstrap(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        context = runtime.bootstrap()
        if context is None:
            return HttpError(503, "CAPACITY_REACHED", "Page capacity reached. Retry after a client expires.", True).response()
        return JSONResponse(context)

    @app.post(API_PREFIX + "/websocket-tickets")
    async def websocket_ticket(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        assert runtime.realtime is not None
        return JSONResponse(await ticket_request(request, runtime.realtime))

    @app.post(API_PREFIX + "/control-lease")
    @app.post(API_PREFIX + "/control-lease/release")
    async def control_lease(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        assert runtime.realtime is not None
        parsed = await parse_lease(request, release=route_path(request) == "/control-lease/release")
        try:
            outcome = await runtime.realtime.change_lease(parsed)
            assert runtime.sessions is not None
            job = runtime.sessions.release_results.get(parsed.request_id)
            if job is None:
                return JSONResponse(outcome)
            await runtime.sessions.wait_for_save(job)
            snapshot = await runtime.realtime.snapshot(parsed.client)
            if snapshot is not None:
                outcome["snapshot"] = snapshot
            persistence = job.persistence
            if persistence == "Failed":
                raise LeaseRejected("STORAGE_UNAVAILABLE", permission_revoked=True, snapshot=snapshot)
            return JSONResponse(outcome, status_code=202 if persistence == "Pending" else 200)
        except LeaseRejected as failure:
            status, message, retryable = LEASE_ERRORS[failure.reason]
            error = HttpError(status, failure.reason, message, retryable)
            details: dict[str, object] = {}
            if failure.permission_revoked:
                details["permission_revoked"] = True
            if failure.snapshot is not None:
                details["snapshot"] = failure.snapshot
            return error.response(**details)

    @app.post(API_PREFIX + "/sessions")
    @app.post(API_PREFIX + "/sessions/{id}/actions")
    async def change_session(request: Request) -> Response:
        runtime: RecordsRuntime = request.app.state.runtime
        assert runtime.sessions is not None
        parsed = await parse_search(request, request.path_params.get("id"))
        receipt = await runtime.sessions.action(parsed)
        return Response(receipt.body, status_code=receipt.status, media_type="application/json",
                        headers={"Location": receipt.location} if receipt.location else None)

    @app.post(API_PREFIX + "/emergency-stop")
    async def emergency_stop(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        assert runtime.sessions is not None
        session = runtime.sessions.emergency_revoke()
        try:
            parse_query(request.scope["query_string"], ())
            request_id, client = await parse_emergency(request)
            status, body = await runtime.sessions.emergency(request_id, client, session)
            return JSONResponse(body, status_code=status)
        except HttpError as error:
            return error.response(permission_revoked=True)
        except (OSError, sqlite3.Error):
            return storage_unavailable().response(permission_revoked=True)

    @app.websocket(API_PREFIX + "/events")
    @app.websocket(API_PREFIX + "/video/robot")
    @app.websocket(API_PREFIX + "/video/webcam")
    async def realtime_channel(socket: WebSocket) -> None:
        runtime: RecordsRuntime = socket.app.state.runtime
        assert runtime.realtime is not None
        path = socket.scope["path"].removeprefix(API_PREFIX)
        await runtime.realtime.serve(socket, CHANNELS[path], config)

    @app.get(API_PREFIX + "/health")
    async def health(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        storage = await runtime.inspect()
        return JSONResponse(runtime.health(storage), status_code=200 if storage and not storage.problem else 503)

    @app.get(API_PREFIX + "/objects")
    @app.get(API_PREFIX + "/objects/{id}/sessions")
    @app.get(API_PREFIX + "/sessions/{id}/matches")
    async def records_page(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        runtime.check_started()
        try:
            page = await runtime.page(
                route_path(request), request.headers["x-app-client-id"],
                request.state.page_query, request.path_params.get("id"),
            )
        except PageError as error:
            raise HttpError(*PAGE_ERRORS[error.reason]) from error
        return JSONResponse(page)

    @app.post(API_PREFIX + "/objects")
    async def register(request: Request) -> Response:
        runtime: RecordsRuntime = request.app.state.runtime
        registration = await parse_registration(request)
        receipt = await runtime.register(registration, lambda: authorize_client(request, runtime, required=True))
        return Response(receipt.body, status_code=receipt.status, media_type="application/json",
                        headers={"Location": receipt.location} if receipt.location else None)

    @app.get(API_PREFIX + "/objects/{id}")
    async def object_details(request: Request, id: str) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        runtime.check_started()
        return JSONResponse(await asyncio.to_thread(runtime.storage.read_object, id, runtime.preparing()))

    @app.get(API_PREFIX + "/sessions/{id}")
    async def session_details(request: Request, id: str) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        runtime.check_started()
        return JSONResponse(await asyncio.to_thread(runtime.storage.read_session, id, runtime.preparing()))

    @app.get(API_PREFIX + "/media/{id}")
    async def protected_media(request: Request, id: str) -> Response:
        runtime: RecordsRuntime = request.app.state.runtime
        runtime.check_started()
        kind, data = await asyncio.to_thread(runtime.storage.read_media, id, runtime.preparing())
        return Response(data, media_type=kind, headers={"X-Content-Type-Options": "nosniff", "Accept-Ranges": "none"})

    @app.get(API_PREFIX + "/settings")
    @app.get(API_PREFIX + "/snapshot")
    async def records(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        storage = await runtime.inspect()
        if storage is None:
            return HttpError(503, "INITIALIZING", "Checking records storage. Retry when initialization finishes.", True).response()
        if storage.problem or storage.settings is None:
            error = HttpError(503, "STORAGE_UNAVAILABLE", storage.problem or "Records storage is unavailable.", True)
            if storage.cleanup_pending and storage.settings:
                state = (await runtime.realtime.snapshot(request.headers.get("x-app-client-id"))
                         if runtime.realtime and runtime.realtime.profile else await runtime.snapshot(storage))
                if state is not None:
                    return error.response(snapshot=state)
            return error.response()
        if request.scope["path"] == API_PREFIX + "/settings":
            return JSONResponse(storage.settings)
        if runtime.realtime and runtime.realtime.profile:
            snapshot = await runtime.realtime.snapshot(request.headers["x-app-client-id"])
            if snapshot is None:
                return HttpError(503, "NOT_READY", "The current snapshot is unavailable. Retry shortly.", True).response()
            return JSONResponse(snapshot)
        return JSONResponse(await runtime.snapshot(storage))

    @app.post(API_PREFIX + "/settings/retention-preview")
    async def retention_preview(request: Request) -> JSONResponse:
        runtime: RecordsRuntime = request.app.state.runtime
        proposal, _ = await parse_retention(request, commit=False)
        return JSONResponse(await runtime.preview_retention(request.headers["x-app-client-id"], proposal))

    @app.put(API_PREFIX + "/settings/retention")
    async def retention_commit(request: Request) -> Response:
        runtime: RecordsRuntime = request.app.state.runtime
        _, change = await parse_retention(request, commit=True)
        assert change is not None
        receipt = await runtime.commit_retention(
            request.headers["x-app-client-id"], change, lambda: authorize_client(request, runtime, required=True),
        )
        return Response(receipt.body, status_code=receipt.status, media_type="application/json")

    return app
