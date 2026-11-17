# Lost-Found_Robotic_Car

The phases 01–03 frontend is implemented against labeled fixtures. See the [frontend setup guide](frontend/README.md) to launch it and run verification. There is no production backend, AI or device connection in this release.

The [roadmap](docs/IMPLEMENTATION_PLAN.md) keeps phases 04–08 as future work: local backend/storage, session authority, pretrained AI and input integration, devices/firmware, then offline qualification. The [TRD reuse and environment assessment](docs/TRD.md#21-reuse-and-license-assessment) records inspected references, license gates, the supplied laptop baseline and required experiments.

Gesture controls use 0 fingers for neutral/stop, 1 forward, 2 backward, 3 left and 4 right. Five fingers, no hand, multiple hands or uncertain/changing recognition stop. The fixture harness simulates these observations; real MediaPipe recognition remains Phase 06 work.

Backend/GPU setup, exact Python/package locks, model/task downloads, Bluetooth pairing, camera configuration and the Windows launcher will be documented with tested commands as phases 04–08 deliver them. Do not interpret the proposed Python 3.11 environment or the documented YOLOE candidates as an installed or qualified combination. All runtime assets must be local before the offline demonstration.
