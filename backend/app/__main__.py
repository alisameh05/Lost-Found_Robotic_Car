import socket
import sys

import uvicorn

from .config import LOOPBACK, Config
from .main import create_app
from .owner import OwnerUnavailable, own_data_root


def main() -> int:
    try:
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
                server = uvicorn.Server(uvicorn.Config(
                    create_app(config, held_owner=True), host=LOOPBACK, port=config.backend_port,
                    workers=1, reload=False, proxy_headers=False, access_log=False, http="httptools", ws="none",
                ))
                server.run(sockets=[listener])
                return 0 if server.started else 1
    except (ValueError, OwnerUnavailable) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
