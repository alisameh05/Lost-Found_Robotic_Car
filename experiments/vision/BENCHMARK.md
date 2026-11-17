# Measured baseline — 2026-11-17

Both approved YOLOE checkpoints executed visual-prompt inference on the RTX
4050 through CUDA. MediaPipe Tasks initialized its local task and processed
two hands. The recorded-image dependency gate passes for this tested setup.
**Use Small provisionally for Phase 06 experiments:** it produced the two
qualitative target candidates here; Nano produced none at confidence 0.25.
This does not close Phase 04's records tickets or the product's AI/device gates.

Raw evidence: [GPU](evidence/gpu-offline.json), [CPU](evidence/cpu-offline.json),
[fresh hardware](evidence/hardware.json), [package/license inventory](evidence/packages.json),
[asset hashes](assets.json), [dependency hashes](requirements.lock).
Commands and coordinate semantics are in [README.md](README.md); terms and
redistribution limits are in [NOTICES.md](NOTICES.md).

## Fresh environment, separate from supplied specifications

- CIM identifies Windows 11 Pro, version 10.0.26300; registry reports 26H2 and
  UBR 9974. Windows' legacy registry ProductName and Python platform string
  still say Windows 10; the raw discrepancy is retained, not silently rewritten.
- CPU: Intel Core i7-13620H. Windows exposes 13,941,923,840 bytes (~12.98 GiB)
  usable RAM. The supplied 16 GB physical-memory description is historical;
  it is not the available/usable memory measurement. Available RAM at GPU
  process start was ~1.10 GiB and fell to ~269 MiB during sampled inference.
- RTX 4050 Laptop GPU; driver 560.94; 6,141 MiB dedicated VRAM. The driver
  utility's CUDA label was not used as execution evidence. PyTorch reports
  CUDA 12.4, `cuda.is_available()` true, a real CUDA tensor operation result 8,
  and both checkpoints' actual parameter device `cuda:0`.
- GPU probe start: C: ~11.10 GiB and D: ~77.51 GiB free after setup. These are
  fresh free-space measurements, not the historical NVMe description.
- Existing Python **3.13.7 remains installed**, with SQLite 3.50.4. The isolated
  tested interpreter is Python **3.11.14**, also SQLite 3.50.4. Node is 24.21.0.
- Principal tested pins: torch 2.6.0+cu124, torchvision 0.21.0+cu124,
  Ultralytics 8.4.23, MediaPipe 0.10.32, NumPy 1.26.4, OpenCV/contrib
  4.11.0.86, FastAPI 0.163.2, Uvicorn 0.41.0, Pygame 2.6.1 / SDL 2.28.4,
  pySerial 3.5. The full transitive pins/hashes and installed inventory are retained.

## Results and conditions

Measurements used FP32, imgsz 640, confidence 0.25, four PyTorch/OpenCV CPU
threads, one reference region and separate recorded target/negative images.
The desktop and existing applications remained open; the Next.js production
server was running on loopback. MediaPipe remained initialized during YOLOE.
There was no production backend, active browser journey, webcam, robot camera,
controller or serial workload. Unit verification was started near the end of
the CPU run; possible overlap further limits the CPU comparison. Neither run
is a controlled simultaneous operational workload or an FPS qualification.

Each process loads Nano then Small. "Load" means a fresh checkpoint/model
object plus device transfer, excluding import and an already-created CUDA
context. "Prompt + first" includes encoding, predictor preparation/warmup and
first target call. OS file caches were not flushed and Small benefits from
libraries already used by Nano; these are not independent cold-machine runs.
GPU calls synchronize before/after timing. Memory sampling is outside timing.

| Device / model | Load ms | Prompt + first ms | Warm median ms | Warm min–max ms | Repetitions | Target / negative boxes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| CUDA / Nano | 441.95 | 2785.32 | 25.27 | 17.08–158.79 | 20 | 0 / 0 |
| CUDA / Small | 200.92 | 567.31 | 23.01 | 18.80–49.64 | 20 | 2 / 0 |
| CPU / Nano | 96.54 | 670.81 | 75.13 | 72.33–91.84 | 5 | 0 / 0 |
| CPU / Small | 104.06 | 547.57 | 166.35 | 145.19–220.70 | 5 | 2 / 0 |

Cold process startup is material: torch import took **39.44 s** in the GPU
process and **23.44 s** in the CPU process under the observed desktop/memory
conditions. Do not use warmed call times as startup or camera-to-alert latency.
No RAM upgrade conclusion or latency threshold follows from these short runs.

The saved bus photograph has a person ROI xywh `(50,390,190,510)`, converted
to source xyxy `(50,390,240,900)`. The different 1280×720 target photograph
contains two people; Small returned boxes approximately `(749,44,1150,719)`
and `(125,205,1052,717)`, confidence 0.432 and 0.418. Visual inspection of the
source photographs agrees that these cover the two people. Nano returned no
candidates. Neither result establishes the same person's identity or belonging
recognition. The 720×382 isolated-hands image was a negative scene for this
full-person reference; both checkpoints returned no boxes in this single scene.
There are no precision/recall or false-alert-rate claims from three photographs.

GPU warmed process RSS was approximately **1,188 MiB Nano / 1,202 MiB Small**,
including MediaPipe and the shared loaded libraries. Warm-sample RSS changed
by -0.72 MiB / +0.07 MiB respectively. CPU warm RSS changed by 0 / +0.01 MiB.
These short samples show no monotonic large growth, but cannot establish leak
freedom or twenty-minute stability. Windows can trim process working sets.

GPU allocator peaks were approximately **109 MiB Nano / 212 MiB Small**;
reserved memory after warmed calls was **142 / 246 MiB**. Raw nvidia-smi
reported **256 / 360 MiB used** after warmed calls. CUDA allocator counters,
CUDA free-memory accounting and WDDM's system-wide dedicated-memory report
have different scopes; none includes shared system RAM as extra dedicated VRAM.
The probe retains all raw samples and post-reference-change/reload counters.

Both checkpoints encoded once for the initial reference and stayed at one
through repeated target calls. Reference/ROI replacement raised the count to
two and changed the embedding hash. Fresh model reload raised it to three
and restored the original hash. Each model starts a new context and encodes
its own reference; no prompt is carried between checkpoint instances. This
supports caching by omitting `visual_prompts` on subsequent target calls.
Calling the reference-prompt API again re-encodes it. Production session,
generation, concurrency and worker invalidation remain Phase 06 responsibilities.

MediaPipe `tasks.vision.HandLandmarker` initialized on CPU in **2.03 s / 2.52 s**
in the GPU/CPU processes and processed its saved two-hand image in **57.66 /
51.76 ms**, yielding `[21,21]` landmarks. Its native XNNPACK, feedback-tensor
and NORM_RECT warnings were observed without a failed result. No finger-count
classifier, stabilization or webcam worker was created or qualified.

## Offline verification and setup failures

Both retained runs used only explicit local assets, after deliberate setup,
with Python DNS/socket connections denied and Ultralytics automatic installation
disabled. Both reports contain **zero network attempts and zero failures**.
`setup.ps1 -Offline` also completed from the wheel cache with `pip check`
passing. Python audit enforcement is not a machine-wide air gap or proof about
arbitrary native library networking; no system network configuration was changed.

The initial setup encountered a DNS failure at the alternate PyTorch CDN.
A direct official-CDN transfer was slow. Resumable parallel HTTP ranges were
used locally to cache the same 2,532,350,702-byte wheel, verified against lock
SHA-256 `6a1fb2714e9323f11edb6e8abf7aad5f79e45ad25c081cde87681a18d99c29eb`.
Normal reproducible setup remains the documented hash-required wheel download
and cache installation. No substitute runtime/model was used.

The first lock draft targeted the host Python and selected NetworkX 3.7,
which excludes Python 3.11. The installer rejected it before incorporation;
the retained lock explicitly targets Windows x64/Python 3.11 and tests 3.6.1.
The dual OpenCV-provider setup constraint is documented and tested through
contrib availability and real image processing. Backend changes must preserve
or deliberately requalify this exact combination before Phase 04 acceptance.

## Verification and remaining gates

`verify.ps1` passes all **11** coordinate/probe checks (including the installed
Ultralytics coordinate API), Ruff, Mypy and dependency consistency. Orientation
direction, non-square/edge boxes, resize/letterbox inversion, empty/nonfinite
rejection, denied networking and missing-asset failure are exercised. The
frontend's **82 unit tests** also pass via direct Node/Vitest invocation;
`npm test`'s Windows command shim splits this repository's `&` path. Frontend
source was unchanged. Frontend browser/build checks were not rerun for this
independent Python experiment.

No required recorded-image experiment is left unperformed or failed in the
retained baseline. The limited Nano qualitative miss remains visible. Selecting
Small is provisional: representative belongings, distractors and lighting must
still be measured before choosing T5 thresholds/settings. Remaining gates are
production storage/API, session and safety behavior, simultaneous input/video/
inference load, recognition trials, display latency, continuity, wheel stopping,
integrated stability, battery, room coverage and release/license packaging.
None is closed by this ticket. No device information is needed to reproduce it.

## Remaining-phase reforecast

The roadmap's original 51-hour allocation for phases 04–08 included feasibility
and was explicitly provisional. It is not a measured remaining estimate. Setup
has exposed significant download/unpacking costs, severe available-RAM pressure
and a Nano quality limitation; library reuse does not remove integration work.
No reliable total person-hours were tracked for this experiment.

The following is a new **low-confidence engineering estimate of remaining
focused work**, excluding this completed experiment and external waiting time:

| Remaining work | Estimate | Main uncertainty |
| --- | --- | --- |
| Phase 04 records tickets #46–#51 and combined acceptance | 10–16 h | Durable retries, managed-media cleanup, API/fixture parity |
| Phase 05 session authority and safety/recovery | 11–17 h | Concurrent actions, independent stop path, realtime invalidation |
| Phase 06 AI/input integration | 12–18 h | Small model on belongings, gesture consistency, PS4 mapping, combined RAM |
| Phase 07 device/firmware integration | 11–17 h | Selected endpoint/build details and measured freshness/expiry |
| Phase 08 qualification and release | 8–12 h | Five-object trials, simultaneous stability, offline packaging and notices |
| **Total remaining** | **52–80 h** | Reforecast again after durable records and the first simultaneous workload |

At 3–4 focused hours/day this is roughly **13–27 working days**, conditional
on device availability and successful qualification. It is not a calendar
deadline or a relaxation of success metrics. No speculative reuse-hour saving
has been subtracted. Keep physical assembly external; unavailable hardware only
blocks its dependent connection/measurements.
