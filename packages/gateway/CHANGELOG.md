# Changelog

## [3.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v3.0.0...local-decider-v3.1.0) (2026-11-23)


### Features

* **gateway:** remove downloaded models from the Paseo engine settings ([1fce992](https://github.com/ziptie-soft/local-decider/commit/1fce9927dc29042cd4f75d67482f953d8fe38f04))


### Bug Fixes

* **gateway:** tag ROCm torch as ROCm and simplify engine labels and descriptions ([2959d17](https://github.com/ziptie-soft/local-decider/commit/2959d17b21a2a9f2910d7ac77731a5f347558d88))

## [3.0.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.2.0...local-decider-v3.0.0) (2026-11-22)


### ⚠ BREAKING CHANGES

* **gateway:** the MCP decide tool returns {decisionId, policy, action, enforced, primary, failedOpen, truncated} instead of the full decision (probabilities, rule, engine, model, precedent key).
* **policies:** auto-allow permission at p(allow) >= 0.85, abstain by default in routing-budget, retune thresholds
* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions
* **gateway:** batch SQLite appends off the request path, chunk pruning, skip unreadable rows and back up before migrations
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats
* **core:** neutralise headings in state bodies, rename keep middle to ends and downgrade allow to ask when a critical section is cut
* **gateway:** keep hook-enforced policies out of MCP decide, trim the policies tool and keep MCP and CLI probes out of stats
* **gateway:** engine children get an allowlisted environment, reserved serve flags are rejected and children die with the gateway

### Features

* **core:** neutralise headings in state bodies, rename keep middle to ends and downgrade allow to ask when a critical section is cut ([0f71cf8](https://github.com/ziptie-soft/local-decider/commit/0f71cf8638ddcae82bfcc18a28fce856f1414579))
* **gateway:** add GET /v1/review behind the control token ([99bc77d](https://github.com/ziptie-soft/local-decider/commit/99bc77d701dcfbe306a01f236743b641c9066add))
* **gateway:** add local-decider explain ([b8a1e97](https://github.com/ziptie-soft/local-decider/commit/b8a1e972a93669e35b4e2de27c82400654e8a25c))
* **gateway:** add local-decider label for verified unsafe labels ([6651fa6](https://github.com/ziptie-soft/local-decider/commit/6651fa61877ced7dc2d0fd6c5a949643e1eac65f))
* **gateway:** add local-decider review ([52c008f](https://github.com/ziptie-soft/local-decider/commit/52c008f23b749cfe48af1c07654a45766b4ff740))
* **gateway:** add per-policy eval fixtures, a strict eval mode and replay/record eval tooling ([bd88960](https://github.com/ziptie-soft/local-decider/commit/bd889602ef5295034fc79d4f2f3bec4b7e72a10c))
* **gateway:** add the strands-decider E2B v2 checkpoint, keep v2 off MLX and treat engine 503 as busy ([5356b42](https://github.com/ziptie-soft/local-decider/commit/5356b4206427b3cc9fb8b514644858bf24b8047c))
* **gateway:** agent view for decide and policies, refuse and shadow-cap mcp callers ([901a06e](https://github.com/ziptie-soft/local-decider/commit/901a06e14b2117e02caf2b1fb49ec98765ce0173))
* **gateway:** derive call facts from the redacted input behind a reserved facts key, shipped empty ([64f3978](https://github.com/ziptie-soft/local-decider/commit/64f39785f942dc709157df2a8c95369fdc77ad8d))
* **gateway:** expose health counters and error latency, return a generic 502 body and redact engine log lines ([9fb7aea](https://github.com/ziptie-soft/local-decider/commit/9fb7aea3c86e5f567ad859c47b89291211644a3d))
* **gateway:** keep hook-enforced policies out of MCP decide, trim the policies tool and keep MCP and CLI probes out of stats ([947cff9](https://github.com/ziptie-soft/local-decider/commit/947cff994a1c7d7d19afc26487e7ab586038f09e))
* **gateway:** pin strands-decider Hugging Face weights to commit revisions and serve the pinned snapshot ([b77dfbe](https://github.com/ziptie-soft/local-decider/commit/b77dfbeaaf2950ebb94e68dd31a5fb908cac7efb))
* **gateway:** record the matched rule, precedent tally, redaction counts and tool per decision ([0c7da36](https://github.com/ziptie-soft/local-decider/commit/0c7da36db6e7a3e467042fb367b5bfd74eacf1c6))
* **gateway:** report a Strands venv that does not match the pinned version ([fd34045](https://github.com/ziptie-soft/local-decider/commit/fd3404578a97a1ce49ab18eb82da4df1a98769c3))
* **gateway:** scale queue slots with engine concurrency and refuse requests whose budgetMs the queue cannot meet ([8a4139c](https://github.com/ziptie-soft/local-decider/commit/8a4139cfe58a539bb852aa6a268ff584b87deae5))
* **gateway:** serve decision explanations behind the control token ([987a80c](https://github.com/ziptie-soft/local-decider/commit/987a80c7a234434cb5997859c6231178fd272d28))
* **gateway:** ship the kind fact for command-risk, drop the other groups after the Q3 A/B ([f8ac05d](https://github.com/ziptie-soft/local-decider/commit/f8ac05d9a41f162689d1f49c6541e4b891a08832))
* **gateway:** strands-decider 0.4.0 with a ROCm install flavour, maxConcurrency and upstream attribution ([6a938e4](https://github.com/ziptie-soft/local-decider/commit/6a938e48e19c71b287f5ccc9a7ffff9a88a731da))
* **policies:** auto-allow permission at p(allow) &gt;= 0.85, abstain by default in routing-budget, retune thresholds ([9ab2d5a](https://github.com/ziptie-soft/local-decider/commit/9ab2d5a4dfb9770f9c777eedbc7f8962d2df9fb9))


### Bug Fixes

* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions ([9bda32d](https://github.com/ziptie-soft/local-decider/commit/9bda32d5acfe01cf8b7a068c4617a7e7f45cea8f))
* **gateway:** abort before the body read, drain in-flight work before unload or switch, and coalesce identical requests ([0b2cc28](https://github.com/ziptie-soft/local-decider/commit/0b2cc28851e4fec5cad88853472cfecfe6e1e1cd))
* **gateway:** accept MCP protocol 2026-07-28 requests ([bc68423](https://github.com/ziptie-soft/local-decider/commit/bc68423d409cb6b92677f272a8371535d1c83fd2))
* **gateway:** admit pass-through routes through the engine queue at low priority and report their engine failures ([bb9ef4b](https://github.com/ziptie-soft/local-decider/commit/bb9ef4bf730bf2aa70df5ecdea332299e23eefd9))
* **gateway:** correct MCP decide annotations and confidence wording and list policy input keys ([cf965a2](https://github.com/ziptie-soft/local-decider/commit/cf965a2917e91bfa869d19c310a80185a7a7bef4))
* **gateway:** count vetoes in calibration, exclude precedent rules from the floor and let verified outcomes win in stats ([8230818](https://github.com/ziptie-soft/local-decider/commit/8230818fbc67915bdbd205a7a17a6be0cd909f1b))
* **gateway:** do not count caller aborts of decisions as engine failures ([d9c747e](https://github.com/ziptie-soft/local-decider/commit/d9c747e850ebd7a9a94736f9b38973059cc045a6))
* **gateway:** engine children get an allowlisted environment, reserved serve flags are rejected and children die with the gateway ([a7c8802](https://github.com/ziptie-soft/local-decider/commit/a7c88025afa138471e4213120e7533f3c6f7fa02))
* **gateway:** floor calibration probabilities at the wire rounding ([44f48da](https://github.com/ziptie-soft/local-decider/commit/44f48da7c1fdbfc7d16642274c954fa1d8114920))
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats ([ada02e6](https://github.com/ziptie-soft/local-decider/commit/ada02e6a7e4d48ff7e94bb2623bebb3655fafd23))
* **gateway:** kill failed engine children, serialise restarts, probe hung engines and retry remote errors ([300f0db](https://github.com/ziptie-soft/local-decider/commit/300f0db75a7e934a4c0d2f1dc17fa0ee2cfffdad))
* **gateway:** parse strands pins with extras or spaces and accept local versions ([ee19b45](https://github.com/ziptie-soft/local-decider/commit/ee19b45c05fb0753aa4329814b20f7baa57b99b5))
* **gateway:** pick the strands-decider install flavor from the hardware when the config is explicit ([1afba5d](https://github.com/ziptie-soft/local-decider/commit/1afba5d5eb1b30fe251eb832007b552b14473312))
* **gateway:** reconcile the configured device when engine install picks a flavor ([b2a93a0](https://github.com/ziptie-soft/local-decider/commit/b2a93a0f76b812b6767d6cf48ec6ae57c7694b66))
* **gateway:** report stale service ExecStart, name flm and policy fetch errors, exit 2 on bad --input ([bedeb27](https://github.com/ziptie-soft/local-decider/commit/bedeb271a5c8baaf539ca7bef3be9e4a9aaca323))
* **gateway:** report whether a label was verified, and strip control characters from explain errors ([8408228](https://github.com/ziptie-soft/local-decider/commit/840822841cd9efff5d246088ef98998a2b9c2077))
* **gateway:** scope the decision cache to engine and model, tag the cache key, make canonicalJson total and evict LRU ([e63d75a](https://github.com/ziptie-soft/local-decider/commit/e63d75a22eacf039fd8cbef254e239b9622dce6b))
* **gateway:** set server timeouts, bound shutdown, detect recycled lock pids, contain listener throws and regenerate an empty report token ([d83699b](https://github.com/ziptie-soft/local-decider/commit/d83699bd4416000b96912c07ce9259314be23ea5))
* **gateway:** stamp the Strands runtime without requiring torch ([5e57709](https://github.com/ziptie-soft/local-decider/commit/5e577098710dceeb7fcd8233bee11ba89d8af4ab))
* **gateway:** switch a cpu strands device to the GPU when a cuda or rocm flavor is installed ([880be54](https://github.com/ziptie-soft/local-decider/commit/880be5404bd1a0bd0c9c179d914dc1acd791abb3))
* **gateway:** warn when the installed torch cannot serve the configured strands device ([e4327b1](https://github.com/ziptie-soft/local-decider/commit/e4327b1d0589f2535516f503b969d10e08e260ca))


### Performance Improvements

* **gateway:** batch SQLite appends off the request path, chunk pruning, skip unreadable rows and back up before migrations ([75e2e69](https://github.com/ziptie-soft/local-decider/commit/75e2e696b29aeec1f5aa3ef9490d10592be22134))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 3.0.0

## [2.2.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.1.3...local-decider-v2.2.0) (2026-11-15)


### Features

* **engines:** explain how to get an LM Studio API token ([6bb4c88](https://github.com/ziptie-soft/local-decider/commit/6bb4c88d4684be96e20a68a2086c329eea8641e3))
* **engines:** fall back to LM_API_TOKEN for lmstudio when tokenEnv is unset ([059fc47](https://github.com/ziptie-soft/local-decider/commit/059fc47c299a0069c6fbdcbbc29e6fb34129d6c2))

## [2.1.3](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.1.2...local-decider-v2.1.3) (2026-11-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.2.0

## [2.1.2](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.1.1...local-decider-v2.1.2) (2026-11-15)


### Bug Fixes

* **gateway:** restrict llama-server CORS and read its build from stderr ([4c1932f](https://github.com/ziptie-soft/local-decider/commit/4c1932f7f7231cae4e7e254a726b4560f44a7b03))

## [2.1.1](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.1.0...local-decider-v2.1.1) (2026-11-14)


### Bug Fixes

* **plugin:** harden Codex decision hooks ([7ace527](https://github.com/ziptie-soft/local-decider/commit/7ace5275193afaef967e20ae30fc0989d9de8248))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.1

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v2.0.0...local-decider-v2.1.0) (2026-11-14)


### Features

* **cli:** add report-only calibration command ([f13ed87](https://github.com/ziptie-soft/local-decider/commit/f13ed8754d31307f20b9eaa9443ffd2adb4aff7e))
* **gateway:** add bench CLI argument and output helpers ([c8d9e20](https://github.com/ziptie-soft/local-decider/commit/c8d9e20b79cf457fba5e8ab71f060dc9ee7f362f))
* **gateway:** add benchmark lease basics ([80fce43](https://github.com/ziptie-soft/local-decider/commit/80fce4315066ed5ae09898af8e3d9c5f8fad679f))
* **gateway:** add reusable benchmark calls ([7ff798e](https://github.com/ziptie-soft/local-decider/commit/7ff798e1df1612bf98d21d644e1683c4482e2f90))
* **gateway:** add verified model families ([7bb2e3d](https://github.com/ziptie-soft/local-decider/commit/7bb2e3dd9903db75163f0c9abddb0b7b010aadc5))
* **gateway:** expose benchmark status ([199b341](https://github.com/ziptie-soft/local-decider/commit/199b341370c4cc7813c73d16b81a012a1e6ce192))
* **gateway:** expose the benchmark host from engine control ([4945af9](https://github.com/ziptie-soft/local-decider/commit/4945af9bf9e6863adfa1c03d57caf3314ae08886))
* **gateway:** fingerprint benchmark runtimes ([53acdbd](https://github.com/ziptie-soft/local-decider/commit/53acdbd0ef4a2623de1c088eabaabfc44f71ebb3))
* **gateway:** hold decisions during benchmarks ([9fa81ff](https://github.com/ziptie-soft/local-decider/commit/9fa81ff8deb50b6d3bb523a2d2023004e6b67a82))
* **gateway:** keep benchmark engines out of fallback accounting ([6058601](https://github.com/ziptie-soft/local-decider/commit/605860139aabf92c18e56e1a891ccbd05632f08c))
* **gateway:** let a user selection preempt a benchmark ([224ccc7](https://github.com/ziptie-soft/local-decider/commit/224ccc77b54759aec89a21d6cba1bdfd6950652b))
* **gateway:** parse benchmark requests and resolve targets ([bb50a14](https://github.com/ziptie-soft/local-decider/commit/bb50a1478bc82d7f62b34075b928d8116e52ae29))
* **gateway:** persist benchmark records ([b1d16c1](https://github.com/ziptie-soft/local-decider/commit/b1d16c1095fb347663b4f41d25283d4747e6d60b))
* **gateway:** persist preferred family in auto mode ([6953bed](https://github.com/ziptie-soft/local-decider/commit/6953bed9b0704a58837dd8dd19bc399000557790))
* **gateway:** persist preferred model family ([0a329bb](https://github.com/ziptie-soft/local-decider/commit/0a329bbf4167f317a26298622b9823082505510e))
* **gateway:** rank measured model runtimes ([86a11dd](https://github.com/ziptie-soft/local-decider/commit/86a11ddcb7256c9f59ef9a5ad6e5a3951c4727b5))
* **gateway:** refuse engine changes during a benchmark ([38f4a6b](https://github.com/ziptie-soft/local-decider/commit/38f4a6b2a8bf403273d86a27b1c77df0d7ad5d85))
* **gateway:** run benchmark jobs ([fffc650](https://github.com/ziptie-soft/local-decider/commit/fffc65077444a0af891bac713020ddfed1251350))
* **gateway:** run benchmark jobs from engine control ([35c806d](https://github.com/ziptie-soft/local-decider/commit/35c806dfb76b153009d04d8fa1b8f5366a0b49e8))
* **gateway:** run benchmarks from the bench command ([d223712](https://github.com/ziptie-soft/local-decider/commit/d22371241d5d96b8d3b7a7ad48e1fc5a921be183))
* **gateway:** select runtimes within model families ([cae8e7e](https://github.com/ziptie-soft/local-decider/commit/cae8e7eca29ffb0f55d1aa0861ff3d10503a760f))
* **gateway:** serve benchmark routes ([c4766c0](https://github.com/ziptie-soft/local-decider/commit/c4766c0a40b8576e1891104b44475ad435215475))
* **precedent:** add cross-harness v2 keys ([95f8a1b](https://github.com/ziptie-soft/local-decider/commit/95f8a1b89e83622cf2b2396fc0eb517ea69aaf8b))
* **precedent:** add veto-only unverified outcomes ([a45585c](https://github.com/ziptie-soft/local-decider/commit/a45585c38d37786bc8d59171409d4d85ac4f808d))


### Bug Fixes

* **gateway:** cap the benchmark store read on one descriptor ([f59a2fb](https://github.com/ziptie-soft/local-decider/commit/f59a2fb7354a1b53d025a21720148114402684aa))
* **gateway:** persist, restore and store benchmark results reliably ([f51cb67](https://github.com/ziptie-soft/local-decider/commit/f51cb67609b5375f222276f0a95aa66ba3f0d140))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.0

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.1.0...local-decider-v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **core:** require allow-rule thresholds at or above a 0.8 floor
* **gateway:** require a control token on control routes
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin

### Features

* **gateway:** add llama.cpp Vulkan engine ([5f8a07e](https://github.com/ziptie-soft/local-decider/commit/5f8a07e199baa0df33b1ea1f412f6b58deacbdbd))
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


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.0.0

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.2...local-decider-v1.1.0) (2026-11-12)


### Features

* prioritize system installed engines ([#13](https://github.com/ziptie-soft/local-decider/issues/13)) ([2e707a6](https://github.com/ziptie-soft/local-decider/commit/2e707a6906c9f3d29054a80a65f1ff73ecb4074a))
* sqlite store ([#15](https://github.com/ziptie-soft/local-decider/issues/15)) ([fd1499e](https://github.com/ziptie-soft/local-decider/commit/fd1499e700e6f0bc807a3838c9fd2d599f349e5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.1...local-decider-v1.0.2) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.2

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/local-decider-v1.0.0...local-decider-v1.0.1) (2026-11-11)


### Bug Fixes

* security ([7184c24](https://github.com/ziptie-soft/local-decider/commit/7184c2446874efba7b567573c0bb5368acb54a72))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.1
