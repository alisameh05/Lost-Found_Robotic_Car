# Lost-Found_Robotic_Car

The phases 01–03 frontend is implemented against labeled fixtures. See the [frontend setup guide](frontend/README.md) to launch it and run verification. There is no production backend, AI or device connection in this release.

The [roadmap](docs/IMPLEMENTATION_PLAN.md) keeps phases 04–08 as future work: local backend/storage, session authority, pretrained AI and input integration, devices/firmware, then offline qualification. The [TRD reuse and environment assessment](docs/TRD.md#21-reuse-and-license-assessment) records inspected references, license gates, the supplied laptop baseline and required experiments.

Gesture controls use 0 fingers for neutral/stop, 1 forward, 2 backward, 3 left and 4 right. Five fingers, no hand, multiple hands or uncertain/changing recognition stop. The fixture harness simulates these observations; real MediaPipe recognition remains Phase 06 work.

The independent [Phase 04 vision experiment](experiments/vision/README.md) provides isolated Python setup, a hashed combined dependency lock, deliberate model/task downloads and recorded-image probes. Its measured evidence and limitations are separate from production recognition or device qualification. Bluetooth pairing, camera configuration, the backend and the Windows launcher remain in their owning tickets. All runtime assets must be local before the offline demonstration.
