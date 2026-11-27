# Changelog

## [3.2.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v3.1.1...paseo-plugin-v3.2.0) (2026-11-27)


### Features

* **launcher:** add hardened gateway launcher ([232e6a0](https://github.com/ziptie-soft/local-decider/commit/232e6a0e57e265dfb30a145120bb2c9219095bff))
* **launcher:** use the gateway socket from clients ([e7bd395](https://github.com/ziptie-soft/local-decider/commit/e7bd3953a673b1b90a953ff911494167b2e2a972))
* link per-client setup guides when the gateway is missing ([a453b14](https://github.com/ziptie-soft/local-decider/commit/a453b1481a272b855048111a4f227e26ec1ae9e0))
* **paseo-plugin:** add a Custom… idle time with a minutes field ([5809d08](https://github.com/ziptie-soft/local-decider/commit/5809d089605c3ec550a540d8e69b1d51a10a2de7))
* **paseo-plugin:** add the gateway decision kinds and their mode copy ([2d5ee2b](https://github.com/ziptie-soft/local-decider/commit/2d5ee2b71d9656010a6f94ac76bc7ce4d99d0c1d))
* **paseo-plugin:** add the per-decision model helpers ([b23c30d](https://github.com/ziptie-soft/local-decider/commit/b23c30d6ea9d37df5a34f45bc4cf7c4822355dd9))
* **paseo-plugin:** cancel a stuck load, retry a failed one and clamp idle minutes ([308e3be](https://github.com/ziptie-soft/local-decider/commit/308e3bed07b0c110d36e9c05db22de3267b2fe4b))
* **paseo-plugin:** caption the chips when the decisions table stacks ([4105674](https://github.com/ziptie-soft/local-decider/commit/41056740e7960d5ec7ca795547ae055a3c49d586))
* **paseo-plugin:** choose a model for each decision ([ea3c5e9](https://github.com/ziptie-soft/local-decider/commit/ea3c5e990909d831b8e553a81ebf3fff233b0586))
* **paseo-plugin:** compact the status card into three rows ([f3d56ca](https://github.com/ziptie-soft/local-decider/commit/f3d56ca14bd106da54578c3dcfffed32187d1add))
* **paseo-plugin:** fold presets for routes outside the policy into a disclosure ([e88af97](https://github.com/ziptie-soft/local-decider/commit/e88af9764040962521fbc19b5d15de58904cdd27))
* **paseo-plugin:** keep decision chips together and drop stale success lines ([e3f908f](https://github.com/ziptie-soft/local-decider/commit/e3f908f11ded738374c032e7087045e31f314181))
* **paseo-plugin:** launch gateway from server ([08095e2](https://github.com/ziptie-soft/local-decider/commit/08095e2a15a4e6de17bea73285ff7f0e6289de93))
* **paseo-plugin:** name the default model state like Status in the Models card ([81a24cd](https://github.com/ziptie-soft/local-decider/commit/81a24cdec6c40c2e95a8d2eb95ff2f492498b59c))
* **paseo-plugin:** read and set the model per decision ([ab7dae6](https://github.com/ziptie-soft/local-decider/commit/ab7dae6f0848cde7b790704f7d1f313b1bc2bab8))
* **paseo-plugin:** rename Engine and model to Models and label speed figures ([84e744d](https://github.com/ziptie-soft/local-decider/commit/84e744d818bc6547cd878efc23c9fe66805fc648))
* **paseo-plugin:** show decisions as one table with mode and model pickers ([2f7ab1b](https://github.com/ziptie-soft/local-decider/commit/2f7ab1b77a3f7809806ccf6cae842d4e2acb1ae1))
* **paseo-plugin:** show each decision's own model in quick status ([b4acfa5](https://github.com/ziptie-soft/local-decider/commit/b4acfa5b79a2725c53d1ba7c41984c938d34f07a))
* **paseo-plugin:** show the auto-start outcome and install guide while the gateway is unreachable ([bd33a18](https://github.com/ziptie-soft/local-decider/commit/bd33a1858076d6ee6dc84cdf7545264cd821013c))
* **paseo-plugin:** show the default model above the decisions ([1bd573a](https://github.com/ziptie-soft/local-decider/commit/1bd573a5897f11b0a2905832e89113aa3728046b))
* **paseo-plugin:** show which model answered a decision ([90446c5](https://github.com/ziptie-soft/local-decider/commit/90446c51b64d6380ad3438c9bc07c10f2788bc6b))


### Bug Fixes

* **paseo-plugin:** align the preset columns by reserving the remove slot ([8e75c19](https://github.com/ziptie-soft/local-decider/commit/8e75c19d6381aa7f7851fa522ed616505bb46c48))
* **paseo-plugin:** describe the selected chat row option in its hint ([bd82081](https://github.com/ziptie-soft/local-decider/commit/bd82081e1f8a288965df565254fec3b55ff59f27))
* **paseo-plugin:** drop the Show results button next to the open results ([21d5d29](https://github.com/ziptie-soft/local-decider/commit/21d5d297bcd7fbae9e0192d43e58f0a06d804852))
* **paseo-plugin:** give the own-model cap error a recovery step ([db84f5d](https://github.com/ziptie-soft/local-decider/commit/db84f5da53f5efde3f7a2774670c824495387095))
* **paseo-plugin:** hide benchmark columns that have no measurements ([2c71f43](https://github.com/ziptie-soft/local-decider/commit/2c71f4322df32e200b17ad048c90c8ec0349fb9d))
* **paseo-plugin:** keep the stacked decision controls inside the card ([e4bee64](https://github.com/ziptie-soft/local-decider/commit/e4bee644e59be5b1929fa9fbc325e82717ca88ea))
* **paseo-plugin:** label speed figures by source, recent decisions or benchmark ([f4d0892](https://github.com/ziptie-soft/local-decider/commit/f4d08921a0ddb91fbe5564d19fb1680f3311a4f4))
* **paseo-plugin:** label the unload button Unload all when decisions have their own model ([87f9ebe](https://github.com/ziptie-soft/local-decider/commit/87f9ebe082463dfa82364377bb91a67fb85208f1))
* **paseo-plugin:** let the settings switch command-risk and show mode errors ([4cfd9d4](https://github.com/ziptie-soft/local-decider/commit/4cfd9d44e565ccfd01818e50aa8f7b1d7a0673e3))
* **paseo-plugin:** name the default model once in the decisions table footer ([1829711](https://github.com/ziptie-soft/local-decider/commit/1829711d0d5aca4602af8e80331b8120db8860cb))
* **paseo-plugin:** name the model and runtime the same way on Status, quick status and Details ([6b7cb08](https://github.com/ziptie-soft/local-decider/commit/6b7cb08c8e8ec27ec3917a43530639b208408d68))
* **paseo-plugin:** name the model by its catalog label in the unavailable hint ([78722d4](https://github.com/ziptie-soft/local-decider/commit/78722d41da153afba0e899e97ae41f211e450dec))
* **paseo-plugin:** read a model speed on its resolved device ([a25e36c](https://github.com/ziptie-soft/local-decider/commit/a25e36c82ff107ea408feb4888191f9e6899ebee))
* **paseo-plugin:** retitle the Details load section and drop the repeated model id ([ff22e16](https://github.com/ziptie-soft/local-decider/commit/ff22e163ebc5104eee0dcf1e6050bbe4c2628d05))
* **paseo-plugin:** say once that an off decision loads no model ([dd51d7e](https://github.com/ziptie-soft/local-decider/commit/dd51d7eaf899d026d63e024bf4d70efa215c9f2c))
* **paseo-plugin:** say the gateway is unreachable in Models and Routing instead of guessing it is old ([f28c0b9](https://github.com/ziptie-soft/local-decider/commit/f28c0b9c8ab91b83397bdbafd78763f24f1fa328))
* **paseo-plugin:** show a measured speed range when the device is unknown ([5c04850](https://github.com/ziptie-soft/local-decider/commit/5c0485047c447772244da1825b5f5ffc81e65ec7))
* **paseo-plugin:** show the command-risk mode in quick status ([e159f68](https://github.com/ziptie-soft/local-decider/commit/e159f68c6acab6ca3363dc572d2bc774ffbd0704))
* **paseo-plugin:** show the same typical decision time as the quick status ([047173a](https://github.com/ziptie-soft/local-decider/commit/047173a2f422665045beb07c2f482fa83f208f8e))
* **paseo-plugin:** show the selected mode's effect under each decision row ([95e333f](https://github.com/ziptie-soft/local-decider/commit/95e333ff218cbef5dd91b3ae5184de0b380618aa))
* **paseo-plugin:** shrink the stacked model chip to the card width ([6dcc8b7](https://github.com/ziptie-soft/local-decider/commit/6dcc8b779785d30ae06c9446a65ee80d8c62af67))
* **paseo-plugin:** space the typical decision time in the gateway row ([0179cdd](https://github.com/ziptie-soft/local-decider/commit/0179cdd7d91818e5a0bb9aec65cc3fa74ea22108))
* **paseo-plugin:** tag only the machine recommendation in the models list ([68b5b82](https://github.com/ziptie-soft/local-decider/commit/68b5b828f226021db8292645b7a2061c1e7c593a))
* **paseo-plugin:** tidy chip layout, enlarge touch targets and lock mode chips while the gateway is unreachable ([b7a187f](https://github.com/ziptie-soft/local-decider/commit/b7a187f28e6a4153d13705f5841ec4909bec68ff))
* **paseo-plugin:** title the Details model section Model ([2dd9965](https://github.com/ziptie-soft/local-decider/commit/2dd9965b3664be45f5bf9ca7da8f69ddf3bc5d7c))
* send real client versions to the gateway ([7ca14e1](https://github.com/ziptie-soft/local-decider/commit/7ca14e145b692e33d71435f087c76199a2a68703))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 3.2.0

## [3.1.1](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v3.1.0...paseo-plugin-v3.1.1) (2026-11-25)


### Bug Fixes

* **paseo-plugin:** add background and metadata to test agent fixtures for [@getpaseo](https://github.com/getpaseo) 0.16 ([77789bb](https://github.com/ziptie-soft/local-decider/commit/77789bb6f5cece0489bddb616d6d410ff8c842fd))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 3.1.0

## [3.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v3.0.1...paseo-plugin-v3.1.0) (2026-11-23)


### Features

* **gateway:** remove downloaded models from the Paseo engine settings ([1fce992](https://github.com/ziptie-soft/local-decider/commit/1fce9927dc29042cd4f75d67482f953d8fe38f04))


### Bug Fixes

* **gateway:** tag ROCm torch as ROCm and simplify engine labels and descriptions ([2959d17](https://github.com/ziptie-soft/local-decider/commit/2959d17b21a2a9f2910d7ac77731a5f347558d88))

## [3.0.1](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v3.0.0...paseo-plugin-v3.0.1) (2026-11-23)


### Bug Fixes

* **paseo-plugin:** describe agent tools and their data in the overview ([29075c5](https://github.com/ziptie-soft/local-decider/commit/29075c5617111fef7a04bdd2cfffe5f9bba9f6e4))

## [3.0.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.3.0...paseo-plugin-v3.0.0) (2026-11-22)


### ⚠ BREAKING CHANGES

* **paseo-plugin:** the injected local-decider MCP server is removed; enable "Agent tools" instead (settings migrate injectMcp). Agents call mcp__paseo__local_decider_* tools.
* **paseo-plugin:** routing no longer applies a preset or profile mode more permissive than the agent's own (for example full-access over auto).
* **policies:** auto-allow permission at p(allow) >= 0.85, abstain by default in routing-budget, retune thresholds
* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats
* **hooks:** guard oversized hook input, close shell-splitter bypasses and gate Paseo auto-allow deterministically
* **paseo-plugin:** record early user answers, never report own allows as user, allow once and only shell or edit tools

### Features

* **gateway:** derive call facts from the redacted input behind a reserved facts key, shipped empty ([64f3978](https://github.com/ziptie-soft/local-decider/commit/64f39785f942dc709157df2a8c95369fdc77ad8d))
* **gateway:** scale queue slots with engine concurrency and refuse requests whose budgetMs the queue cannot meet ([8a4139c](https://github.com/ziptie-soft/local-decider/commit/8a4139cfe58a539bb852aa6a268ff584b87deae5))
* **gateway:** strands-decider 0.4.0 with a ROCm install flavour, maxConcurrency and upstream attribution ([6a938e4](https://github.com/ziptie-soft/local-decider/commit/6a938e48e19c71b287f5ccc9a7ffff9a88a731da))
* **paseo-plugin:** add an opt-in daily review to the status popover and Details page ([a960d98](https://github.com/ziptie-soft/local-decider/commit/a960d98e49a16a1e401fe4a75aabcdd64c196f00))
* **paseo-plugin:** add decide, explain and policies agent tools with limits ([fbb7428](https://github.com/ziptie-soft/local-decider/commit/fbb74281905f21e162ad43dee1a2aed2ed75c0d7))
* **paseo-plugin:** allow own agent tools without a decision and skip Codex paseo elicitations ([3b1a500](https://github.com/ziptie-soft/local-decider/commit/3b1a5006f01610bd5193b8fe96f621d3a24caed7))
* **paseo-plugin:** attach agent tools on open and retire the injected MCP server ([4b7934f](https://github.com/ziptie-soft/local-decider/commit/4b7934f7eac56b15f48e07f9b617a31e77978100))
* **paseo-plugin:** document decision rows, the explain view and the mode mismatch warning ([b3e6b92](https://github.com/ziptie-soft/local-decider/commit/b3e6b9276838ea1b571aa5010b0a3ce6b2dce1ad))
* **paseo-plugin:** draw a routing row on the new agent when routing decides ([2cb3558](https://github.com/ziptie-soft/local-decider/commit/2cb3558c3bf1d77d5b7c6faa15f330d0eee7cd65))
* **paseo-plugin:** draw deciding and skipped rows for slow or refused permission decisions ([ae273ce](https://github.com/ziptie-soft/local-decider/commit/ae273ce7570debef6da204a85974ac115de267f1))
* **paseo-plugin:** expand decision rows to explain verdict, rule, thresholds and precedent ([7726c4d](https://github.com/ziptie-soft/local-decider/commit/7726c4d9f71b4a5fbf349cb2d03356cfcc8489a8))
* **paseo-plugin:** support Paseo daemons up to 1.0.0 ([a567797](https://github.com/ziptie-soft/local-decider/commit/a56779747afbe83bd688520fd8560de999311b7d))
* **paseo-plugin:** warn when the plugin is in act but the gateway runs the policy in another mode ([8463647](https://github.com/ziptie-soft/local-decider/commit/8463647f65f17f0498b1b505e7dda7e493409d11))
* **policies:** auto-allow permission at p(allow) &gt;= 0.85, abstain by default in routing-budget, retune thresholds ([9ab2d5a](https://github.com/ziptie-soft/local-decider/commit/9ab2d5a4dfb9770f9c777eedbc7f8962d2df9fb9))


### Bug Fixes

* **core:** default to 3 chars per token and cover truncation markers, clamping and code points with tests ([7e901b1](https://github.com/ziptie-soft/local-decider/commit/7e901b180e77cfe9b3fade5f3a6936acec7f1743))
* **core:** reject duplicate threshold keys and mismatched policy ids, coerce scalar answers and type harness ids and actions ([9bda32d](https://github.com/ziptie-soft/local-decider/commit/9bda32d5acfe01cf8b7a068c4617a7e7f45cea8f))
* **gateway:** accept MCP protocol 2026-07-28 requests ([bc68423](https://github.com/ziptie-soft/local-decider/commit/bc68423d409cb6b92677f272a8371535d1c83fd2))
* **gateway:** gate usage on the report token, reject unknown decisions and outcome values, rate-limit unverified posts and keep unverified rows out of stats ([ada02e6](https://github.com/ziptie-soft/local-decider/commit/ada02e6a7e4d48ff7e94bb2623bebb3655fafd23))
* **gateway:** scope the decision cache to engine and model, tag the cache key, make canonicalJson total and evict LRU ([e63d75a](https://github.com/ziptie-soft/local-decider/commit/e63d75a22eacf039fd8cbef254e239b9622dce6b))
* **hooks:** cap hook inputs so padded payloads stay within the gateway limit, and make the command guard linear ([a580e06](https://github.com/ziptie-soft/local-decider/commit/a580e0610d5731d84e2c579eee6333293946a661))
* **hooks:** guard oversized hook input, close shell-splitter bypasses and gate Paseo auto-allow deterministically ([4a7bc10](https://github.com/ziptie-soft/local-decider/commit/4a7bc1072bfd2b213da84407897e721d2504dd6e))
* **paseo-plugin:** classify and log failed auto-allows, pass routing's remaining budget, mark a hung gateway down and skip failed turns ([5c4afc5](https://github.com/ziptie-soft/local-decider/commit/5c4afc5c74ae6bc8cb0b0d83a78f673006ffc107))
* **paseo-plugin:** don't warn on an allow threshold at or below the policy's own default ([660fe81](https://github.com/ziptie-soft/local-decider/commit/660fe818d8e3b2806086b726202017fffbd52def))
* **paseo-plugin:** drop the unused mayAutoAllow export and format the parity test ([5a5bb00](https://github.com/ziptie-soft/local-decider/commit/5a5bb00cdbe0df80e98b87a45209eedecafb0b5d))
* **paseo-plugin:** keep delegated agents' models, never let routing raise a mode, guard the policy writer, rate-limit permissions and cap their decide at 10 s ([a487220](https://github.com/ziptie-soft/local-decider/commit/a4872207149533c69a41545a5f738e121e8a7a44))
* **paseo-plugin:** record early user answers, never report own allows as user, allow once and only shell or edit tools ([59e4570](https://github.com/ziptie-soft/local-decider/commit/59e4570dedb7c943ab8384a5992bd808306fb1b7))
* **paseo-plugin:** refuse shell and patch paths and symlinks into the config dir, treat too many running agents as unknown creator ([648006f](https://github.com/ziptie-soft/local-decider/commit/648006faa92224b8d68928b6ee45eee3de3d0119))
* **paseo-plugin:** say shadow routing rows also show for unsure routes ([a41436c](https://github.com/ziptie-soft/local-decider/commit/a41436cf673f5394e0e15591e4e288a3f94b0370))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 3.0.0

## [2.3.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.2.0...paseo-plugin-v2.3.0) (2026-11-15)


### Features

* **paseo-plugin:** complete the registry listing: data flow, downloads, icon ([be1a07b](https://github.com/ziptie-soft/local-decider/commit/be1a07bdcd2fe6680c96a212095c151c5e277923))

## [2.2.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.1.2...paseo-plugin-v2.2.0) (2026-11-15)


### Features

* **engines:** explain how to get an LM Studio API token ([6bb4c88](https://github.com/ziptie-soft/local-decider/commit/6bb4c88d4684be96e20a68a2086c329eea8641e3))
* **engines:** fall back to LM_API_TOKEN for lmstudio when tokenEnv is unset ([059fc47](https://github.com/ziptie-soft/local-decider/commit/059fc47c299a0069c6fbdcbbc29e6fb34129d6c2))
* **paseo-plugin:** drop runtime dependencies and add listing screenshots for the Paseo registry ([1e47fe5](https://github.com/ziptie-soft/local-decider/commit/1e47fe5f7b148017c9908ad617f21fe63e222b2b))


### Bug Fixes

* **paseo-plugin:** tell the MLX and PyTorch MPS Apple GPU runtimes apart ([46726a7](https://github.com/ziptie-soft/local-decider/commit/46726a705283c5f96430f904c448676d2678355e))

## [2.1.2](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.1.1...paseo-plugin-v2.1.2) (2026-11-15)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.2.0

## [2.1.1](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.1.0...paseo-plugin-v2.1.1) (2026-11-14)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.1

## [2.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v2.0.0...paseo-plugin-v2.1.0) (2026-11-14)


### Features

* **paseo-plugin:** add benchmark gateway calls and RPCs ([a92027d](https://github.com/ziptie-soft/local-decider/commit/a92027dacdf495317b8205020fb3cdc9743d1d5d))
* **paseo-plugin:** add the benchmark card to the engine section ([6d0200b](https://github.com/ziptie-soft/local-decider/commit/6d0200bc5465459cb2f84415cb5ed805f4167dc5))
* **paseo-plugin:** add the benchmark card view model ([caf8506](https://github.com/ziptie-soft/local-decider/commit/caf8506faea0aef1ccbf57931f0dfa049e12bbae))
* **paseo-plugin:** add the recommended card view model ([95d871f](https://github.com/ziptie-soft/local-decider/commit/95d871f2c7e43d3627e2409a87e6ad29892acb06))
* **paseo-plugin:** fold the engine controls into an Advanced disclosure ([9f4f95b](https://github.com/ziptie-soft/local-decider/commit/9f4f95bec53a41b59cee66759cde3a5c25467004))
* **paseo-plugin:** parse engine family, measurements and machine recommendation ([80af9d3](https://github.com/ziptie-soft/local-decider/commit/80af9d3dc6e1e45763dc1c8c557dae802297c688))
* **paseo-plugin:** parse the benchmark job view ([2b24089](https://github.com/ziptie-soft/local-decider/commit/2b2408910b4f6a1d2fdc805193525c716d3bc46c))
* **paseo-plugin:** show benchmark progress in the status views and drop the cross-family suggestion ([3243146](https://github.com/ziptie-soft/local-decider/commit/32431465c4e6c3046f1cb638f35f621d272f15f9))
* **paseo-plugin:** show the recommended card at the top of the engine section ([2153a4c](https://github.com/ziptie-soft/local-decider/commit/2153a4c7e2bc30f58661e542b41a4e1370df91f2))
* **paseo-plugin:** show what is running and download progress on the recommended card ([abf8ffc](https://github.com/ziptie-soft/local-decider/commit/abf8ffc9bf6e51909a5a41f78b463fb20efa148f))
* **precedent:** add cross-harness v2 keys ([95f8a1b](https://github.com/ziptie-soft/local-decider/commit/95f8a1b89e83622cf2b2396fc0eb517ea69aaf8b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.1.0

## [2.0.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.1.0...paseo-plugin-v2.0.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* **core:** require allow-rule thresholds at or above a 0.8 floor
* **gateway:** require a control token on control routes
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin

### Features

* **paseo-plugin:** recommend llama.cpp Vulkan GPU engine ([717e0da](https://github.com/ziptie-soft/local-decider/commit/717e0dae2029a9cc40e2e1ef69db380639eceabb))
* typed outcome labels and permission-row feedback ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Bug Fixes

* **core:** key-aware deep redaction and rule hardening ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** reject unusable engine answers ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** require allow-rule thresholds at or above a 0.8 floor ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **core:** send the control token only to loopback and refuse redirects ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** drop dead queue waiters, reserve high-priority slots and release slots past the deadline ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **gateway:** require a control token on control routes ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))
* **paseo-plugin:** say 'this computer' instead of 'this Mac' in engine settings ([#16](https://github.com/ziptie-soft/local-decider/issues/16)) ([6cc712c](https://github.com/ziptie-soft/local-decider/commit/6cc712c0b7dced66c745a18b388dfc72c428636a))
* **paseo-plugin:** scope gateway tokens to loopback and the pinned origin ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Performance Improvements

* **core:** memoise secret-key classification during redaction ([2649d77](https://github.com/ziptie-soft/local-decider/commit/2649d77da157303758686eb07e14573effe6259a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 2.0.0

## [1.1.0](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.3...paseo-plugin-v1.1.0) (2026-11-12)


### Features

* prioritize system installed engines ([#13](https://github.com/ziptie-soft/local-decider/issues/13)) ([2e707a6](https://github.com/ziptie-soft/local-decider/commit/2e707a6906c9f3d29054a80a65f1ff73ecb4074a))
* sqlite store ([#15](https://github.com/ziptie-soft/local-decider/issues/15)) ([fd1499e](https://github.com/ziptie-soft/local-decider/commit/fd1499e700e6f0bc807a3838c9fd2d599f349e5c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ziptie-soft/local-decider-core bumped to 1.1.0

## [1.0.3](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.2...paseo-plugin-v1.0.3) (2026-11-11)


### Bug Fixes

* **paseo-plugin:** declare core and zod as runtime dependencies ([#9](https://github.com/ziptie-soft/local-decider/issues/9)) ([1b060b7](https://github.com/ziptie-soft/local-decider/commit/1b060b745095a40aebcbbdf72bc7edf30b9fb5ae))

## [1.0.2](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.1...paseo-plugin-v1.0.2) (2026-11-11)


### Bug Fixes

* **gateway:** pin the FastFlowLM archive checksum ([#6](https://github.com/ziptie-soft/local-decider/issues/6)) ([7327a8c](https://github.com/ziptie-soft/local-decider/commit/7327a8c4038903f4bafebaeffa82f7cc6b84ef9d))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.2

## [1.0.1](https://github.com/ziptie-soft/local-decider/compare/paseo-plugin-v1.0.0...paseo-plugin-v1.0.1) (2026-11-11)


### Bug Fixes

* security ([7184c24](https://github.com/ziptie-soft/local-decider/commit/7184c2446874efba7b567573c0bb5368acb54a72))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @ziptie-soft/local-decider-core bumped to 1.0.1
