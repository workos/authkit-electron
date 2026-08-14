# Changelog

## [0.1.1](https://github.com/workos/authkit-electron/compare/v0.1.0...v0.1.1) (2026-08-14)


### Bug Fixes

* refuse to claim http(s) as a deep-link protocol ([#11](https://github.com/workos/authkit-electron/issues/11)) ([e73bde0](https://github.com/workos/authkit-electron/commit/e73bde05f479c6bc526ba6c10339a20dd73797ce))

## 0.1.0 (2026-08-11)


### Features

* add types-only /globals subpath export for non-React renderers ([8c3d00c](https://github.com/workos/authkit-electron/commit/8c3d00c01018d22259b3187dc9a068a4556b8023))
* ceremony, deep-link & IPC (Phase 2) ([3f78373](https://github.com/workos/authkit-electron/commit/3f78373e74366151a885033b3f027ab2e13f3c85))
* core session engine (Phase 1) ([ce5589a](https://github.com/workos/authkit-electron/commit/ce5589afadd6f6ad58fbc04749155473612016bc))
* example app + automated e2e (Phase 5) ([e66d16b](https://github.com/workos/authkit-electron/commit/e66d16b9c5405f3bb720d67845d2511df8d0badc))
* in-app window ceremony mode (Phase 4) ([101ea0e](https://github.com/workos/authkit-electron/commit/101ea0e0e6fff16556c7f1ea6ace9a919b480c61))
* React renderer bindings (Phase 3) ([bc60ba1](https://github.com/workos/authkit-electron/commit/bc60ba18deb6c17a886cedd9238845abdd617060))
* surface sign-in failures + add release-please automation ([#1](https://github.com/workos/authkit-electron/issues/1)) ([06f042b](https://github.com/workos/authkit-electron/commit/06f042b5484cd8785b8138d5cd7ca89df15ecfaa))


### Bug Fixes

* defer keychain read so createAuthKit() runs before app.whenReady() ([d9f82de](https://github.com/workos/authkit-electron/commit/d9f82de365773576c34720f702c00857f27b6c67))
* **example:** honor MAIN_VITE_AUTHKIT_CEREMONY from .env for ceremony mode ([a5b8811](https://github.com/workos/authkit-electron/commit/a5b88117ea11ea906b7e8715237d5118a94ff5f0))
* validate clientId at construction and end hosted session on signOut ([53642f0](https://github.com/workos/authkit-electron/commit/53642f093edac00f6d33859af4c5c881c2adff9b))
