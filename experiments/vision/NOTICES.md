# Sources, licenses and redistribution

Inspected on 2026-11-17 before using the local experiment assets. This PR ships
probe source, hashes, metadata and license notices; it does not redistribute
the model binaries, upstream photographs, Python wheels or a packaged product.

| Source | Inspected revision | Terms / retained notices |
| --- | --- | --- |
| [Ultralytics runtime](https://github.com/ultralytics/ultralytics/tree/b10fa7be231820cea668c52af45b25d07ff65968) | v8.4.23, commit `b10fa7be231820cea668c52af45b25d07ff65968` | AGPL-3.0; full upstream [license](notices/Ultralytics-AGPL-3.0.txt) retained. |
| [YOLOE model release](https://github.com/ultralytics/assets/releases/tag/v8.4.0) | `yoloe-26n-seg.pt`, `yoloe-26s-seg.pt`; exact content hashes in assets.json | Ultralytics' AGPL model terms apply; research availability is not a permissive redistribution license. |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe/tree/8317ba78778738ba90a521e7e4580a2ba0129c81) | v0.10.32, commit `8317ba78778738ba90a521e7e4580a2ba0129c81` | Apache-2.0; full upstream [license](notices/MediaPipe-Apache-2.0.txt) retained. |
| [Hand Tracking model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf) | October 2021 card; float16 task bundle version 1, exact SHA-256 in assets.json | Card page 2 explicitly states Apache License 2.0. Preserve notices and attribution on redistribution. |
| [PyTorch 2.6.0](https://github.com/pytorch/pytorch/tree/v2.6.0), [torchvision 0.21.0](https://github.com/pytorch/vision/tree/v0.21.0) | Windows CPython 3.11 CUDA 12.4 wheels, hashes in requirements.lock | BSD family upstream licenses; bundled CUDA/cuDNN and third-party notices also apply. Do not treat all bundled binaries as BSD-only. |
| OpenCV / opencv-contrib 4.11.0.86 | Exact wheels in requirements.lock | Apache-2.0 plus bundled third-party notices; retain the wheel license inventory. |
| [cv2-enumerate-cameras](https://github.com/lukehugh/cv2_enumerate_cameras/tree/7eaa2290424b87d0e4f40dfe8395019ee7b3293c) | 1.4.0, Windows x64 abi3 wheel pinned by SHA-256 | MIT. Retain the installed wheel's license and any bundled notices. |
| FastAPI / Uvicorn | 0.163.2 / 0.41.0 | MIT / BSD family; package metadata and license files inventoried. |
| Pygame / SDL | Pygame 2.6.1; actual SDL version in evidence | Pygame LGPL; SDL and included libraries have their own notices. Preserve library replacement/source obligations when packaging. |
| pySerial | 3.5 | BSD family; retained installed license metadata. |
| NumPy, Pillow and transitive dependencies | requirements.lock and installed package inventory | Each distribution's own terms apply; do not infer one umbrella license. |

For AGPL-covered distribution, preserve notices/license, provide corresponding
source and applicable installation information under its terms, and meet the
network-interaction source-offer obligations where applicable. Any incompatible
closed distribution needs an appropriate separate Ultralytics license. No such
license or final release compliance is claimed here. Apache distribution must
preserve applicable license/NOTICE files, attribution and modification notices;
BSD/MIT dependencies retain their copyright/license notices. Release packaging
must include the exact wheel notices and CUDA/SDL third-party terms as well.

`package_inventory.py` inventories **every installed distribution** and copies
its installed license/NOTICE files, with SHA-256, to the ignored local
`.local-runtime/package-notices/`. Retained metadata is linked from the measured
evidence. A metadata field is not a substitute for reading the included terms
before redistributing that dependency. Release-wide legal compatibility remains
part of packaging; this experiment establishes the inspected local-use baseline.

`bus.jpg` and `zidane.jpg` come from the pinned Ultralytics sample tree;
`right_hands.jpg` comes from the official MediaPipe test-assets bucket. Their
URLs, sizes and exact hashes are retained. These are local upstream examples,
not our images or a redistributable product dataset. No independent photograph
license grant was established for redistribution; the images are deliberately
excluded from the repository and release assets. Obtain suitable licensed
belonging/room photographs for the later five-object assessment.

The unlicensed gesture/serial repositories identified in TRD section 2.1 were
not copied. No THU-MIG runtime, hosted model service, demo ROI editor, training
code or gesture classifier is incorporated.
