# Local vision feasibility experiment

This recorded-image tool verifies the Phase 04 vision dependency combination.
It does not open a webcam, controller or serial port, or implement production
recognition, finger classification, session authority or motor control.

Run from the repository root in PowerShell. Preserve the existing Python 3.13
installation. `uv 0.11.32` installs Python 3.11.14 locally under the ignored
`.local-runtime/` directory; no global Python replacement is needed.

## Deliberate online setup

Inspect [NOTICES.md](NOTICES.md) before setup. The wheel cache needs several GB
on the project drive; CUDA libraries are included with the selected wheels.
No driver or standalone CUDA Toolkit installation is performed.

```powershell
./experiments/vision/setup.ps1
./experiments/vision/verify.ps1
```

The setup downloads all pinned wheels with required SHA-256 hashes, installs
from that local cache, checks declared dependencies, inventories installed
licenses/notices, then deliberately downloads the named model/task/images.
Asset bytes must match [assets.json](assets.json); changed upstream bytes fail
setup rather than silently changing the experiment. The model release is
`ultralytics/assets` v8.4.0; the task URL selects float16 version 1.

`requirements.lock` is the experiment's combined vision/backend/input lock,
not an implemented backend or release qualification. Reconcile later backend
dependency changes against it before Phase 04 acceptance. To regenerate it:

```powershell
uv pip compile experiments/vision/requirements.in --output-file experiments/vision/requirements.lock --python-version 3.11 --python-platform x86_64-pc-windows-msvc --index pytorch=https://download.pytorch.org/whl/cu124 --index-url https://pypi.org/simple --index-strategy unsafe-best-match --generate-hashes
```

Both MediaPipe and Ultralytics require an OpenCV provider under different
distribution names. This baseline pins both to 4.11.0.86 and reinstalls contrib
last with the same hashes in `opencv-contrib.lock`. `cv2.aruco` availability and
real MediaPipe/YOLOE processing check the resulting provider. Both wheels own
`cv2`; installing, upgrading or uninstalling either requires rerunning setup
and the probes. This is an explicit setup constraint, not general permission
to mix unrelated OpenCV builds.

## Offline rerun

After online setup, installation itself can also be repeated without indexes:

```powershell
./experiments/vision/setup.ps1 -Offline
$python = './.local-runtime/venv/Scripts/python.exe'
& $python -m experiments.vision.probe --assets .local-runtime/assets --output .local-runtime/results/gpu.json --device cuda:0 --repetitions 20 --condition 'Record current laptop load and frontend state here'
& $python -m experiments.vision.probe --assets .local-runtime/assets --output .local-runtime/results/cpu.json --device cpu --repetitions 5 --condition 'Record current laptop load and frontend state here'
```

Every probe disables Ultralytics automatic installation/online behavior and
installs a Python audit hook denying socket connections and DNS resolution
before importing the vision stack. It verifies explicit local asset hashes
before model loading and fails if networking is attempted. This enforces the
Python runtime boundary; it is not an OS firewall and does not establish that
arbitrary native libraries can never access the network. No machine-wide
network settings are changed. A missing/corrupt asset is a failed experiment,
never permission to download, substitute CPU or use cloud inference.

The CLI writes failures and partial measurements to its JSON output and exits
nonzero on failed required probes. Output is local and ignored by default;
reviewed measurements are retained under `evidence/`.

## What is measured

- Fresh OS/build, Python/SQLite, GPU/driver/VRAM, available RAM, free disk,
  package versions, actual model tensor device and CUDA execution.
- Each checkpoint's load plus device transfer, reference encoding plus first
  target inference, then synchronized FP32 end-to-end target-call latency.
  Import time and initialization are separate from warmed calls; OS file
  caches are not flushed. Memory sampling runs outside timed inference.
- One saved reference (`bus.jpg`, ROI xywh `50,390,190,510`) and a different
  recorded target (`zidane.jpg`). The reference region contains a person;
  target people are qualitative visual-similarity candidates. A recorded
  isolated-hands image is the distractor/negative scene. No text class prompt
  is supplied. These few upstream photographs do not qualify belongings or
  unique identity, recognition accuracy, or false-alert rates.
- The pinned `YOLOEVPSegPredictor` visual encoder is counted and its embedding
  hashed. Repeated target calls omit the prompt and must not re-encode it.
  Replacing reference bytes/ROI must change the embedding; a fresh model load
  must re-encode and restore the original embedding. Each checkpoint gets its
  own new model/context. These are experiment observations, not production
  session/generation isolation or worker-restart recovery.
- RAM and CUDA allocation/reservation samples, dedicated GPU memory before
  and after warmed calls, and reload behavior. CUDA allocation is distinct
  from total dedicated memory used by all desktop processes.
- A real MediaPipe Tasks HandLandmarker instance, explicit local task, CPU
  delegate, and processing of two hands with 21 landmarks each. The instance
  stays alive during YOLOE; it is not a concurrent webcam/gesture workload.
- FastAPI object construction, supporting imports, OpenCV contrib and SDL
  version access. No backend server, game controller or serial device is
  qualified by these checks. The available frontend can run concurrently;
  record that condition separately from unimplemented backend/camera/control.

## Coordinate contract

Images are EXIF-normalized before selecting source-pixel ROI coordinates.
`roi_xyxy` converts xywh to xyxy, clamps bounds, and rejects empty/nonfinite
boxes. The pinned visual-prompt predictor applies its own reference resize
and letterbox transform. `Results.boxes.xyxy` and `orig_shape` already describe
the original target image: the probe only validates/clamps these boxes.
Applying inverse letterboxing to them again is a coordinate error.

`unletterbox` is exclusively for raw model-input boxes using a recorded
per-axis gain/padding. Tests include independently worked wide-image padding,
stretched resize, orientation direction, image edges and invalid values. They
do not establish production frame identity or browser display correctness.
