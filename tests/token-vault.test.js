/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Тесты 4–5: изоляция сессий и истечение TTL.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryStore, createTokenVault, MAX_TOKENS_PER_SESSION } from '../api/_shared/storage/tokenVault.js';
import { TEST_SECRET } from './helpers.js';

const makeVault = (store = createMemoryStore()) => ({
  store,
  vault: createTokenVault({ store, secret: TEST_SECRET, ttlSeconds: 60 }),
});

describe('4. Изоляция сессий', () => {
  it('токен одной сессии не разыменовывается в другой', async () => {
    const { vault } = makeVault();
    const token = await vault.mint({
      sessionId: 'session-alpha-0001',
      kind: 'DOCTOR',
      index: 0,
      value: { ids: ['fx-doc-petrov-therapist'] },
    });

    const own = await vault.resolve({ sessionId: 'session-alpha-0001', token });
    assert.ok(own, 'токен не читается в своей же сессии');

    const foreign = await vault.resolve({ sessionId: 'session-beta-0002', token });
    assert.equal(foreign, null, 'токен прочитан из чужой сессии');
  });

  it('один и тот же врач получает разные токены в разных сессиях', async () => {
    const { vault } = makeVault();
    const value = { ids: ['fx-doc-petrov-therapist'] };
    const a = await vault.mint({ sessionId: 'session-alpha-0001', kind: 'DOCTOR', index: 0, value });
    const b = await vault.mint({ sessionId: 'session-gamma-0003', kind: 'DOCTOR', index: 0, value });

    assert.notEqual(a, b, 'устойчивый псевдоним позволяет связать сессии между собой');
  });

  it('отклоняет мусор вместо токена', async () => {
    const { vault } = makeVault();
    assert.equal(await vault.resolve({ sessionId: 'session-alpha-0001', token: 'DOCTOR_A' }), null);
    assert.equal(await vault.resolve({ sessionId: 'session-alpha-0001', token: null }), null);
    assert.equal(await vault.resolve({ sessionId: '', token: '@DOCTOR_A' }), null);
  });

  it('ограничивает число токенов на сессию', async () => {
    const { vault } = makeVault();
    await assert.rejects(
      vault.mint({ sessionId: 'session-alpha-0001', kind: 'DOCTOR', index: MAX_TOKENS_PER_SESSION, value: {} }),
      /too many tokens/,
    );
  });
});

describe('5. Истечение TTL', () => {
  it('после истечения срока токен не разыменовывается', async () => {
    const { store, vault } = makeVault();
    const token = await vault.mint({
      sessionId: 'session-alpha-0001',
      kind: 'CLINIC',
      index: 0,
      value: { ids: ['fx-clinic-gagarina'] },
    });

    assert.ok(await vault.resolve({ sessionId: 'session-alpha-0001', token }));
    store.__expireAll();
    assert.equal(
      await vault.resolve({ sessionId: 'session-alpha-0001', token }),
      null,
      'истёкший токен всё ещё читается',
    );
  });

  it('истёкшая запись удаляется из хранилища', async () => {
    const { store, vault } = makeVault();
    await vault.mint({ sessionId: 'session-alpha-0001', kind: 'CLINIC', index: 0, value: {} });
    store.__expireAll();
    await vault.resolve({ sessionId: 'session-alpha-0001', token: '@CLINIC_A' });
    await vault.resolve({ sessionId: 'session-alpha-0001', token: vault.formatToken('session-alpha-0001', 'CLINIC', 0) });
    assert.equal(store.size, 0, 'истёкшая запись осталась в памяти');
  });
});
