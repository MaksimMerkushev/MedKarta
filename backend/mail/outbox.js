/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Почтовая очередь поверх SQLite (таблица mail_outbox) и отправка с
 * повторами.
 *
 * Как устроено:
 *   - письмо ставится в очередь в той же транзакции, что и запись, к которой
 *     оно относится (заявка на регистрацию, ссылка для пароля): нет записи —
 *     нет письма, и наоборот;
 *   - отдельный цикл забирает письма, которым пора уходить (статус sending
 *     ставится атомарно — дважды одно письмо не уйдёт), отправляет и ставит
 *     sent; при временной ошибке (4xx, нет связи) — повтор через 30 с, 2,
 *     10, 30 минут (плюс до 20 % случайно, чтобы повторы не сбивались в
 *     кучу), после пятой неудачи — failed. Постоянная ошибка (5xx: ключ,
 *     отправитель, квота, адрес) — сразу failed: повтор как есть бессмыслен.
 *     Обрыв связи после передачи письма (smtp_uncertain) повторяется один
 *     раз и с тем же Message-ID. Статус доставки переносится в саму ссылку
 *     (delivery_status): «отправлено» пишется только после ответа 250 от
 *     SMTP-сервера — это «принято провайдером», а не «доставлено»;
 *   - письма уходят по одному и не чаще раза в minIntervalMs (Postbox — одно
 *     в секунду), в том числе отправленные администратором «сразу»;
 *   - письма со ссылками-ключами (регистрация, приглашение, смена пароля и
 *     email) в базе только зашифрованы (AES-256-GCM, привязка к id письма)
 *     ключом, выведенным из главного ключа сервера (MFA_SECRET_KEY или файл
 *     mfa.key, — не из базы): сам токен в базе не лежит даже в очереди, а
 *     копия базы без ключа токенов не раскрывает. Поэтому письмо, не
 *     ушедшее до перезапуска, уходит после него. Предсказуемо и остальное:
 *     письмо, зашифрованное другим ключом (ключ сменили), и письмо со
 *     ссылкой, срок которой истёк, не отправляются — помечаются failed с
 *     причиной, и статус переносится в саму ссылку (её запросят заново);
 *     письмо со ссылкой, которую тем временем заменили, отозвали или уже
 *     использовали, тоже не уходит (link_inactive);
 *   - «застрявшие» при падении процесса письма (sending) при запуске
 *     возвращаются в очередь;
 *   - после отправки адрес и текст письма из очереди стираются: остаются вид
 *     письма, SHA-256 адреса и время — для лимитов и диагностики, 30 дней.
 *
 * Лимиты (защита от «почтовых бомб» и перебора чужих адресов) считаются по
 * этой же таблице — переживают перезапуск:
 *   - писем со ссылками на один адрес — 3 в час и 6 в сутки;
 *   - информационных писем на один адрес («вход с нового устройства»,
 *     «вы уже зарегистрированы», «попытки входа») — 10 в час;
 *   - уведомлений о действиях с аккаунтом (пароль, email, факторы входа) —
 *     20 в час: их вызывает сам владелец после входа, и шквал
 *     информационных писем их не вытесняет (как и ссылки — друг друга);
 *   - писем со ссылками с одного источника (сеть /24, /64) — 10 в час и 30 в сутки;
 *   - в очереди не больше 500 неотправленных писем;
 *   - всех писем за 24 часа — не больше dailyLimit (квота Postbox — 200):
 *     сверх него письмо не ставится в очередь, а пользователь получает тот
 *     же ответ, что и при других лимитах;
 *   - писем о регистрации за 24 часа — не больше половины dailyLimit: их может
 *     вызвать кто угодно, и поток заявок не должен отнимать квоту у сброса пароля
 *     и уведомлений безопасности.
 */

import { createHash, randomBytes } from 'node:crypto';

import { createMailBox } from '../accounts/secrets.js';
import { logger } from '../observability/safeLogger.js';
import { MailError } from './smtp.js';
import { ACCOUNT_NOTICE_KINDS, MAIL_KINDS, renderMail, SECRET_KINDS } from './templates.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MAIL_LIMITS = Object.freeze({
  LINKS_PER_ADDRESS_HOUR: 3,
  LINKS_PER_ADDRESS_DAY: 6,
  ALL_PER_ADDRESS_HOUR: 10,
  ACCOUNT_NOTICES_PER_ADDRESS_HOUR: 20,
  LINKS_PER_SOURCE_HOUR: 10,
  LINKS_PER_SOURCE_DAY: 30,
  REGISTRATION_QUOTA_SHARE: 0.5,
  MAX_QUEUE: 500,
  MAX_ATTEMPTS: 5,
  BACKOFF_MS: Object.freeze([30 * 1000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE]),
  BACKOFF_JITTER: 0.2,
  KEEP_DAYS: 30,
  TICK_MS: 5_000,
});

/** Постоянные ошибки настройки почты — в журнал уровнем error: их чинит администратор, а не повтор. */
const CONFIG_ERRORS = new Set(['smtp_auth', 'smtp_sender', 'smtp_quota', 'smtp_tls', 'smtp_no_starttls', 'smtp_insecure']);

export const addressHash = (address) => createHash('sha256').update(String(address || '').trim().toLowerCase()).digest('hex');

/** Пауза перед повтором: ступень BACKOFF_MS плюс до 20 % случайно. */
export const retryDelay = (attempts, random = Math.random) => {
  const base = MAIL_LIMITS.BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, MAIL_LIMITS.BACKOFF_MS.length - 1)];
  return base + Math.floor(base * MAIL_LIMITS.BACKOFF_JITTER * random());
};

/** Что ответил сервер — для журнала: код, расширенный код, id у провайдера. Адресов и текста нет. */
const providerFields = (details) => ({
  ...(Number.isInteger(details?.status) ? { smtp_status: details.status } : {}),
  ...(details?.enhanced ? { smtp_enhanced: details.enhanced } : {}),
  ...(details?.queuedAs ? { provider_ref: details.queuedAs } : {}),
  ...(details?.requestId ? { provider_request_id: details.requestId } : {}),
});

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} deps.delivery доставка (accounts/delivery.js): deliver, emailEnabled, quota
 * @param {(ref: {type: string, id: string}, status: 'sent'|'failed') => void} [deps.onStatus] статус доставки — в ссылку
 * @param {Buffer|null} [deps.masterKey] главный ключ сервера (secrets.loadMfaKey): из него — ключ писем со ссылками
 * @param {(ref: {type: string, id: string}) => boolean} [deps.refActive] ссылка из письма ещё действует (не использована, не отозвана)
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.clock] настоящее время для паузы между письмами (не подменяется вместе с now)
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.random] случайная добавка к паузе перед повтором
 */
export const createMailer = ({
  store, delivery, onStatus = () => {}, masterKey = null, refActive = () => true, now = () => Date.now(),
  clock = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
}) => {
  const { box, keyId, persistent } = createMailBox(masterKey);
  if (!persistent) logger.warn('mail.ephemeral_key', { status: 'memory' });
  let timer = null;
  let running = null;
  const dailyLimit = delivery.quota?.dailyLimit ?? 0;
  const minIntervalMs = delivery.quota?.minIntervalMs ?? 0;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let gate = Promise.resolve();
  let quotaWarnedAt = Number.NEGATIVE_INFINITY;

  const linkKinds = [...SECRET_KINDS];
  const accountKinds = MAIL_KINDS.filter((kind) => ACCOUNT_NOTICE_KINDS.has(kind));
  const infoKinds = MAIL_KINDS.filter((kind) => !SECRET_KINDS.has(kind) && !ACCOUNT_NOTICE_KINDS.has(kind));
  const registrationKinds = ['register_confirm', 'register_exists', 'register_pending'];

  /**
   * Письма уходят по одному и не чаще раза в minIntervalMs — и из цикла
   * очереди, и «отправить сразу»: Postbox на превышение отвечает 454.
   */
  const paced = (work) => {
    const turn = gate.then(async () => {
      const wait = lastSendAt + minIntervalMs - clock();
      if (wait > 0) await sleep(wait);
      try {
        return await work();
      } finally {
        lastSendAt = clock();
      }
    });
    gate = turn.catch(() => {});
    return turn;
  };

  /** Можно ли сейчас отправить письмо такого вида на этот адрес (и с этого источника). */
  const allows = ({ kind, to, sourceKey = null }) => {
    const toHash = addressHash(to);
    const stamp = now();
    if (dailyLimit > 0 && store.countRecentMail(stamp - DAY) >= dailyLimit) {
      // Предупреждение — не чаще раза в 10 минут: исчерпанную квоту не превратить в поток записей журнала.
      if (stamp - quotaWarnedAt >= 10 * MINUTE) {
        quotaWarnedAt = stamp;
        logger.warn('mail.daily_quota', { status: 'limited', count: dailyLimit });
      }
      return { allowed: false, reason: 'daily_quota' };
    }
    if (dailyLimit > 0 && registrationKinds.includes(kind)
      && store.countRecentMail(stamp - DAY, registrationKinds) >= Math.ceil(dailyLimit * MAIL_LIMITS.REGISTRATION_QUOTA_SHARE)) {
      return { allowed: false, reason: 'registration_quota' };
    }
    if (store.countPendingMail() >= MAIL_LIMITS.MAX_QUEUE) return { allowed: false, reason: 'queue_full' };
    if (ACCOUNT_NOTICE_KINDS.has(kind)) {
      if (store.countMailTo({ toHash, since: stamp - HOUR, kinds: accountKinds }) >= MAIL_LIMITS.ACCOUNT_NOTICES_PER_ADDRESS_HOUR) return { allowed: false, reason: 'address_hour' };
    } else if (!SECRET_KINDS.has(kind) && store.countMailTo({ toHash, since: stamp - HOUR, kinds: infoKinds }) >= MAIL_LIMITS.ALL_PER_ADDRESS_HOUR) {
      return { allowed: false, reason: 'address_hour' };
    }
    if (SECRET_KINDS.has(kind)) {
      if (store.countMailTo({ toHash, since: stamp - HOUR, kinds: linkKinds }) >= MAIL_LIMITS.LINKS_PER_ADDRESS_HOUR) return { allowed: false, reason: 'links_hour' };
      if (store.countMailTo({ toHash, since: stamp - DAY, kinds: linkKinds }) >= MAIL_LIMITS.LINKS_PER_ADDRESS_DAY) return { allowed: false, reason: 'links_day' };
      if (sourceKey && store.countMailFromSource({ sourceKey, since: stamp - HOUR }) >= MAIL_LIMITS.LINKS_PER_SOURCE_HOUR) return { allowed: false, reason: 'source_hour' };
      if (sourceKey && store.countMailFromSource({ sourceKey, since: stamp - DAY }) >= MAIL_LIMITS.LINKS_PER_SOURCE_DAY) return { allowed: false, reason: 'source_hour' };
    }
    return { allowed: true, reason: null };
  };

  /**
   * Поставить письмо в очередь. Вызывается внутри транзакции вызывающего
   * (store.transaction) — письмо и запись появляются вместе.
   *
   * @returns {string} id письма
   */
  const enqueue = ({ kind, to, params = {}, sourceKey = null, ref = null, delayMs = 0, expiresAt = null }) => {
    if (!delivery.emailEnabled) throw new MailError('mail_disabled', 'Почта не настроена');
    const content = renderMail(kind, params);
    const secret = SECRET_KINDS.has(kind);
    const id = randomBytes(12).toString('hex');
    const json = JSON.stringify(content);
    store.enqueueMail({
      id,
      kind,
      toHash: addressHash(to),
      toAddress: to,
      payload: secret ? box.seal(json, id) : json,
      keyId: secret ? keyId : null,
      nextAttemptAt: now() + delayMs,
      sourceKey,
      refType: ref?.type || null,
      refId: ref?.id || null,
      // Срок ссылки: после него письмо не отправляется.
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : (secret && Number.isFinite(params.expiresAt) ? params.expiresAt : null),
      now: now(),
    });
    return id;
  };

  const contentOf = (mail) => {
    if (!mail.payload) return null;
    if (!mail.keyId) {
      try {
        return JSON.parse(mail.payload);
      } catch {
        return null;
      }
    }
    if (mail.keyId !== keyId) return null;
    const opened = box.open(mail.payload, mail.id);
    try {
      return opened ? JSON.parse(opened.toString('utf8')) : null;
    } catch {
      return null;
    }
  };

  const finish = (mail, status, error = null, details = null) => {
    if (status === 'sent') store.markMailSent(mail.id, now());
    else store.markMailFailed(mail.id, error);
    if (mail.refType && mail.refId) {
      try {
        onStatus({ type: mail.refType, id: mail.refId }, status);
      } catch (failure) {
        logger.error('mail.status_failed', failure);
      }
    }
    // mail_id — id письма в очереди: по нему строка журнала связывается с RequestID провайдера.
    const fields = { status, action: mail.kind, mail_id: mail.id, ...(error ? { error_code: error } : {}), ...providerFields(details) };
    if (status === 'sent') logger.event('mail.sent', fields);
    else if (CONFIG_ERRORS.has(error)) logger.error('mail.failed', { code: error }, fields);
    else logger.event('mail.failed', fields);
  };

  /** Одна попытка отправить взятое из очереди письмо. */
  const attempt = async (mail, { retry = true } = {}) => {
    // Ссылка в письме уже не действует: мёртвую ссылку не отправляем.
    if (mail.expiresAt && mail.expiresAt <= now()) {
      finish(mail, 'failed', 'expired');
      return false;
    }
    // Зашифровано другим ключом (главный ключ сервера сменили) — не расшифровать.
    if (mail.keyId && mail.keyId !== keyId) {
      finish(mail, 'failed', 'key_changed');
      return false;
    }
    // Пока письмо ждало (например, перезапуска), ссылку заменили новой, отозвали или уже использовали.
    if (mail.refType && mail.refId && SECRET_KINDS.has(mail.kind) && !refActive({ type: mail.refType, id: mail.refId })) {
      store.markMailFailed(mail.id, 'link_inactive');
      logger.event('mail.failed', { status: 'failed', action: mail.kind, error_code: 'link_inactive' });
      return false;
    }
    const content = contentOf(mail);
    if (!content || !mail.toAddress) {
      // Письмо испорчено (или зашифровано ключом процесса, который уже завершился): ссылку запросят заново.
      finish(mail, 'failed', 'unreadable');
      return false;
    }
    try {
      const accepted = await paced(() => delivery.deliver({ to: mail.toAddress, content, messageId: mail.id }));
      finish(mail, 'sent', null, accepted);
      return true;
    } catch (error) {
      const code = error instanceof MailError ? error.code : 'mail_error';
      // Повторяются только временные ошибки; обрыв после передачи письма — не больше одного раза.
      const transient = (!(error instanceof MailError) || error.transient !== false) && code !== 'bad_address' && code !== 'mail_disabled';
      const uncertainAgain = code === 'smtp_uncertain' && mail.lastError === 'smtp_uncertain';
      if (retry && transient && !uncertainAgain && mail.attempts < MAIL_LIMITS.MAX_ATTEMPTS) {
        store.markMailRetry(mail.id, now() + retryDelay(mail.attempts, random), code);
        logger.warn('mail.retry', { status: 'retry', error_code: code, count: mail.attempts, mail_id: mail.id, ...providerFields(error) });
      } else {
        finish(mail, 'failed', code, error);
      }
      return false;
    }
  };

  /** Обработать письма, которым пора уходить. Не параллельно сам с собой. */
  const processDue = async () => {
    if (running) return running;
    running = (async () => {
      try {
        for (let round = 0; round < 20; round += 1) {
          const batch = store.claimDueMail(now(), 5);
          if (batch.length === 0) break;
          for (const mail of batch) await attempt(mail);
        }
      } catch (error) {
        logger.error('mail.queue_failed', error);
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
    return undefined;
  };

  const kick = () => {
    setImmediate(() => {
      processDue().catch(() => {});
    });
  };

  return Object.freeze({
    get enabled() {
      return delivery.emailEnabled;
    },
    allows,
    enqueue,
    kick,
    processDue,

    /**
     * Отправить сразу (одна попытка, без повторов) — для действий
     * администратора: если письмо не ушло, он получает ссылку, чтобы
     * передать её сам, и очередь больше не будет пытаться.
     */
    async sendNow(id) {
      const mail = store.claimMail(id);
      return mail ? attempt(mail, { retry: false }) : false;
    },

    /** Запуск цикла: письма, «застрявшие» до перезапуска, возвращаются в очередь. */
    start() {
      if (timer) return;
      store.releaseStuckMail(now() + 1);
      timer = setInterval(() => {
        processDue().catch(() => {});
      }, MAIL_LIMITS.TICK_MS);
      timer.unref?.();
      kick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Тесты: дождаться, пока очередь опустеет (или пока писать больше нечего). */
    async drain() {
      await processDue();
    },
    purge: () => store.purgeMail(now() - MAIL_LIMITS.KEEP_DAYS * DAY),
    stats: () => ({ pending: store.countPendingMail(), last24h: store.mailStats(now() - DAY) }),
  });
};
