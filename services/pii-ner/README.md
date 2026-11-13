# Локальный сервис распознавания ПДн (pii-ner)

Дополнительный слой Privacy Gateway МедКарты перед внешним триажем жалоб. Две модели в одном процессе Node:

| Модель | Лицензия | Что находит | Файл |
|---|---|---|---|
| `onnx-community/ner-rubert-tiny-news-ONNX` (база — `r1char9/ner-rubert-tiny-news`) | MIT; обучающий корпус Collection3 — `license:other`, вопрос юристу | имена, организации, места | ONNX int8, 29 МБ, скачивается готовым |
| `redmadrobot-rnd/rubert-base-pii-ner` | Apache-2.0; данные `redmadrobot-rnd/pii_train` — MIT | имена, адреса, документы РФ, телефоны, e-mail, ссылки | ONNX int8, 178 МБ, собирается `export-onnx.py` |

Находки обеих моделей объединяются, правила слияния — на стороне шлюза (`backend/privacy/spanMask.js`).
**По умолчанию выключен** (`PII_NER`). Решение о включении — в отчёте `PII_PROTECTION_REDTEAM_REPORT.md`.

## Что делает и чего не делает

- Слушает только Unix-сокет (`PII_NER_SOCKET`) или `127.0.0.1` (`PII_NER_PORT`).
- Модель загружается один раз. Файлы сверяются с `model.json` по SHA-256: при несовпадении сервис не стартует.
- Во время обработки сетевых запросов нет.
- Отвечает `{entities: [{type, start, end, score}], model, revision, ms}`. Текст не возвращает, ничего не переписывает.
- Позиции считаются в единицах строки JavaScript (UTF-16).
- Текст запросов в журнал не пишется: только запуск и коды ошибок.
- Лимиты:
  - один прогон модели за раз, очередь из 8 запросов, ожидание не дольше 1 с (иначе 503);
  - текст — не длиннее 4000 символов, тело — не больше 16 КБ (413).

## Установка (на сервере, из корня проекта)

```bash
cd services/pii-ner && npm ci --omit=dev && node fetch-model.mjs
```

`npm ci` ставит `onnxruntime-node` 1.31.1: около 300 МБ на диске, бинарники всех платформ.
`fetch-model.mjs` скачивает файлы с зафиксированных ревизий Hugging Face. rubert-tiny проверяется по SHA-256
сразу; для redmadrobot скачиваются исходные веса, и нужен однократный экспорт (Python с torch, transformers,
onnx, onnxruntime — только на время установки):

```bash
HF_HUB_OFFLINE=1 python3 -I services/pii-ner/export-onnx.py services/pii-ner/model/redmadrobot
```

Скрипт сверяет итоговые файлы с `model.json`. При другой версии библиотек квантование может дать другой файл:
тогда скрипт печатает новые SHA-256 и останавливается, пока их не проверят и не внесут вручную.
Загрузить одну модель: `PII_NER_MODELS=rubert-tiny`.

## Запуск

Через systemd с ограничениями:

```ini
[Service]
User=medkarta
Environment=PII_NER_SOCKET=/run/medkarta/pii-ner.sock
ExecStart=/usr/bin/node /home/medkarta/medkarta/services/pii-ner/server.mjs
RuntimeDirectory=medkarta
MemoryMax=900M
CPUQuota=50%
Restart=on-failure
NoNewPrivileges=true
PrivateNetwork=true
```

`PrivateNetwork=true` отрезает у процесса сеть целиком. Unix-сокет при этом работает.

Проверка (только для отладки):

```bash
curl --unix-socket /run/medkarta/pii-ner.sock http://x/healthz
```

## Включение в приложении

В `.env` МедКарты:

```
PII_NER=on
PII_NER_SOCKET=/run/medkarta/pii-ner.sock
PII_NER_TIMEOUT_MS=400
```

Сервис недоступен, перегружен или ответил не по формату — жалоба во внешнюю модель не
уходит, пользователь получает ответ локального классификатора.

## Тесты

Из корня проекта: `node --test tests/pii-ner-service.test.js tests/ner-layer.test.js tests/outbound-inspector.test.js`.
Блок с настоящей моделью выполняется, только если модель загружена.
