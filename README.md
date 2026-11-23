# Lost-Found_Robotic_Car

On Windows, follow the [production setup and launcher guide](docs/WINDOWS_LAUNCHER.md) to start the app with `./launch.ps1`. The [records setup guide](backend/README.md) covers development startup and backend verification. The [frontend setup guide](frontend/README.md) covers the labeled fixture journeys.

The [roadmap](docs/IMPLEMENTATION_PLAN.md) covers the remaining records work, session authority, pretrained AI and input integration, devices and firmware, and offline qualification. The [TRD reuse and environment assessment](docs/TRD.md#21-reuse-and-license-assessment) records inspected references, license gates, the supplied laptop baseline and required experiments.

Gesture controls use 0 fingers for neutral/stop, 1 forward, 2 backward, 3 left and 4 right. Five fingers, no hand, multiple hands or uncertain/changing recognition stop. The fixture harness simulates these observations; real MediaPipe recognition remains Phase 06 work.

The independent [Phase 04 vision experiment](experiments/vision/README.md) provides isolated Python setup, a hashed combined dependency lock, deliberate model and task downloads, and recorded-image probes.
