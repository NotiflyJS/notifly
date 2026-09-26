# [@netiflyjs/core-v1.8.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.7.0...@netiflyjs/core-v1.8.0) (2026-09-26)


### Features

* **core:** add createNetiflyPublisher() for workers/cron/serverless ([46c3a0a](https://github.com/NetiflyJS/netifly/commit/46c3a0a37bf1231e0aee9c23556b5e9d4270cf14))
* **core:** reject unauthorized upgrades with 401 + reject event ([6f3976c](https://github.com/NetiflyJS/netifly/commit/6f3976c7ad23bcf9488a2cc80f4258826b7b3c7c))

# [@netiflyjs/core-v1.7.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.6.0...@netiflyjs/core-v1.7.0) (2026-09-26)


### Features

* **core:** add namespace option to isolate shared Redis instances ([c22784a](https://github.com/NetiflyJS/netifly/commit/c22784a9ec80e496a7d250ee4aeb0c8a1ba92cfe))

# [@netiflyjs/core-v1.6.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.5.0...@netiflyjs/core-v1.6.0) (2026-09-26)


### Features

* **core:** add presence API (isOnline, whoIsOnline, isConnectedHere) ([d218a8e](https://github.com/NetiflyJS/netifly/commit/d218a8e883b75d81da806e60e930c6e8ca2142cb)), closes [RedisRouter#numSubscribers](https://github.com/RedisRouter/issues/numSubscribers) [NetiflyInstance#isOnline](https://github.com/NetiflyInstance/issues/isOnline)
* **core:** delivery-aware send() returning { delivered, instances }, plus sendOr() ([6db1907](https://github.com/NetiflyJS/netifly/commit/6db190707edc2d80a28deeb79d9e37ab3b5455c0)), closes [RedisRouter#publish](https://github.com/RedisRouter/issues/publish)

# [@netiflyjs/core-v1.5.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.4.0...@netiflyjs/core-v1.5.0) (2026-09-26)


### Features

* **core:** bound inbound frame size, outbound buffers, and connections per user ([1669886](https://github.com/NetiflyJS/netifly/commit/16698862d22da18165a02182faa05b0d15e705fa))

# [@netiflyjs/core-v1.4.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.3.1...@netiflyjs/core-v1.4.0) (2026-09-25)


### Features

* **core:** add Origin allowlist to prevent cross-site WebSocket hijacking ([0791ed5](https://github.com/NetiflyJS/netifly/commit/0791ed59d4fab99f29b5086d88c00b24f9d6b72f))

# [@netiflyjs/core-v1.3.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.3.0...@netiflyjs/core-v1.3.1) (2026-09-25)


### Bug Fixes

* **core:** ref-count Redis subscriptions to close subscribe/unsubscribe race ([23a860f](https://github.com/NetiflyJS/netifly/commit/23a860f83f3025ca82b9c974dac635f887b4e882))

# [@netiflyjs/core-v1.3.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.2.0...@netiflyjs/core-v1.3.0) (2026-09-25)


### Features

* add message envelop ([eed4a1b](https://github.com/NetiflyJS/netifly/commit/eed4a1bfe6ff314f52b8916170666940e509d9cd))

# [@netiflyjs/core-v1.2.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.1.0...@netiflyjs/core-v1.2.0) (2026-09-25)


### Features

* rename Notifly to Netifly across public API and docs ([7c7473d](https://github.com/NetiflyJS/netifly/commit/7c7473dc5bf3769acc6e795653fe027b7c6a28e0))

# [@netiflyjs/core-v1.1.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.1...@netiflyjs/core-v1.1.0) (2026-09-25)


### Features

* updated docs and license ([bb80f69](https://github.com/NetiflyJS/netifly/commit/bb80f69e24f78dd6fc538cf42096854de33c9de6))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-25)


### Bug Fixes

* use absolute logo URL and add repository field to packages ([371aec3](https://github.com/NetiflyJS/netifly/commit/371aec369b74287cddbb49ac47a661a151bab8ee))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-25)


### Bug Fixes

* use absolute logo URL and add repository field to packages ([371aec3](https://github.com/NetiflyJS/netifly/commit/371aec369b74287cddbb49ac47a661a151bab8ee))

# @netiflyjs/core-v1.0.0 (2026-09-25)


### Bug Fixes

* address final review findings and rename npm scope to [@notiflyjs](https://github.com/notiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))
* **ci:** migrate npm publish to OIDC trusted publishing ([85b8f39](https://github.com/NetiflyJS/netifly/commit/85b8f3945cb3d0c0f6ccf63b0bc2d5f7463a81a4))
* rename npm scope and GitHub org from notiflyjs to netiflyjs ([48885f3](https://github.com/NetiflyJS/netifly/commit/48885f3a3828f6727b664cc5b9b0b79acb8896d0))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))

# [@netiflyjs/core-v1.0.1](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/core-v1.0.0...@netiflyjs/core-v1.0.1) (2026-09-24)


### Bug Fixes

* **ci:** migrate npm publish to OIDC trusted publishing ([85b8f39](https://github.com/NetiflyJS/netifly/commit/85b8f3945cb3d0c0f6ccf63b0bc2d5f7463a81a4))

# @netiflyjs/core-v1.0.0 (2026-09-24)


### Bug Fixes

* address final review findings and rename npm scope to [@netiflyjs](https://github.com/netiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))

# @netiflyjs/core-v1.0.0 (2026-09-24)


### Bug Fixes

* address final review findings and rename npm scope to [@netiflyjs](https://github.com/netiflyjs) ([76778fe](https://github.com/NetiflyJS/netifly/commit/76778fe4731d0786af64bbf70b23659f2d88fd26))


### Features

* check for heartbeat ([9770d1f](https://github.com/NetiflyJS/netifly/commit/9770d1fe7b1ce46fbc66e33febd9da334c1449c3))
* impelement ConnectionRegistry ([352ea3a](https://github.com/NetiflyJS/netifly/commit/352ea3ac65faa43b9c2203001cdbe4af0d7b0ad4))
* notifly server ([802640b](https://github.com/NetiflyJS/netifly/commit/802640b9be080e2b48a6f4e6637c14b6af02fff0))
* notifly server ([ad56701](https://github.com/NetiflyJS/netifly/commit/ad56701378de869fc839959b531d55f113043493))
* store subscriptions in redis db ([c430f81](https://github.com/NetiflyJS/netifly/commit/c430f8168bd5194982a3406d8658376671537355))
