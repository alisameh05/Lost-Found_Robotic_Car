import asyncio
import re
import unicodedata
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractContextManager, asynccontextmanager, nullcontext

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from .config import Config
from .http import (
    API_PREFIX,
    CLIENT_ROUTES,
    HEADER_LIMIT,
    OBJECT_QUERY,
    HttpError,
    authorize_address,
    authorize_client,
    invalid_query,
    parse_query,
    preflight,
    require_empty_body,
    route_path,
)
from .owner import own_data_root
from .runtime import RecordsRuntime
from .storage import RecordsStorage

WHITE_SPACE = (
    "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)


def validate_objects_query(query: dict[str, str]) -> None:
    name = unicodedata.normalize("NFC", query.get("name", "").strip(WHITE_SPACE))
    if len(name) > 120:
        raise invalid_query("OUT_OF_RANGE", "/query/name")
    if "status" in query and query["status"] not in ("Lost", "Found"):
        raise invalid_query("INVALID_VALUE", "/query/status")
    if "limit" in query:
        limit = query["limit"]
        if not limit.isascii() or not limit.isdecimal():
            raise invalid_query("INVALID_TYPE", "/query/limit")
        significant = limit.lstrip("0")
        if not significant or len(significant) > 3 or int(significant) > 100:
            raise invalid_query("OUT_OF_RANGE", "/query/limit")


def create_app(config: Config, *, held_owner: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owner: AbstractContextManager[None] = nullcontext() if held_owner else own_data_root(config.data_root)
        with owner:
            runtime = RecordsRuntime(RecordsStorage(config.data_root))
            app.state.runtime = runtime
            startup = asyncio.create_task(runtime.initialize())
            try:
                yield
            finally:
                # Keep the lock until background initialization has finished.
                await startup

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
                parse_query(request.scope["query_string"], OBJECT_QUERY if path == "/objects" else ())
                await require_empty_body(request)
                response = preflight(request, path)
            else:
                if path != "/bootstrap" or request.method != "GET":
                    authorize_client(request, request.app.state.runtime, required=path in CLIENT_ROUTES)
                if not path or request.method != "GET":
                    raise HttpError(404, "NOT_FOUND", "The requested operation is unavailable.")
                query = parse_query(request.scope["query_string"], OBJECT_QUERY if path == "/objects" else ())
                await require_empty_body(request)
                if path == "/objects":
                    validate_objects_query(query)
                    request.state.objects_query = query
                response = await next_route(request)
        except HttpError as exc:
            response = exc.response()
        except Exception:
            response = HttpError(500, "INTERNAL_ERROR", "The records service could not complete the request.").response()
        response.headers["Cache-Control"] = "no-store"
        response.headers["Vary"] = (
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" if options else "Origin"
        )
        if origin_authorized:
            response.headers["Access-Control-Allow-Origin"] = config.origin
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
                return error.response(snapshot=runtime.snapshot(storage))
            return error.response()
        match request.scope["path"].removeprefix(API_PREFIX):
            case "/settings":
                return JSONResponse(storage.settings)
            case "/objects":
                cursor = request.state.objects_query.get("cursor")
                if cursor is not None:
                    # This empty feed never issues cursors. A well-formed incoming token has no live context.
                    code = "CURSOR_EXPIRED" if re.fullmatch("[A-Za-z0-9_-]{43}", cursor) else "CURSOR_INVALID"
                    return HttpError(400, code, "Refresh the first page of objects.").response()
                return JSONResponse({"items": [], "next_cursor": None})
            case _:
                return JSONResponse(runtime.snapshot(storage))

    return app
