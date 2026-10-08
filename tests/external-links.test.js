/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Ссылки «Как добраться» (Яндекс Карты, 2ГИС) и переход к записи.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { build2gisRouteUrl, buildExternalRouteUrl, buildYandexRouteUrl } from '../frontend/src/externalMaps.js';
import { GOSUSLUGI_APPOINTMENT_URL, omsHint, withReferral } from '../frontend/src/booking.js';

const ORIGIN = [55.7963, 49.1088];
const CLINIC = { lat: 55.760246, lng: 49.176412 };

describe('Яндекс Карты', () => {
  it('маршрут от точки до клиники: широта перед долготой, тип маршрута', () => {
    assert.equal(
      buildYandexRouteUrl(ORIGIN, [CLINIC], 'auto'),
      'https://yandex.ru/maps/?rtext=55.796300,49.108800~55.760246,49.176412&rtt=auto',
    );
    assert.match(buildYandexRouteUrl(ORIGIN, [CLINIC], 'transit'), /rtt=mt$/);
    assert.match(buildYandexRouteUrl(ORIGIN, [CLINIC], 'foot'), /rtt=pd$/);
    assert.match(buildYandexRouteUrl(ORIGIN, [CLINIC], 'bike'), /rtt=bc$/);
  });

  it('без точки отправления — «от моего местоположения», а не от центра города', () => {
    assert.equal(buildYandexRouteUrl(null, [CLINIC]), 'https://yandex.ru/maps/?rtext=~55.760246,49.176412&rtt=auto');
  });

  it('несколько точек маршрута идут через «~»', () => {
    const url = buildYandexRouteUrl(ORIGIN, [CLINIC, { lat: 55.8, lng: 49.13 }]);
    assert.equal(url.split('rtext=')[1].split('&')[0].split('~').length, 3);
  });

  it('без целей ссылки нет', () => {
    assert.equal(buildYandexRouteUrl(ORIGIN, []), null);
    assert.equal(buildYandexRouteUrl(ORIGIN, [{ lat: 'x', lng: 1 }]), null);
  });
});

describe('2ГИС', () => {
  it('долгота перед широтой и вкладка транспорта', () => {
    assert.equal(
      build2gisRouteUrl(ORIGIN, [CLINIC], 'auto'),
      'https://2gis.ru/kazan/directions/tab/car/points/49.108800,55.796300|49.176412,55.760246',
    );
    assert.match(build2gisRouteUrl(ORIGIN, [CLINIC], 'transit'), /\/tab\/bus\//);
    assert.match(build2gisRouteUrl(ORIGIN, [CLINIC], 'foot'), /\/tab\/pedestrian\//);
    assert.match(build2gisRouteUrl(ORIGIN, [CLINIC], 'bike'), /\/tab\/bicycle\//);
  });

  it('без точки отправления первая точка пустая', () => {
    assert.match(build2gisRouteUrl(null, [CLINIC]), /\/points\/\|49\.176412,55\.760246$/);
  });

  it('общая функция выбирает сервис', () => {
    assert.match(buildExternalRouteUrl('2gis', ORIGIN, [CLINIC], 'auto'), /^https:\/\/2gis\.ru\//);
    assert.match(buildExternalRouteUrl('yandex', ORIGIN, [CLINIC], 'auto'), /^https:\/\/yandex\.ru\//);
  });
});

describe('Переход к записи', () => {
  it('метка источника добавляется, чужая не перезаписывается', () => {
    assert.equal(withReferral('https://clinic.example/'), 'https://clinic.example/?utm_source=medkarta&utm_medium=referral&utm_campaign=card');
    assert.equal(withReferral('https://clinic.example/?utm_source=google'), 'https://clinic.example/?utm_source=google');
    assert.equal(withReferral('javascript:alert(1)'), null);
    assert.equal(withReferral(''), null);
  });

  it('подсказка ОМС: узкому специалисту нужно направление, терапевту — нет', () => {
    assert.equal(omsHint({ ownership: 'Частная', entityKind: 'doctor', doctorProfile: 'ЛОР' }), null);
    assert.equal(omsHint({ ownership: 'Государственная', entityKind: 'doctor', doctorProfile: 'Детский ЛОР' }).needsReferral, true);
    assert.equal(omsHint({ ownership: 'Государственная', entityKind: 'doctor', doctorProfile: 'Терапевт' }).needsReferral, false);
    assert.equal(omsHint({ ownership: 'Государственная', entityKind: 'doctor', doctorProfile: 'Педиатр' }).needsReferral, false);
    assert.match(omsHint({ ownership: 'Государственная', entityKind: 'facility' }).text, /прикреплённых/);
  });

  it('ссылка на запись через Госуслуги ведёт на gosuslugi.ru', () => {
    assert.match(GOSUSLUGI_APPOINTMENT_URL, /^https:\/\/www\.gosuslugi\.ru\//);
  });
});
