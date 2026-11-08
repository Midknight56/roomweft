# J33 furniture models

Completed 8 Nov 2026 in the assigned worktree.

All eight existing GLBs are listed in the manifest. Selection uses room object ids and whole title words. Lamps and tables can turn inside their wrapper before the unchanged box fit. Slot materials use the listing colour at roughness 0.8. Owned materials retain separate copies of their painted textures. Nominal items retain proxies and status outlines. Returned models retain opacity 0.3.

Changed files: `public/models/manifest.json`, `src/client/meshes.ts`, `src/client/scene.ts`, `src/client/verify.mjs`, `tests/unit/client-models.test.ts`, `docs/ASSETS.md`.

Validation: `npm.cmd run gate` exited 0. All 29 test files and 504 tests passed. The model test file has 35 tests, including 33 new cases. The page check served and loaded all eight real model kinds without a page error. Model boxes touched floor Y 0. Walk starts at [250, 160, 55], outside every furniture mesh box.

Pictures inspected: `out/page-check/review-models-overview.png`, `review-models-plan.png`, and `review-models-walk.png`. Overview shows the furnished room, owned textures and clay slot colours. Plan shows the reading chair facing west and the desk chair facing south. Walk shows the desk chair, desk, square table and lamp from the door area; the reading chair is behind the camera. No visible furniture floats or sinks. The red door conflict is intentional in the review fixture.

No packages added. No GLBs changed. No commit, push or deployment. No remaining J33 implementation work.
