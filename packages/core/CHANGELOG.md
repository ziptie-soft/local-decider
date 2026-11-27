# Changelog

## [3.2.0](https://github.com/ziptie-soft/local-decider/compare/core-v3.1.0...core-v3.2.0) (2026-11-27)


### Features

* **gateway:** route decisions to per-policy engine lanes ([27dc559](https://github.com/ziptie-soft/local-decider/commit/27dc55940fefa8d386ea09092b1bc0a7bdfdb7f2))
* **gateway:** serve the API on a Unix socket ([f4871ca](https://github.com/ziptie-soft/local-decider/commit/f4871caffefc6812b49b968647a20fac9887fced))
* **gateway:** set and report a model per decision over HTTP ([714c625](https://github.com/ziptie-soft/local-decider/commit/714c62557fb7ff2b147b5da2a449b78a1bf0ac76))


### Bug Fixes

* send real client versions to the gateway ([7ca14e1](https://github.com/ziptie-soft/local-decider/commit/7ca14e145b692e33d71435f087c76199a2a68703))

## [3.1.0](https://github.com/ziptie-soft/local-decider/compare/core-v3.0.0...core-v3.1.0) (2026-11-25)


### Features

* **core:** add pi harness ([c3c1527](https://github.com/ziptie-soft/local-decider/commit/c3c1527bffda70b6638c2437ddbdbc287a413e7c))

## [3.0.0](https://github.com/ziptie-soft/local-decider/compare/core-v2.2.0...core-v3.0.0) (2026-11-22)


### ⚠ BREAKING CHANGES

* **policies:** auto-allow permission at p(allow) >= 0.85, abstain by default in routing-budget, retune thresholds
* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions
* **gateway:** batch SQLite appends off the request path, chunk pruning, skip unreadable rows and back up before migrations
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats
* **hooks:** guard oversized hook input, close shell-splitter bypasses and gate Paseo auto-allow deterministically
* **core:** neutralise headings in state bodies, rename keep middle to ends and downgrade allow to ask when a critical section is cut
* **gateway:** keep hook-enforced policies out of MCP decide, trim the policies tool and keep MCP and CLI probes out of stats
* **hooks:** auto-allow PermissionRequest only for allowlisted shell and edit tools

### Features

* **core:** neutralise headings in state bodies, rename keep middle to ends and downgrade allow to ask when a critical section is cut ([0f71cf8](https://github.com/ziptie-soft/local-decider/commit/0f71cf8638ddcae82bfcc18a28fce856f1414579))
* **gateway:** derive call facts from the redacted input behind a reserved facts key, shipped empty ([64f3978](https://github.com/ziptie-soft/local-decider/commit/64f39785f942dc709157df2a8c95369fdc77ad8d))
* **gateway:** keep hook-enforced policies out of MCP decide, trim the policies tool and keep MCP and CLI probes out of stats ([947cff9](https://github.com/ziptie-soft/local-decider/commit/947cff994a1c7d7d19afc26487e7ab586038f09e))
* **gateway:** record the matched rule, precedent tally, redaction counts and tool per decision ([0c7da36](https://github.com/ziptie-soft/local-decider/commit/0c7da36db6e7a3e467042fb367b5bfd74eacf1c6))
* **gateway:** scale queue slots with engine concurrency and refuse requests whose budgetMs the queue cannot meet ([8a4139c](https://github.com/ziptie-soft/local-decider/commit/8a4139cfe58a539bb852aa6a268ff584b87deae5))
* **gateway:** ship the kind fact for command-risk, drop the other groups after the Q3 A/B ([f8ac05d](https://github.com/ziptie-soft/local-decider/commit/f8ac05d9a41f162689d1f49c6541e4b891a08832))
* **gateway:** strands-decider 0.4.0 with a ROCm install flavour, maxConcurrency and upstream attribution ([6a938e4](https://github.com/ziptie-soft/local-decider/commit/6a938e48e19c71b287f5ccc9a7ffff9a88a731da))
* **hooks:** flag stuck or waiting subagents to the parent agent ([3d3ef5c](https://github.com/ziptie-soft/local-decider/commit/3d3ef5c608d0b4779b0178f1e7514db25ebf9ef4))
* **policies:** auto-allow permission at p(allow) &gt;= 0.85, abstain by default in routing-budget, retune thresholds ([9ab2d5a](https://github.com/ziptie-soft/local-decider/commit/9ab2d5a4dfb9770f9c777eedbc7f8962d2df9fb9))


### Bug Fixes

* **core:** default to 3 chars per token and cover truncation markers, clamping and code points with tests ([7e901b1](https://github.com/ziptie-soft/local-decider/commit/7e901b180e77cfe9b3fade5f3a6936acec7f1743))
* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions ([9bda32d](https://github.com/ziptie-soft/local-decider/commit/9bda32d5acfe01cf8b7a068c4617a7e7f45cea8f))
* **core:** replace lone surrogates in call-fact tokens ([8f3f88b](https://github.com/ziptie-soft/local-decider/commit/8f3f88bcc5506cfd4ae2bf68466b3ef5810f63fc))
* **gateway:** drop the guard-rule note from call facts ([a810a98](https://github.com/ziptie-soft/local-decider/commit/a810a981da13d3fc4e4f559a236bf50cca6c6553))
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats ([ada02e6](https://github.com/ziptie-soft/local-decider/commit/ada02e6a7e4d48ff7e94bb2623bebb3655fafd23))
* **gateway:** scope the decision cache to engine and model, tag the cache key, make canonicalJson total and evict LRU ([e63d75a](https://github.com/ziptie-soft/local-decider/commit/e63d75a22eacf039fd8cbef254e239b9622dce6b))
* **hooks:** auto-allow PermissionRequest only for allowlisted shell and edit tools ([903997f](https://github.com/ziptie-soft/local-decider/commit/903997faeace80ee3acb45ac42897681bf70bb12))
* **hooks:** cap hook inputs so padded payloads stay within the gateway limit, and make the command guard linear ([a580e06](https://github.com/ziptie-soft/local-decider/commit/a580e0610d5731d84e2c579eee6333293946a661))
* **hooks:** guard oversized hook input, close shell-splitter bypasses and gate Paseo auto-allow deterministically ([4a7bc10](https://github.com/ziptie-soft/local-decider/commit/4a7bc1072bfd2b213da84407897e721d2504dd6e))


### Performance Improvements

* **gateway:** batch SQLite appends off the request path, chunk pruning, skip unreadable rows and back up before migrations ([75e2e69](https://github.com/ziptie-soft/local-decider/commit/75e2e696b29aeec1f5aa3ef9490d10592be22134))

## [2.2.0](https://github.com/ziptie-soft/local-decider/compare/core-v2.1.1...core-v2.2.0) (2026-11-15)


### Features

* **plugin:** add gateway userConfig, SessionStart health check and harness e2e ([97f5ce7](https://github.com/ziptie-soft/local-decider/commit/97f5ce7fb4f2b60a9fe0e869e344b3bfbc48d581))

## [2.1.1](https://github.com/ziptie-soft/local-decider/compare/core-v2.1.0...core-v2.1.1) (2026-11-14)


### Bug Fixes

* **plugin:** harden Codex decision hooks ([7ace527](https://github.com/ziptie-soft/local-decider/commit/7ace5275193afaef967e20ae30fc0989d9de8248))

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/core-v2.0.0...core-v2.1.0) (2026-11-14)


### Features

* **precedent:** add cross-harness v2 keys ([95f8a1b](https://github.com/ziptie-soft/local-decider/commit/95f8a1b89e83622cf2b2396fc0eb517ea69aaf8b))
* **precedent:** add veto-only unverified outcomes ([a45585c](https://github.com/ziptie-soft/local-decider/commit/a45585c38d37786bc8d59171409d4d85ac4f808d))

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/core-v1.1.0...core-v2.0.0) (2026-11-12)


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

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/core-v1.0.2...core-v1.1.0) (2026-11-12)


### Features

* sqlite store ([#15](https://github.com/ziptie-soft/local-decider/issues/15)) ([fd1499e](https://github.com/ziptie-soft/local-decider/commit/fd1499e700e6f0bc807a3838c9fd2d599f349e5c))

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/core-v1.0.1...core-v1.0.2) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/core-v1.0.0...core-v1.0.1) (2026-11-11)


### Bug Fixes

* security ([7184c24](https://github.com/ziptie-soft/local-decider/commit/7184c2446874efba7b567573c0bb5368acb54a72))
