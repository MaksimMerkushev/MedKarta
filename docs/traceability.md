# Матрица трассируемости

Связь «возможность → код → тесты → документ». Ссылки ведут на файлы
коммита `d9c0de6`; номера строк не приводятся — ищите по названию функции.

## Ассистент и приватность

| Возможность | Код (ключевые функции) | Тесты | Документ |
|---|---|---|---|
| Приём запроса, лимиты, очередь разбора | [api/chat.js](../backend/api/chat.js) (`createCpuQueue`, `handler`), [rateLimit.js](../backend/http/rateLimit.js) | [second-audit.test.js](../tests/second-audit.test.js), [third-audit.test.js](../tests/third-audit.test.js) | [05](05-backend.md), [06](06-ai-assistant.md) |
| Проверка истории чата | [shared/contract.js](../shared/contract.js) (`validateChatMessages`) | [pipeline.integration.test.js](../tests/pipeline.integration.test.js) | [12](12-api-reference.md) |
| Сборка конвейера и деградация | [pipeline.js](../backend/pipeline.js) (`createPipeline`, `getDefaultPipeline`, `plannerTransportFromEnv`) | [pipeline.integration.test.js](../tests/pipeline.integration.test.js) | [06](06-ai-assistant.md) |
| Privacy Gateway | [gateway.js](../backend/privacy/gateway.js) (`createPrivacyGateway`, `process`, `extractConstraints`, `extractIntentSignals`) | [outbound-leakage.test.js](../tests/outbound-leakage.test.js), [privacy-audit.test.js](../tests/privacy-audit.test.js), [second-audit.test.js](../tests/second-audit.test.js) | [07](07-privacy.md) |
| Политика fail-closed | [policies.js](../backend/privacy/policies.js) (`decideGatewayPolicy`, `POLICY`) | [outbound-leakage.test.js](../tests/outbound-leakage.test.js) | [07](07-privacy.md) |
| Тип границы доверия | [models.js](../backend/privacy/models.js) (`SanitizedPlannerRequest`, `mintSanitizedPlannerRequest`), [eslint.config.js](../eslint.config.js) | [boundary.test.js](../tests/boundary.test.js) | [07](07-privacy.md) |
| Детекторы ПДн и скан-вид | [detectors.js](../backend/privacy/detectors.js) (`detectEntities`, `buildScanView`, `detectObfuscation`), [normalize.js](../backend/privacy/normalize.js) | [obfuscation.test.js](../tests/obfuscation.test.js), [privacy-redaction.test.js](../tests/privacy-redaction.test.js) | [07](07-privacy.md) |
| Связывание со справочником | [entityResolver.js](../backend/privacy/entityResolver.js), [morphology.js](../backend/privacy/morphology.js), [catalog.js](../backend/privacy/catalog.js) | [obfuscation.test.js](../tests/obfuscation.test.js), [privacy-audit.test.js](../tests/privacy-audit.test.js) | [10](10-medical-search-and-data.md) |
| Закрытый словарь | [vocabulary.js](../backend/privacy/vocabulary.js) (`checkClosedVocabulary`) | [second-audit.test.js](../tests/second-audit.test.js) | [07](07-privacy.md) |
| Классификатор жалоб и красные флаги | [symptoms.js](../backend/privacy/symptoms.js) (`classifySymptoms`) | [third-audit.test.js](../tests/third-audit.test.js), [sprint1-scenario.test.js](../tests/sprint1-scenario.test.js) | [10](10-medical-search-and-data.md) |
| Профили вне справочника | [unknownSpecialties.js](../backend/privacy/unknownSpecialties.js) | [demo-scenarios.test.js](../tests/demo-scenarios.test.js) | [06](06-ai-assistant.md) |
| Token Vault | [tokenVault.js](../backend/storage/tokenVault.js) (`createTokenVault`, `createStoreFromEnv`) | [token-vault.test.js](../tests/token-vault.test.js) | [07](07-privacy.md) |
| Внешний планировщик и предохранитель | [planner/client.js](../backend/planner/client.js) (`createExternalPlanner`, `assertOutboundSafe`, `buildPlannerBody`), [prompts.js](../backend/planner/prompts.js), [schema.js](../backend/planner/schema.js) | [outbound-leakage.test.js](../tests/outbound-leakage.test.js), [planner-schema.test.js](../tests/planner-schema.test.js) | [06](06-ai-assistant.md) |
| Транспорт через прокси | [proxyFetch.js](../backend/planner/proxyFetch.js) | [proxy-fetch.test.js](../tests/proxy-fetch.test.js) | [06](06-ai-assistant.md) |
| Валидатор плана | [validator.js](../backend/planner/validator.js) (`validatePlan`) | [planner-validation.test.js](../tests/planner-validation.test.js) | [06](06-ai-assistant.md) |
| Policy Engine | [policyEngine.js](../backend/executor/policyEngine.js) (`createPolicyEngine`) | [planner-validation.test.js](../tests/planner-validation.test.js) | [06](06-ai-assistant.md), [08](08-security.md) |
| Локальный планировщик | [localPlanner.js](../backend/planner/localPlanner.js) (`planLocally`) | [pipeline.integration.test.js](../tests/pipeline.integration.test.js) | [06](06-ai-assistant.md) |
| Исполнение и шаблоны ответа | [actions.js](../backend/executor/actions.js), [resultBuilder.js](../backend/executor/resultBuilder.js), [catalogRepository.js](../backend/executor/catalogRepository.js) | [pipeline.integration.test.js](../tests/pipeline.integration.test.js) | [06](06-ai-assistant.md) |
| Контекст диалога и сброс | [gateway.js](../backend/privacy/gateway.js) (`CONTEXT_RESET`, `MAX_CONTEXT_TURNS`), [services/ai.js](../frontend/src/services/ai.js) (`packMessages`) | [demo-scenarios.test.js](../tests/demo-scenarios.test.js), [booking-fuzz.test.js](../tests/booking-fuzz.test.js) | [06](06-ai-assistant.md) |
| Безопасный журнал и метрики | [safeLogger.js](../backend/observability/safeLogger.js), [metrics.js](../backend/observability/metrics.js) | [logging.test.js](../tests/logging.test.js) | [17](17-performance-and-observability.md) |
| Оценка обезличивания | [tools/privacy-eval/](../tools/privacy-eval/evaluate.js), [privacy-eval.mjs](../scripts/privacy-eval.mjs) | [privacy-eval.test.js](../tests/privacy-eval.test.js) | [privacy-evaluation.md](privacy-evaluation.md), [07](07-privacy.md) |

## Демо-запись

| Возможность | Код | Тесты | Документ |
|---|---|---|---|
| Разбор условий записи | [bookingConstraints.js](../backend/privacy/bookingConstraints.js) (`extractBookingConstraints`, `mergeBookingTurns`), [demoRefs.js](../backend/privacy/demoRefs.js) | [booking-constraints.test.js](../tests/booking-constraints.test.js), [booking-fuzz.test.js](../tests/booking-fuzz.test.js) | [11](11-demo-booking.md) |
| Мост из чата в подбор | [chatBridge.js](../backend/demo/chatBridge.js) (`buildBookingRequest`, `bookingReplyText`) | [demo-scenarios.test.js](../tests/demo-scenarios.test.js) | [11](11-demo-booking.md) |
| Формат запроса подбора | [shared/demoSearch.js](../shared/demoSearch.js) (`normalizeSearchRequest`, `describeRequest`) | [demo-scenarios.test.js](../tests/demo-scenarios.test.js) | [11](11-demo-booking.md), [12](12-api-reference.md) |
| Строгий подбор | [search.js](../backend/demo/search.js) (`createDemoSearch`, `run`, `sortCandidates`) | [demo-scenarios.test.js](../tests/demo-scenarios.test.js) | [11](11-demo-booking.md) |
| Слоты, удержание, запись, отмена | [bookingStore.js](../backend/demo/bookingStore.js) | [demo-booking.test.js](../tests/demo-booking.test.js) | [11](11-demo-booking.md), [13](13-data-model.md) |
| HTTP демо-записи | [api/demoBooking.js](../backend/api/demoBooking.js) | [demo-booking.test.js](../tests/demo-booking.test.js) | [12](12-api-reference.md) |
| Генерация демо-набора | [generator.js](../backend/demo/generator.js), [demo-generate.mjs](../scripts/demo-generate.mjs) | [demo-data.test.js](../tests/demo-data.test.js) | [demo.md](demo.md) |
| Интерфейс подбора и записи | [DemoOffers.jsx](../frontend/src/DemoOffers.jsx), [BookingDialog.jsx](../frontend/src/BookingDialog.jsx), [MyBookingsPanel.jsx](../frontend/src/MyBookingsPanel.jsx) | нет автоматических тестов | [04](04-frontend.md) |

## Маршрутизация

| Возможность | Код | Тесты | Документ |
|---|---|---|---|
| Формат и загрузка графа | [format.js](../backend/routing/format.js), [graph.js](../backend/routing/graph.js) (`createGraph`, `markMainComponents`) | [routing.test.js](../tests/routing.test.js) | [09](09-routing-engine.md) |
| Привязка к дороге | [graph.js](../backend/routing/graph.js) (`snapToRoad`) | [routing-snap.test.js](../tests/routing-snap.test.js) | [09](09-routing-engine.md) |
| A* и «один ко многим» | [astar.js](../backend/routing/astar.js) (`createSearch`, `run`, `runOneToMany`) | [routing.test.js](../tests/routing.test.js), [travel-times.test.js](../tests/travel-times.test.js) | [09](09-routing-engine.md) |
| Движок, кеши, перезагрузка | [engine.js](../backend/routing/engine.js) (`createRoutingEngine`, `getDefaultRoutingEngine`) | [routing.test.js](../tests/routing.test.js) | [09](09-routing-engine.md) |
| Рамка графа | [coverage.js](../backend/routing/coverage.js) | [routing-coverage.test.js](../tests/routing-coverage.test.js) | [09](09-routing-engine.md) |
| Сборка из OSM | [osm.js](../backend/routing/osm.js), [build-road-graph.mjs](../scripts/build-road-graph.mjs) | [routing.test.js](../tests/routing.test.js) | [routing.md](routing.md) |
| `/api/route`, `/api/travel-times` | [route.js](../backend/api/route.js), [travelTimes.js](../backend/api/travelTimes.js) | [routing.test.js](../tests/routing.test.js), [travel-times.test.js](../tests/travel-times.test.js) | [12](12-api-reference.md) |
| Выбор «ближайшего» в ассистенте | [executor/routing.js](../backend/executor/routing.js) (`selectByTravelTime`, `createRoutingProviderFromEnv`) | косвенно — [pipeline.integration.test.js](../tests/pipeline.integration.test.js) (провайдер по прямой из [helpers.js](../tests/helpers.js)) | [09](09-routing-engine.md) |

## Интерфейс, данные, кабинет, эксплуатация

| Возможность | Код | Тесты | Документ |
|---|---|---|---|
| Карта, фильтры, сортировки, URL | [App.jsx](../frontend/src/App.jsx), [SearchFilters.jsx](../frontend/src/SearchFilters.jsx) | нет автоматических тестов | [04](04-frontend.md) |
| «Три лучших» | [bestPicks.js](../frontend/src/bestPicks.js), [TopPicks.jsx](../frontend/src/TopPicks.jsx) | [best-picks.test.js](../tests/best-picks.test.js) | [04](04-frontend.md) |
| Врачи в одной точке | [placeList.js](../frontend/src/placeList.js), [PlaceDoctorList.jsx](../frontend/src/PlaceDoctorList.jsx) | [place-list.test.js](../tests/place-list.test.js) | [04](04-frontend.md) |
| Внешние карты, переход к записи | [externalMaps.js](../frontend/src/externalMaps.js), [booking.js](../frontend/src/booking.js) | [external-links.test.js](../tests/external-links.test.js) | [04](04-frontend.md) |
| ДМС, услуги, частные клиники | [shared/dms.js](../shared/dms.js), [shared/services.js](../shared/services.js), [shared/privateCatalog.js](../shared/privateCatalog.js) | [private-data.test.js](../tests/private-data.test.js) | [10](10-medical-search-and-data.md), [13](13-data-model.md) |
| Часы работы | [shared/openingHours.js](../shared/openingHours.js) | [opening-hours.test.js](../tests/opening-hours.test.js) | [10](10-medical-search-and-data.md) |
| Сборщик данных | [tools/data/](../tools/data/collector.js), [data-collect.mjs](../scripts/data-collect.mjs) | [data-collector.test.js](../tests/data-collector.test.js) | [data-pipeline.md](data-pipeline.md) |
| Кабинет | [api/account.js](../backend/api/account.js), [accounts/](../backend/accounts/service.js) | [accounts.test.js](../tests/accounts.test.js) | [accounts.md](accounts.md), [12](12-api-reference.md) |
| Аналитика | [api/events.js](../backend/api/events.js), [eventStore.js](../backend/analytics/eventStore.js), [report.js](../backend/analytics/report.js), [shared/analytics.js](../shared/analytics.js) | [analytics.test.js](../tests/analytics.test.js) | [analytics.md](analytics.md) |
| HTTP-сервер, статика, заголовки | [server.js](../backend/server.js), [securityHeaders.js](../backend/http/securityHeaders.js), [request.js](../backend/http/request.js) | [boundary.test.js](../tests/boundary.test.js) | [05](05-backend.md), [08](08-security.md) |
| Конфигурация демо | [api/config.js](../backend/api/config.js), [demo/flags.js](../backend/demo/flags.js), [demoMode.js](../frontend/src/demoMode.js) | [booking-constraints.test.js](../tests/booking-constraints.test.js) (флаги и `/api/config`) | [11](11-demo-booking.md) |
