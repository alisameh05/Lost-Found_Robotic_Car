import argparse
import os
import socket
import sys
from collections.abc import Sequence
from threading import Event, Thread

import uvicorn
from fastapi import FastAPI

from .config import LOOPBACK, Config
from .main import create_app
from .owner import OwnerUnavailable, own_data_root
from .runtime import RecordsRuntime


class RecordsServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, stop: Event | None):
        super().__init__(config)
        self.stop_requested = stop

    async def on_tick(self, counter: int) -> bool:
        return bool(self.stop_requested and self.stop_requested.is_set()) or await super().on_tick(counter)

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        # Uvicorn drains HTTP and WebSocket work before lifespan teardown. Disarm
        # and close control admission before that drain, even if a request stalls.
        app = self.config.app
        assert isinstance(app, FastAPI)
        runtime: RecordsRuntime = app.state.runtime
        pending = runtime.begin_shutdown()
        if self.stop_requested is not None:
            print(f"Motion permission revoked. Pending saves at shutdown: {pending}.", flush=True)
            if pending:
                print("Check History or retry the same request after restart for any unconfirmed save.", flush=True)
        await super().shutdown(sockets)


def watch_launcher(stop: Event) -> None:
    # The launcher owns the writing end. EOF also covers launcher process loss.
    try:
        while os.read(sys.stdin.fileno(), 1):
            pass
    except OSError:
        pass
    finally:
        stop.set()


def main(argv: Sequence[str] = ()) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--supervised", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        stop = None
        capability = None
        if args.supervised:
            capability = os.environ.pop("LAF_LAUNCH_CAPABILITY", None)
            if not capability:
                raise ValueError("Start the supervised backend through the Windows launcher.")
            stop = Event()
            Thread(target=watch_launcher, args=(stop,), daemon=True).start()
        config = Config.from_environment()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            # Windows can otherwise allow overlapping binds if either process reuses the address.
            if sys.platform == "win32":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                listener.bind((LOOPBACK, config.backend_port))
            except OSError:
                print(f"Records backend cannot bind {config.host}. Free that port or configure a different one.",
                      file=sys.stderr)
                return 1
            with own_data_root(config.data_root):
                app = (create_app(config, held_owner=True, capability=capability) if capability
                       else create_app(config, held_owner=True))
                server = RecordsServer(uvicorn.Config(
                    app, host=LOOPBACK, port=config.backend_port,
                    workers=1, reload=False, proxy_headers=False, access_log=False, http="httptools", ws="websockets",
                    ws_max_size=app.state.socket_message_limit, ws_max_queue=1, ws_per_message_deflate=False,
                    log_level="warning", timeout_graceful_shutdown=5 if stop else None,
                ), stop)
                server.run(sockets=[listener])
                return 0 if server.started and app.state.shutdown_complete else 1
    except (ValueError, OwnerUnavailable) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
