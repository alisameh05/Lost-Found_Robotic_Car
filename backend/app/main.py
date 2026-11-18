import asyncio
import sqlite3
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractContextManager, asynccontextmanager, nullcontext

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .config import Config
from .http import (
    API_PREFIX,
    CLIENT_ROUTES,
    HEADER_LIMIT,
    LIST_QUERIES,
    RECORDS_ROUTES,
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
from .registration_input import NAME_LIMIT, normalize_name, parse_registration
from .runtime import PageError, RecordsRuntime
from .storage import RecordsStorage, storage_unavailable

PAGE_ERRORS = {
    "cursor_expired": (400, "CURSOR_EXPIRED", "Refresh the first page.", False),
    "scope_mismatch": (400, "CURSOR_INVALID", "Refresh the first page or use the original page context.", False),
    "capacity": (503, "CAPACITY_REACHED", "Page capacity reached. Retry after pending reads complete.", True),
    "client_expired": (403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.", False),
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


def create_app(config: Config, *, held_owner: bool = False, storage: RecordsStorage | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owner: AbstractContextManager[None] = nullcontext() if held_owner else own_data_root(config.data_root)
        with owner:
            runtime = RecordsRuntime(storage or RecordsStorage(config.data_root))
            app.state.runtime = runtime
            startup = asyncio.create_task(runtime.initialize())
            try:
                yield
            finally:
                # Keep ownership until startup and admitted registrations have finished.
                try:
                    await startup
                    await runtime.stop()
                finally:
                    await asyncio.to_thread(runtime.storage.close)

    app = FastAPI(
        lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False,
    )

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
                registering = request.method == "POST"
                if registering:
                    header(request, "x-app-client-id", 403, "CLIENT_INVALID")
                if not registering and path != "/bootstrap":
                    authorize_client(request, runtime, required=path in CLIENT_ROUTES)
                allowed = LIST_QUERIES.get(path, ()) if not registering else ()
                query = parse_query(request.scope["query_string"], allowed)
                if not registering:
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
                return error.response(snapshot=await runtime.snapshot(storage))
            return error.response()
        if request.scope["path"] == API_PREFIX + "/settings":
            return JSONResponse(storage.settings)
        return JSONResponse(await runtime.snapshot(storage))

    return app
