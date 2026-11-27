# Changelog

## [3.1.0](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v3.0.0...agent-plugin-v3.1.0) (2026-11-27)


### Features

* **hooks:** start the gateway on session start ([5bc1966](https://github.com/ziptie-soft/local-decider/commit/5bc1966ed631e5ccb5269a8d7db07b6d6aaa2d9c))

## [3.0.0](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v2.1.1...agent-plugin-v3.0.0) (2026-11-22)


### ⚠ BREAKING CHANGES

* **hooks:** auto-allow PermissionRequest only for allowlisted shell and edit tools

### Features

* **hooks:** flag stuck or waiting subagents to the parent agent ([3d3ef5c](https://github.com/ziptie-soft/local-decider/commit/3d3ef5c608d0b4779b0178f1e7514db25ebf9ef4))
* **plugin:** add doctor and onboarding skills, command -v step and timeout note ([a57e552](https://github.com/ziptie-soft/local-decider/commit/a57e552af8268c02bf9a31255471db9425082f38))
* **plugin:** add explain and mark-unsafe skills ([aa03136](https://github.com/ziptie-soft/local-decider/commit/aa0313648230e202d771bba6c6d88dbff144ac97))


### Bug Fixes

* **gateway:** report whether a label was verified, and strip control characters from explain errors ([8408228](https://github.com/ziptie-soft/local-decider/commit/840822841cd9efff5d246088ef98998a2b9c2077))
* **hooks:** auto-allow PermissionRequest only for allowlisted shell and edit tools ([903997f](https://github.com/ziptie-soft/local-decider/commit/903997faeace80ee3acb45ac42897681bf70bb12))
* **plugin:** run the mise node shim from the plugin root and prefer Codex's PLUGIN_ROOT ([ce2ac78](https://github.com/ziptie-soft/local-decider/commit/ce2ac785d8c3a1d2e050e9ede80195b18510a1d6))

## [2.1.1](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v2.1.0...agent-plugin-v2.1.1) (2026-11-15)


### Bug Fixes

* **ci:** ignore lockfile changes confined to the Paseo plugin in the release-coupling check ([a534584](https://github.com/ziptie-soft/local-decider/commit/a5345849400e67a3114befa31956dc03d4ce89b5))

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v2.0.1...agent-plugin-v2.1.0) (2026-11-15)


### Features

* **hooks:** report approved Claude Code permission prompts as outcomes ([e528fe4](https://github.com/ziptie-soft/local-decider/commit/e528fe41647d05ae5f75beaf01990fd7a9b74d0b))
* **plugin:** add gateway userConfig, SessionStart health check and harness e2e ([97f5ce7](https://github.com/ziptie-soft/local-decider/commit/97f5ce7fb4f2b60a9fe0e869e344b3bfbc48d581))

## [2.0.1](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v2.0.0...agent-plugin-v2.0.1) (2026-11-14)


### Bug Fixes

* **plugin:** harden Codex decision hooks ([7ace527](https://github.com/ziptie-soft/local-decider/commit/7ace5275193afaef967e20ae30fc0989d9de8248))

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v1.0.2...agent-plugin-v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **core:** require allow-rule thresholds at or above a 0.8 floor
* **gateway:** require a control token on control routes
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin

### Features

* typed outcome labels and permission-row feedback ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Bug Fixes

* **core:** key-aware deep redaction and rule hardening ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** reject unusable engine answers ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** require allow-rule thresholds at or above a 0.8 floor ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** send the control token only to loopback and refuse redirects ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** drop dead queue waiters, reserve high-priority slots and release slots past the deadline ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** require a control token on control routes ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Performance Improvements

* **core:** memoise secret-key classification during redaction ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v1.0.1...agent-plugin-v1.0.2) (2026-11-12)


### Bug Fixes

* better hook naming ([#11](https://github.com/ziptie-soft/local-decider/issues/11)) ([cc8db88](https://github.com/ziptie-soft/local-decider/commit/cc8db88ecc28c9c7c7c7850f586ef42290b6ce56))

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/agent-plugin-v1.0.0...agent-plugin-v1.0.1) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))
