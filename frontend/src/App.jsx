/*
 * © 2026 МедКарта Казань. Все права защищены.
 * Этот код является интеллектуальной собственностью автора.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import {
  Bike,
  Building2,
  Car,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Clock,
  Footprints,
  Heart,
  HeartOff,
  Hospital,
  Loader2,
  MapPin,
  Moon,
  Navigation,
  RefreshCcw,
  Search,
  ShieldCheck,
  Star,
  Sun,
  TrendingUp,
  UserRound,
  XCircle,
  X,
  Bot,
  GripVertical,
  Phone,
  Globe,
  Share2,
  ExternalLink,
  Wallet,
  HelpCircle,
  Timer,
  Bus,
  CalendarCheck,
  ShieldPlus,
  FlaskConical,
  CircleUserRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Wrench,
} from 'lucide-react';
import { doctorsData } from '@data/doctors.legacy.js';
import { verifiedDoctors } from '@data/doctors';
import { kazanFacilities } from '@data/facilities.js';
import { ClinicsData } from '@data/clinics.js';
import collectedCatalog from '@data/private/catalog.json';
import verificationData from '@data/verification.json';
import { flattenPrivateCatalog } from '@shared/privateCatalog.js';
import Toast from './Toast';
import { useToast } from './hooks/useToast';
import SearchFilters from './SearchFilters';
import PlaceDoctorList from './PlaceDoctorList';
import { DataReportButton, SearchFeedbackPrompt } from './FeedbackWidgets';
import DmsPanel from './DmsPanel';
import { fetchServerConfig, loadDemoData, readDemoPreference, setDemoPreference } from './demoMode';
import MyBookingsPanel from './MyBookingsPanel';
import PlaceDetailsModal from './PlaceDetailsModal';
import DemoDoctorSchedule from './DemoDoctorSchedule';
import { fetchAccountBookings, isUpcomingBooking, readMyBookings, toStoredBooking, writeMyBookings } from './services/demoBooking';
import { resetAssistantSession } from './services/ai';
import { ForcedPasswordChange } from './ui/auth';
import { Avatar } from './ui/kit';
import { Link } from './ui/router';
import { coverageBadge, coverageFor, findPlan, findProvider } from '@shared/dms.js';
import { track } from './services/analytics';
import { buildExternalRouteUrl, EXTERNAL_MODE_BY_TRAVEL_MODE } from './externalMaps';
import { GOSUSLUGI_APPOINTMENT_URL, omsHint, withReferral } from './booking';
import { fetchTravelTimes } from './services/travelTimes';
import { describeCriteria, pickReasons, selectTopPicks, SORT_EXPLANATION, wantsTopPicks } from './bestPicks';
import { SORT_MODES } from '@shared/contract.js';
import { ownershipCode } from '@shared/analytics.js';
import { isPediatricRecord, specialtyCode } from '@shared/specialties.js';
import { parseOpeningHours, scheduleIntervals } from '@shared/openingHours.js';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { isBoolean, isPlanIdOrNull, isStringIdArray, useLocalStorageState } from './hooks/useLocalStorageState';
import { useAccount } from './hooks/useAccount';

// Помощник грузится отдельным чанком: большинство сессий открывают ради карты, а не чата.
const AIAssistant = lazy(() => import('./AIAssistant'));
const AccountPanel = lazy(() => import('./AccountPanel'));
const ChatLoginNotice = lazy(() => import('./ChatLoginNotice'));
const BookingDialog = lazy(() => import('./BookingDialog'));

delete L.Icon.Default.prototype._getIconUrl;

// L.divIcon вставляет строку через innerHTML: значения приводятся к безопасному
// виду, даже если сейчас сюда приходят только константы.
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
const sanitizeColor = (value) => (SAFE_COLOR.test(String(value)) ? String(value) : '#3b82f6');
const sanitizeLabel = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.slice(0, 2) : null;
};

const createBeautifulArrow = (rawColor, isUser = false, rawLabel = null) => {
  const color = sanitizeColor(rawColor);
  const label = sanitizeLabel(rawLabel);
  const size = isUser ? [26, 26] : [34, 46];
  const anchor = isUser ? [13, 13] : [17, 46];
  const popupAnchor = isUser ? [0, -13] : [0, -42];

  let innerContent = '<circle cx="12" cy="12" r="5" fill="white"/>';
  if (label) {
    innerContent = `
      <circle cx="12" cy="12" r="8" fill="white"/>
      <text x="12" y="15.5" font-family="Arial, sans-serif" font-weight="bold" font-size="10" text-anchor="middle" fill="${color}">${label}</text>
    `;
  }

  const svgHtml = isUser
    ? '<div class="user-location-marker"><div class="user-location-dot"></div></div>'
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="34" height="46" style="filter: drop-shadow(0px 3px 5px rgba(0,0,0,0.22));">
        <path d="M12 0C5.373 0 0 5.373 0 12c0 9.07 10.667 21.6 11.23 22.251a1 1 0 0 0 1.54 0C13.333 33.6 24 21.07 24 12c0-6.627-5.373-12-12-12z" fill="${color}" stroke="white" stroke-width="1.5"/>
        ${innerContent}
      </svg>`;

  return L.divIcon({
    html: svgHtml,
    className: isUser ? 'user-div-icon cursor-grab active:cursor-grabbing' : 'doctor-div-icon',
    iconSize: size,
    iconAnchor: anchor,
    popupAnchor,
  });
};
const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FAVORITES_STORAGE_KEY = 'med-navigator-favorites';
// Сколько ждать «устоявшейся» выдачи для подборки ассистента, мс.
const PICKS_MAX_WAIT_MS = 6000;

/** Инициалы для кнопки кабинета: «Анна (демо)» → «А», «Семья Демо» → «СД». */
const accountInitials = (name) =>
  String(name || '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '·';
const DARK_MODE_STORAGE_KEY = 'med-navigator-dark-mode';
// Без сохранённого выбора тема следует системной (см. public/theme-init.js).
const PREFERS_DARK = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
const MAX_ROUTE_STOPS = 5;
const PAGE_SIZE = 30;
const EMPTY_SERVICES = [];
const sortRu = (left, right) => String(left).localeCompare(String(right), 'ru');
const uniqueSorted = (values) => [...new Set(values.filter(Boolean))].sort(sortRu);

const TRAVEL_MODE_OPTIONS = [
  { id: 'driving', icon: Car, label: 'На автомобиле' },
  { id: 'foot', icon: Footprints, label: 'Пешком' },
  { id: 'bike', icon: Bike, label: 'На велосипеде' },
];

const blueArrowIcon = createBeautifulArrow('#3b82f6');

const violetArrowIcon = createBeautifulArrow('#8b5cf6');
const amberArrowIcon = createBeautifulArrow('#f59e0b');
const userDotIcon = createBeautifulArrow('#ef4444', true);
const hasGeolocationSupport = typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
const defaultLocation = [55.7963, 49.1088];
const institutionTypes = ['Клиника', 'Больница', 'Госпиталь', 'Медцентр', 'Поликлиника', 'Амбулатория', 'Медучреждение', 'Стоматология'];
const institutionTypeSet = new Set(institutionTypes);

const resolveFacilityType = (item) => {
  if (item.facilityType) {
    return item.facilityType;
  }

  if (institutionTypeSet.has(item.specialty)) {
    return item.specialty;
  }

  return 'Клиника';
};

const resolveDoctorProfile = (item) => {
  if (!item.specialty || institutionTypeSet.has(item.specialty)) {
    return null;
  }

  return item.specialty;
};

const normalizeScheduleValue = (value) => {
  if (value === null || value === undefined) {
    return 'Выходной';
  }

  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null') {
    return 'Выходной';
  }

  return text;
};

const extractClinicsSchedule = (doctorSchedule, clinicHours) => {
  const source = doctorSchedule || clinicHours;
  if (!source) {
    return null;
  }

  return {
    mon: normalizeScheduleValue(source.mon),
    tue: normalizeScheduleValue(source.tue),
    wed: normalizeScheduleValue(source.wed),
    thu: normalizeScheduleValue(source.thu),
    fri: normalizeScheduleValue(source.fri),
    sat: normalizeScheduleValue(source.sat),
    sun: normalizeScheduleValue(source.sun),
  };
};

const mapClinicsToFacilities = (payload) => {
  if (!payload || !Array.isArray(payload.clinics)) {
    return [];
  }

  const facilities = [];

  payload.clinics.forEach((clinic) => {
    const clinicTitle = clinic.branch_name ? `${clinic.name} (${clinic.branch_name})` : clinic.name;
    const clinicDoctors = Array.isArray(clinic.doctors) && clinic.doctors.length > 0 ? clinic.doctors : [null];

    clinicDoctors.forEach((doctor, index) => {
      // Клиника без списка врачей — карточка самой клиники, а не «Врач клиники №1».
      const doctorName = doctor?.full_name || (doctor ? `Врач клиники №${index + 1}` : clinicTitle);
      const specialty = doctor?.specialty || clinic.facility_type || 'Специалист';
      const website = clinic.website || '';
      const booking = clinic.booking_url || '';
      const phone = Array.isArray(clinic.phones) && clinic.phones.length > 0 ? clinic.phones[0] : '';
      const hoursRaw = doctor?.schedule?.raw || clinic.working_hours?.raw || 'График не указан';

      facilities.push({
        id: `clinics-${clinic.clinic_id}-${doctor?.doctor_id || index}`,
        name: doctorName,
        specialty,
        clinic: clinicTitle,
        address: clinic.address_full || '',
        district: clinic.district || '',
        ownership: clinic.ownership || 'Не определено',
        rating: 0,
        experience: doctor?.experience_years || 0,
        schedule: extractClinicsSchedule(doctor?.schedule, clinic.working_hours),
        hours: hoursRaw,
        phone,
        website,
        // Без повторов: specialty по умолчанию равна типу учреждения (иначе
        // «Клиника» дважды и дублирующиеся ключи React).
        services: [...new Set([clinic.facility_type, specialty].filter(Boolean))],
        features: {
          onlineBooking: Boolean(booking || website),
          wheelchair: false,
          parking: false,
          children: /дет/i.test(clinicTitle),
          eveningReception: false,
          weekendReception: false,
        },
        description: clinic.doctor_list_completeness === 'partial' ? 'Состав врачей частично подтвержден.' : 'Данные клиники подтверждены.',
        lat: clinic.coordinates?.lat,
        lng: clinic.coordinates?.lng,
        facilityType: clinic.facility_type || specialty,
        source: 'ClinicsData',
      });
    });
  });

  return facilities.filter((item) => typeof item.lat === 'number' && typeof item.lng === 'number');
};

const InitialCenterMap = ({ location }) => {
  const map = useMap();
  const doneRef = useRef(false);

  useEffect(() => {
    if (location && !doneRef.current) {
      doneRef.current = true;
      map.setView(location, 13, { animate: false });
    }
  }, [location, map]);

  return null;
};

/*
 * Окно маркера, открытое до появления панели маршрута («в маршрут» прямо в
 * окне), получает отступ справа и заново вписывается в видимую часть карты.
 */
const PopupPanGuard = ({ rightPadding }) => {
  const map = useMap();
  const popupRef = useRef(null);
  const paddingRef = useRef(rightPadding);

  // react-leaflet задаёт параметры окна один раз, при создании маркера, поэтому
  // отступ выставляется при каждом открытии окна и изменении панели.
  const fit = useCallback((popup) => {
    if (!popup?.isOpen()) return;
    popup.options.autoPanPaddingBottomRight = L.point(paddingRef.current, 24);
    popup.update();
  }, []);

  useEffect(() => {
    const onOpen = (event) => {
      popupRef.current = event.popup;
      fit(event.popup);
    };
    const onClose = (event) => {
      if (popupRef.current === event.popup) popupRef.current = null;
    };
    map.on('popupopen', onOpen);
    map.on('popupclose', onClose);
    return () => {
      map.off('popupopen', onOpen);
      map.off('popupclose', onClose);
    };
  }, [map, fit]);

  useEffect(() => {
    paddingRef.current = rightPadding;
    fit(popupRef.current);
  }, [rightPadding, fit]);

  return null;
};

const FlyToPoint = ({ target, onDone, offsetRatio = 0 }) => {
  const map = useMap();
  const prevTarget = useRef(null);
  useEffect(() => {
    if (target && target !== prevTarget.current) {
      prevTarget.current = target;
      const zoom = map.getZoom() < 14 ? 15 : map.getZoom();
      let center = target;
      if (offsetRatio > 0) {
        // Центр сдвигается вниз — точка оказывается выше середины экрана.
        const shifted = map.project(target, zoom).add([0, map.getSize().y * offsetRatio]);
        center = map.unproject(shifted, zoom);
      }
      map.flyTo(center, zoom, { duration: 1.0 });
      if (onDone) setTimeout(onDone, 1100);
    }
  }, [target, map, onDone, offsetRatio]);
  return null;
};

/*
 * Стабильные позиции и иконки маркеров. react-leaflet вызывает setLatLng() на
 * каждый новый массив позиции, даже с теми же числами; в кластере маркер при
 * этом переставляется и открытое окно закрывается (например, от сердечка в
 * нём). Поэтому на одни координаты — один массив, на один номер — одна иконка.
 */
const markerPositions = new Map();
const stablePosition = (key, lat, lng) => {
  let position = markerPositions.get(key);
  if (!position) {
    position = [lat, lng];
    markerPositions.set(key, position);
  }
  return position;
};

const routeIcons = new Map();
const routeIconFor = (number) => {
  let icon = routeIcons.get(number);
  if (!icon) {
    icon = createBeautifulArrow('#ef4444', false, String(number));
    routeIcons.set(number, icon);
  }
  return icon;
};

const InvalidateMapSize = () => {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      // Avoid ResizeObserver loop limit error
      window.requestAnimationFrame(() => {
        map.invalidateSize(false);
      });
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [map]);

  return null;
};

/** Понятная причина, по которой маршрут не построен. Коды — из backend/routing/engine.js. */
const ROUTE_ERROR_TEXT = {
  point_far_from_road_network: 'Точка слишком далеко от дорог',
  no_route_between_points: 'Для этого транспорта пути по дорогам нет',
  route_too_complex: 'Маршрут слишком длинный для расчёта',
  routing_graph_unavailable: 'Карта дорог не загружена на сервере',
  outside_region: 'Точка вне Казани и окрестностей — маршрут здесь не строится',
  rate_limited: 'Слишком много запросов маршрута — попробуйте через минуту',
  bad_request: 'Не удалось построить маршрут по этим точкам',
  server_error: 'Сервер маршрутов временно недоступен',
  timeout: 'Сервер маршрутов не ответил вовремя',
  offline: 'Нет соединения с интернетом',
  network: 'Нет связи с сервером маршрутов — проверьте интернет',
};

/* Ошибки, после которых имеет смысл просто повторить запрос. */
const RETRYABLE_ROUTE_ERRORS = new Set([null, undefined, 'rate_limited', 'server_error', 'timeout', 'offline', 'network', 'route_too_complex']);

/** Код ответа сервера маршрутов → причина для интерфейса. */
const routeFailureReason = (status, code) => {
  if (code) return code;
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'server_error';
  return null;
};

const ROUTE_TIMEOUT_MS = 15_000;
const routeErrorText = (routeData, targets, fallback) => {
  if (routeData?.reason === 'point_far_from_road_network' && Number.isInteger(routeData.point)) {
    if (routeData.point === 0) return 'Точка старта слишком далеко от дорог';
    const target = targets?.[routeData.point - 1];
    const label = target ? target.clinic || target.name : null;
    if (label) return `Точка «${label}» слишком далеко от дорог`;
  }
  return ROUTE_ERROR_TEXT[routeData?.reason] || fallback;
};

/** Причина, по которой маршрут не построен, и «Повторить» для временных сбоев. */
const RouteErrorNotice = ({ routeData, routeTargets, fallback, onRetry }) => (
  <div className="flex flex-col items-center gap-2" role="alert">
    <div className="text-sm font-medium text-red-500">{routeErrorText(routeData, routeTargets, fallback)}</div>
    {RETRYABLE_ROUTE_ERRORS.has(routeData?.reason) && (
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-50 dark:border-slate-600 dark:text-blue-400 dark:hover:bg-slate-700"
      >
        Повторить
      </button>
    )}
  </div>
);

const RoutingMachine = ({ originLocation, routeTargets, travelMode, routeData, setRouteData }) => {
  const map = useMap();
  const layerRef = useRef(null);
  /*
   * Повтор при неизменном наборе точек. Многие действия сбрасывают результат
   * (setRouteData(null)), не меняя ключ маршрута: выбор того же транспорта,
   * перестановка точек одной клиники. Сброшенный результат без запроса в
   * полёте означает «построй заново», иначе панель вечно показывает «Строим
   * маршрут...». Так же работает «Повторить».
   */
  const [attempt, setAttempt] = useState(0);
  const inFlightRef = useRef(false);

  // Стабилизация: округляем координаты до 4 знаков (~11 метров), чтобы
  // дрожание геолокации не перестраивало маршрут на каждом обновлении.
  const roundCoord = (val) => Number(Number(val).toFixed(4));
  const routeKey = JSON.stringify({
    o: originLocation ? [roundCoord(originLocation[0]), roundCoord(originLocation[1])] : null,
    t: (routeTargets || []).map((r) => [roundCoord(r.lat), roundCoord(r.lng)]),
    m: travelMode,
  });

  useEffect(() => {
    const clear = () => {
      if (layerRef.current && map) {
        map.removeLayer(layerRef.current);
      }
      layerRef.current = null;
    };

    if (!map || !originLocation || !routeTargets || routeTargets.length === 0) {
      clear();
      return undefined;
    }

    const lineColors = { driving: '#3b82f6', foot: '#10b981', bike: '#a855f7' };
    const mode = lineColors[travelMode] ? travelMode : 'driving';

    const waypoints = [
      { lat: originLocation[0], lng: originLocation[1] },
      ...routeTargets.map((t) => ({ lat: t.lat, lng: t.lng })),
    ];

    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    inFlightRef.current = true;
    // Без предела ожидания зависший сервер оставит «Строим маршрут...» навсегда.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ROUTE_TIMEOUT_MS);

    /*
     * Маршрут строит наш сервер (backend/routing), а не сторонний сервис:
     * координаты пользователя и точек дальше бэкенда не уходят (языковая
     * модель и так получает @HOME вместо адреса).
     */
    const draw = async () => {
      try {
        const response = await fetch('/api/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify({ waypoints, profile: mode }),
        });

        if (cancelled) return;

        if (!response.ok) {
          // Прямую между точками не рисуем: линия через дома и реку выглядит
          // как маршрут. Показываем причину отказа.
          const failure = await response.json().catch(() => null);
          if (cancelled) return;
          clear();
          setRouteData({
            distance: 0,
            time: 0,
            error: true,
            reason: routeFailureReason(response.status, failure?.code),
            point: Number.isInteger(failure?.point) ? failure.point : null,
          });
          return;
        }

        const payload = await response.json();
        if (cancelled) return;
        if (!Array.isArray(payload.geometry) || payload.geometry.length < 2) {
          clear();
          setRouteData({ distance: 0, time: 0, error: true, reason: null });
          return;
        }

        clear();
        const group = L.layerGroup();
        L.polyline(payload.geometry, {
          color: lineColors[mode],
          weight: 6,
          opacity: 0.9,
        }).addTo(group);

        // Короткая пунктирная «подводка» от здания до места, где маршрут
        // выходит на дорогу, — как в навигаторах. Сам маршрут идёт по улицам.
        (payload.snaps || []).forEach((snap, index) => {
          const point = waypoints[index];
          if (!point || !(snap?.distanceM > 10)) return;
          L.polyline([[point.lat, point.lng], [snap.lat, snap.lng]], {
            color: '#64748b',
            weight: 3,
            opacity: 0.8,
            dashArray: '2 7',
            lineCap: 'round',
          }).addTo(group);
        });

        layerRef.current = group.addTo(map);

        setRouteData({ distance: payload.distance, time: payload.time, error: false });
      } catch (error) {
        if (cancelled) return;
        if (error?.name === 'AbortError' && !timedOut) return;
        clear();
        const reason = timedOut ? 'timeout' : typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'network';
        setRouteData({ distance: 0, time: 0, error: true, reason });
      } finally {
        clearTimeout(timer);
        if (!cancelled) inFlightRef.current = false;
      }
    };

    draw();

    return () => {
      cancelled = true;
      inFlightRef.current = false;
      clearTimeout(timer);
      controller.abort();
      clear();
    };
    // routeKey заменяет список зависимостей: это огрублённый снимок входных данных.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, routeKey, attempt]);

  // Объявлен после эффекта запроса: если ключ сменился в том же рендере,
  // запрос уже в полёте и повтор не нужен.
  useEffect(() => {
    if (routeData === null && !inFlightRef.current && originLocation && routeTargets?.length > 0) {
      setAttempt((value) => value + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeData]);

  return null;
};

const normalizeText = (value) => (value ? value.toString().toLowerCase() : '');

const normalizeClinicKey = (value) =>
  (value || '')
    .toString()
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/*
 * Охват дня (начало первого интервала — конец последнего) — для сортировки и
 * фильтра «вечерний приём». Для «открыто сейчас» он не годится: у
 * «09:00-12:30,13:00-17:30» закрывает перерыв, там нужны сами интервалы.
 */
const scheduleTextToRange = (value) => {
  const intervals = scheduleIntervals(value);
  if (!intervals) return null;
  return {
    start: Math.min(...intervals.map((interval) => interval.start)),
    end: Math.max(...intervals.map((interval) => interval.end)),
  };
};

// У многих объектов из OpenStreetMap графика в данных нет (schedule: null):
// UNKNOWN отделяет «точно закрыто» от «не знаем», чтобы не показывать «Закрыто».
const OPEN_STATE = { OPEN: 'open', CLOSED: 'closed', UNKNOWN: 'unknown' };

// Расписание учреждений из OSM восстанавливается из исходной строки часов:
// импортированное по дням теряет выходные даже у «Mo-Su» и круглосуточных.
const withOsmSchedule = (item) => {
  const parsed = parseOpeningHours(item.hours);
  return parsed ? { ...item, schedule: parsed } : item;
};

/*
 * Часы в справочнике — казанские, поэтому «открыто сейчас» считается не по поясу
 * устройства. kazanWallClock возвращает Date, у которого getDay/getHours/getMinutes
 * дают московское время, — только для сравнения с расписанием, не для хранения.
 */
const MOSCOW_CLOCK = (() => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }
})();

const kazanWallClock = (date = new Date()) => {
  if (!MOSCOW_CLOCK) return date;
  const parts = Object.fromEntries(MOSCOW_CLOCK.formatToParts(date).map((part) => [part.type, part.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
};

const hasAnyScheduleData = (schedule) =>
  Boolean(schedule) && dayKeys.some((dayKey) => {
    const value = schedule[dayKey];
    return typeof value === 'string' && value.trim().length > 0;
  });

const resolveOpenState = (schedule, now) => {
  if (!hasAnyScheduleData(schedule)) {
    return OPEN_STATE.UNKNOWN;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const today = scheduleIntervals(schedule[dayKeys[now.getDay()]]) || [];
  if (today.some((interval) => currentMinutes >= interval.start && currentMinutes < interval.end)) {
    return OPEN_STATE.OPEN;
  }

  // Вчерашняя смена, перешедшая за полночь: «пт 20:00-08:00» в субботу в 03:00.
  const yesterday = scheduleIntervals(schedule[dayKeys[(now.getDay() + 6) % 7]]) || [];
  if (yesterday.some((interval) => interval.end > 24 * 60 && currentMinutes + 24 * 60 < interval.end)) {
    return OPEN_STATE.OPEN;
  }

  return OPEN_STATE.CLOSED;
};

const isWeekendReception = (schedule) => {
  if (!schedule) {
    return false;
  }

  return Boolean(schedule.sat && !/выход/i.test(schedule.sat)) || Boolean(schedule.sun && !/выход/i.test(schedule.sun));
};

const hasEveningReception = (schedule) => {
  if (!schedule) {
    return false;
  }

  return dayKeys.some((dayKey) => {
    const range = scheduleTextToRange(schedule[dayKey]);
    return range && range.end >= 20 * 60;
  });
};

const getTodaySchedule = (schedule, now) => {
  if (!schedule) {
    return 'График уточняется';
  }

  const today = schedule[dayKeys[now.getDay()]];
  const intervals = scheduleIntervals(today);
  if (intervals?.length === 1 && intervals[0].start === 0 && intervals[0].end === 24 * 60) return 'Круглосуточно';
  // «09:00-12:30,13:00-17:30» — с пробелом, чтобы перерыв читался.
  return today ? today.replace(/,(?=\d)/g, ', ') : 'График уточняется';
};

const WEEK_DAY_LABELS = {
  mon: 'Понедельник',
  tue: 'Вторник',
  wed: 'Среда',
  thu: 'Четверг',
  fri: 'Пятница',
  sat: 'Суббота',
  sun: 'Воскресенье',
};
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const buildWeekSchedule = (schedule, now) => {
  if (!hasAnyScheduleData(schedule)) {
    return null;
  }

  const todayKey = dayKeys[now.getDay()];
  return WEEK_ORDER.map((dayKey) => ({
    key: dayKey,
    label: WEEK_DAY_LABELS[dayKey],
    value: schedule[dayKey] || 'Не указано',
    isToday: dayKey === todayKey,
    isDayOff: /выход/i.test(String(schedule[dayKey] || '')),
  }));
};

// --- Контакты -------------------------------------------------------------

// tel: не переносит пробелы и скобки — в ссылку идёт только «+» и цифры,
// а на экране остаётся человекочитаемый вид из данных.
const toTelHref = (phone) => {
  // Несколько номеров через «;» — звоним по первому; «+» допустим только в начале
  // (иначе из «…//+7 843…» получится «tel:5+7843…»).
  const raw = String(phone || '').split(/[;,]/)[0].trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  return `tel:${raw.startsWith('+') ? '+' : ''}${digits}`;
};

/** Enter и пробел на элементе с role="button" — как клик, для клавиатуры. */
const activateOnKey = (action) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
};

// Ссылка из данных считается недоверенной: разрешаем только http(s),
// чтобы исключить javascript: и data: в href.
const toSafeUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const formatPriceRange = (entry) => {
  if (!entry) return null;
  const min = Number(entry.minRub);
  const max = Number(entry.maxRub);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;

  const format = (value) => new Intl.NumberFormat('ru-RU').format(Math.round(value));
  // «от 1 000 ₽» — нижняя граница из прайса, показывать её как точную цену нельзя.
  const prefix = entry.from ? 'от ' : '';
  if (Number.isFinite(min) && Number.isFinite(max) && min !== max) {
    return `${prefix}${format(min)}–${format(max)} ₽`;
  }
  return `${prefix}${format(Number.isFinite(min) ? min : max)} ₽`;
};

// --- Внешние карты, запись и время в пути ---------------------------------

/*
 * Оценка по прямой, пока сервер считает время в пути (или если он недоступен).
 * Скорости — как у серверной оценки по прямой (backend/executor/routing.js);
 * поправка на извилистость улиц 1,3 добавляется только здесь.
 */
const FALLBACK_SPEED_KMH = { driving: 28, bike: 14, foot: 4.5 };
const DETOUR_FACTOR = 1.3;
const TRAVEL_MODE_LABEL = { driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' };
const MAX_TRAVEL_POINTS = 600;

const pointKey = (lat, lng) => `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

/** Тот же формат идентификатора места, что принимает сервер аналитики. */
const PLACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;

const formatVerifiedAt = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
};

const daysSince = (value, now) => {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00+03:00`) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
};

/** Через сколько дней без проверки запись считается устаревшей. */
const STALE_AFTER_DAYS = 60;

// --- Состояние в адресной строке -----------------------------------------

/*
 * Фильтры живут в URL, чтобы ссылку можно было переслать. Параметры адресной
 * строки — недоверенный ввод: перечисления сверяются со списком, числа
 * зажимаются в диапазон, строки обрезаются.
 */
const URL_KEYS = {
  q: 'q',
  clinic: 'clinic',
  district: 'district',
  facilityType: 'type',
  doctorProfile: 'profile',
  ownership: 'owner',
  cardDisplayMode: 'show',
  sortBy: 'sort',
  services: 'services',
  minRating: 'rating',
  minExperience: 'exp',
  maxDistance: 'dist',
  maxTravel: 'travel',
  flags: 'flags',
  focus: 'doc',
};

const FLAG_KEYS = ['open', 'fav', 'weekend', 'evening', 'online', 'wheelchair', 'children', 'dms'];

const DMS_PLAN_STORAGE_KEY = 'medkarta.dms.plan';

/*
 *   GUEST_STASH_KEY   — избранное и ДМС гостя, отложенные на время входа в
 *                       демо-аккаунт; после выхода они возвращаются.
 *   ACCOUNT_OWNED_KEY — избранное и ДМС в localStorage сейчас принадлежат
 *                       аккаунту: если сессия кончилась, пока сайт был
 *                       закрыт, при следующем открытии их нужно убрать.
 */
const GUEST_STASH_KEY = 'medkarta.guest-stash';
const ACCOUNT_OWNED_KEY = 'medkarta.account-owned';

const readStorage = (key) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key, value) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Приватный режим или переполненное хранилище: кабинет работает и без этого.
  }
};

const readGuestStash = () => {
  try {
    const parsed = JSON.parse(readStorage(GUEST_STASH_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      favorites: isStringIdArray(parsed.favorites) ? [...new Set(parsed.favorites)].slice(0, 500) : [],
      dmsPlanId: isPlanIdOrNull(parsed.dmsPlanId) ? parsed.dmsPlanId : null,
    };
  } catch {
    return null;
  }
};

const unionIds = (...lists) => [...new Set(lists.flat())].slice(0, 500);

// Частные клиники, собранные сборщиком (npm run data:build), и результаты
// проверки госврачей на сайтах учреждений (npm run data:verify).
const COLLECTED_FACILITIES = flattenPrivateCatalog(collectedCatalog);
const VERIFICATION = verificationData?.results && typeof verificationData.results === 'object' ? verificationData.results : {};
const EMPTY_LIST = Object.freeze([]);
/*
 * booking — симуляция записи включена на сервере; publicClinics — показывать
 * государственные учреждения (в демо по умолчанию скрыты, данные не удаляются).
 */
const EMPTY_DEMO = Object.freeze({ enabled: false, items: EMPTY_LIST, insurance: null, booking: false, publicClinics: true, demoOnly: false });
const PUBLIC_OWNERSHIP = 'Государственная';

/** Варианты фильтра «не дольше N минут в пути». */
const TRAVEL_LIMIT_OPTIONS = [10, 15, 20, 30, 45, 60];

const readUrlState = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  const params = new URLSearchParams(window.location.search);
  const text = (key, maxLength = 80) => {
    const value = params.get(URL_KEYS[key]);
    return value ? value.slice(0, maxLength) : null;
  };
  const number = (key, min, max) => {
    const value = Number(params.get(URL_KEYS[key]));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  };
  const oneOf = (key, allowed) => {
    const value = params.get(URL_KEYS[key]);
    return value && allowed.includes(value) ? value : null;
  };

  const flags = new Set((params.get(URL_KEYS.flags) || '').split(',').filter((f) => FLAG_KEYS.includes(f)));

  return {
    q: text('q', 100),
    clinic: text('clinic'),
    district: text('district'),
    facilityType: text('facilityType'),
    doctorProfile: text('doctorProfile'),
    ownership: oneOf('ownership', ['Государственная', 'Частная']),
    cardDisplayMode: oneOf('cardDisplayMode', ['all', 'doctor', 'facility']),
    sortBy: oneOf('sortBy', SORT_MODES),
    services: (params.get(URL_KEYS.services) || '')
      .split('|')
      .map((s) => s.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 6),
    minRating: number('minRating', 0, 5),
    minExperience: number('minExperience', 0, 40),
    maxDistance: number('maxDistance', 0, 50),
    maxTravel: TRAVEL_LIMIT_OPTIONS.includes(Number(params.get(URL_KEYS.maxTravel))) ? Number(params.get(URL_KEYS.maxTravel)) : 0,
    focus: text('focus', 120),
    flags,
  };
};

const buildUrlQuery = (state) => {
  const params = new URLSearchParams();
  const put = (key, value, skip) => {
    if (value !== null && value !== undefined && value !== '' && value !== skip) {
      params.set(URL_KEYS[key], String(value));
    }
  };

  put('q', state.q);
  put('clinic', state.clinic, 'all');
  put('district', state.district, 'all');
  put('facilityType', state.facilityType, 'all');
  put('doctorProfile', state.doctorProfile, 'all');
  put('ownership', state.ownership, 'all');
  put('cardDisplayMode', state.cardDisplayMode, 'all');
  put('sortBy', state.sortBy, 'recommendation');
  put('minRating', state.minRating || null, 0);
  put('minExperience', state.minExperience || null, 0);
  put('maxDistance', state.maxDistance || null, 0);
  put('maxTravel', state.maxTravel || null, 0);
  put('focus', state.focus);

  if (state.services?.length) {
    params.set(URL_KEYS.services, state.services.join('|'));
  }
  if (state.flags?.length) {
    params.set(URL_KEYS.flags, state.flags.join(','));
  }

  return params.toString();
};

const INITIAL_URL_STATE = readUrlState();

const calculateDistanceKm = (origin, target) => {
  if (!origin || !target) {
    return null;
  }

  const [lat1, lon1] = origin;
  const [lat2, lon2] = target;
  const earthRadius = 6371;
  const toRadians = (value) => (value * Math.PI) / 180;

  const latDelta = toRadians(lat2 - lat1);
  const lonDelta = toRadians(lon2 - lon1);
  const a =
    Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(lonDelta / 2) * Math.sin(lonDelta / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadius * c;
};

const pluralYears = (count) => {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'лет';
  if (count % 10 === 1) return 'год';
  if (count % 10 >= 2 && count % 10 <= 4) return 'года';
  return 'лет';
};

const formatDistance = (meters) => {
  if (meters == null) {
    return '—';
  }

  if (meters < 1000) {
    return `${Math.round(meters)} м`;
  }

  return `${(meters / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} км`;
};

const formatTime = (seconds) => {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} мин`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours} ч ${mins} мин`;
};

const stopsWord = (count) => (count % 10 === 1 && count % 100 !== 11 ? 'точка' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'точки' : 'точек');

/**
 * Маршрут одной строкой: время и расстояние, развернуть подробности, сбросить.
 * Подробное окно (точки, вид транспорта, Яндекс Карты и 2ГИС) — по нажатию.
 */
function RoutePill({ count, routeData, expanded, onToggle, onClear, className = '' }) {
  const status = !routeData ? 'loading' : routeData.error ? 'error' : 'ready';
  return (
    <div className={`flex items-center rounded-2xl border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-800/95 ${className}`} data-testid="route-pill">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? 'Свернуть маршрут' : 'Подробнее о маршруте'}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-0.5 pl-1 pr-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-700"
        data-testid="route-pill-toggle"
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
          <Navigation size={14} aria-hidden="true" />
        </span>
        <span className="min-w-0 leading-tight">
          <span className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            Маршрут{count > 1 ? ` · ${count} ${stopsWord(count)}` : ''}
          </span>
          {status === 'ready' && (
            <span className="block whitespace-nowrap text-[13px] font-bold text-slate-800 dark:text-white">
              {formatTime(routeData.time)} <span className="font-medium text-slate-500 dark:text-slate-400">· {formatDistance(routeData.distance)}</span>
            </span>
          )}
          {status === 'error' && <span className="block whitespace-nowrap text-[13px] font-semibold text-red-600 dark:text-red-400">Не построен — подробнее</span>}
          {status === 'loading' && (
            <span className="flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-slate-500 dark:text-slate-400">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Строю…
            </span>
          )}
        </span>
        {expanded ? <ChevronUp size={15} className="shrink-0 text-slate-400" aria-hidden="true" /> : <ChevronDown size={15} className="shrink-0 text-slate-400" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Сбросить маршрут"
        title="Сбросить маршрут"
        className="ml-0.5 shrink-0 rounded-xl p-2 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30"
        data-testid="route-pill-clear"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function App() {
  const [userLocation, setUserLocation] = useState(defaultLocation);
  const [routeTargets, setRouteTargets] = useState([]);
  const [searchQuery, setSearchQuery] = useState(INITIAL_URL_STATE.q || '');
  const [locationError, setLocationError] = useState(!hasGeolocationSupport);
  const [isFollowingUser, setIsFollowingUser] = useState(true);
  const [flyToTarget, setFlyToTarget] = useState(null);
  const [customOrigin, setCustomOrigin] = useState(null);
  const [isManualOrigin, setIsManualOrigin] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [isDraggingPanel, setIsDraggingPanel] = useState(false);
  const [travelMode, setTravelMode] = useState('driving');
  const [routeData, setRouteData] = useState(null);
  const [isRouteStarted, setIsRouteStarted] = useState(false);
  // «Маршрут начат» имеет смысл, только пока в нём есть точки.
  const routeStarted = isRouteStarted && routeTargets.length > 0;
  const [sortBy, setSortBy] = useState(INITIAL_URL_STATE.sortBy || 'recommendation');
  const [selectedFacilityType, setSelectedFacilityType] = useState(INITIAL_URL_STATE.facilityType || 'all');
  const [selectedClinic, setSelectedClinic] = useState(INITIAL_URL_STATE.clinic || 'all');
  const [selectedDistrict, setSelectedDistrict] = useState(INITIAL_URL_STATE.district || 'all');
  const [selectedDoctorProfile, setSelectedDoctorProfile] = useState(INITIAL_URL_STATE.doctorProfile || 'all');
  const [selectedOwnership, setSelectedOwnership] = useState(INITIAL_URL_STATE.ownership || 'all');
  const [cardDisplayMode, setCardDisplayMode] = useState(INITIAL_URL_STATE.cardDisplayMode || 'all');
  const [selectedServices, setSelectedServices] = useState(INITIAL_URL_STATE.services || []);
  const [favoritesOnly, setFavoritesOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('fav')));
  const [openOnly, setOpenOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('open')));
  const [weekendOnly, setWeekendOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('weekend')));
  const [eveningOnly, setEveningOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('evening')));
  const [onlineOnly, setOnlineOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('online')));
  const [wheelchairOnly, setWheelchairOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('wheelchair')));
  const [childrenOnly, setChildrenOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('children')));
  const [minRating, setMinRating] = useState(INITIAL_URL_STATE.minRating ?? 0);
  const [minExperience, setMinExperience] = useState(INITIAL_URL_STATE.minExperience ?? 0);
  const [maxDistance, setMaxDistance] = useState(INITIAL_URL_STATE.maxDistance ?? 0);
  const [maxTravelMinutes, setMaxTravelMinutes] = useState(INITIAL_URL_STATE.maxTravel ?? 0);
  // Демо-набор (вымышленные частные клиники и ДМС) и выбранная программа ДМС.
  // В браузере хранится только id программы — см. DmsPanel.
  const [demoState, setDemoState] = useState(EMPTY_DEMO);
  const [dmsPlanId, setDmsPlanId] = useLocalStorageState(DMS_PLAN_STORAGE_KEY, null, isPlanIdOrNull);
  const [dmsOnly, setDmsOnly] = useState(() => Boolean(INITIAL_URL_STATE.flags?.has('dms')));
  const [isDmsPanelOpen, setIsDmsPanelOpen] = useState(false);
  const [dmsPromptPending, setDmsPromptPending] = useState(false);
  // Время в пути от точки отправления до каждого адреса — для фильтра
  // «не дольше N минут». Считает сервер по графу дорог.
  const [travelTimes, setTravelTimes] = useState({ key: null, status: 'idle', byPoint: null });
  // Откуда пришёл последний поиск: от ассистента, из ссылки или из фильтров.
  const searchSourceRef = useRef({ source: INITIAL_URL_STATE.q || INITIAL_URL_STATE.doctorProfile ? 'url' : 'filters', at: Date.now() });
  // Избранное и тема читаются из localStorage через валидатор: испорченное или
  // подменённое значение иначе роняет приложение на favorites.includes(...).
  const [favorites, setFavorites] = useLocalStorageState(FAVORITES_STORAGE_KEY, [], isStringIdArray);
  // Сохранённый список мог разрастись повторами (или быть подменён):
  // он пересохраняется при каждом нажатии на сердечко.
  useEffect(() => {
    setFavorites((current) => {
      const unique = [...new Set(current)].slice(0, 500);
      return unique.length === current.length ? current : unique;
    });
  }, [setFavorites]);
  const [now, setNow] = useState(() => kazanWallClock());
  const [isLocationReady, setIsLocationReady] = useState(!hasGeolocationSupport);
  const { toast, showToast, dismiss: dismissToast } = useToast();

  /*
   * До входа избранное и программа ДМС живут в браузере; после входа источник
   * правды — аккаунт (избранное браузера сливается с ним, программа берётся из
   * него). Демо-аккаунт общий для всех зрителей: данные гостя в него не
   * переносятся, а откладываются и возвращаются после выхода.
   */
  const favoritesRef = useRef(favorites);
  const dmsPlanIdRef = useRef(dmsPlanId);
  const accountRef = useRef(null);
  // Сброс данных, которые не должны переходить к другому владельцу (задаётся ниже).
  const accountSwitchRef = useRef(null);
  useEffect(() => {
    favoritesRef.current = favorites;
  }, [favorites]);
  useEffect(() => {
    dmsPlanIdRef.current = dmsPlanId;
  }, [dmsPlanId]);

  const handleSignedIn = useCallback((payload, origin) => {
    if (origin === 'login') accountSwitchRef.current?.();
    const remote = Array.isArray(payload.favorites) ? payload.favorites : [];
    const remotePlan = payload.user?.dmsPlanId || null;
    const local = favoritesRef.current;
    const localPlan = dmsPlanIdRef.current;
    // Данные гостя — только если до входа браузер не держал данные другого аккаунта.
    const fromGuest = origin === 'login' && readStorage(ACCOUNT_OWNED_KEY) !== '1';
    const isDemo = Boolean(payload.user?.isDemo);
    let stashed = false;

    if (isDemo || !fromGuest) {
      if (isDemo && fromGuest && (local.length > 0 || localPlan)) {
        writeStorage(GUEST_STASH_KEY, JSON.stringify({ favorites: local, dmsPlanId: localPlan }));
        stashed = true;
      }
      setFavorites(remote);
      setDmsPlanId(remotePlan);
    } else {
      if (local.length > 0) {
        // Сразу показываем объединение, ответ сервера его уточнит.
        setFavorites(unionIds(remote, local));
        accountRef.current?.syncFavorites('merge', local).then(setFavorites, (error) => {
          if (error?.status === 401) return;
          showToast('Не удалось перенести избранное этого браузера в кабинет — оно осталось здесь.', 'warning');
        });
      } else {
        setFavorites(remote);
      }
      if (remotePlan) {
        setDmsPlanId(remotePlan);
      } else if (localPlan) {
        accountRef.current?.setPlan(localPlan).catch(() => {});
      }
    }
    writeStorage(ACCOUNT_OWNED_KEY, '1');
    if (origin === 'login') {
      showToast(stashed
        ? `Вы вошли: ${payload.user.displayName}. Ваше избранное и ДМС вернутся после выхода.`
        : `Вы вошли: ${payload.user.displayName}`, 'success');
    }
  }, [setFavorites, setDmsPlanId, showToast]);

  // Убрать с устройства данные аккаунта; вернуть отложенные данные гостя, если они есть.
  const releaseAccountData = useCallback(() => {
    const stash = readGuestStash();
    writeStorage(GUEST_STASH_KEY, null);
    writeStorage(ACCOUNT_OWNED_KEY, null);
    setFavorites(stash?.favorites || []);
    setDmsPlanId(stash?.dmsPlanId || null);
    setDmsOnly(false);
    return Boolean(stash);
  }, [setFavorites, setDmsPlanId]);

  const handleSignedOut = useCallback((reason) => {
    // На общем устройстве после выхода не должно оставаться чужих данных.
    accountSwitchRef.current?.();
    const restored = releaseAccountData();
    if (reason === 'expired') {
      showToast('Сессия кабинета закончилась — войдите снова. Избранное и ДМС сохранены в аккаунте.', 'warning');
    } else if (reason === 'deleted') {
      showToast('Аккаунт удалён вместе с избранным и программой ДМС.', 'info');
    } else if (restored) {
      showToast('Вы вышли из демо-аккаунта. Вернули ваше избранное и ДМС.', 'info');
    } else {
      showToast('Вы вышли из кабинета. Избранное и ДМС сохранены в аккаунте.', 'info');
    }
  }, [releaseAccountData, showToast]);

  // Сайт открыт, а входа нет: если сессия кончилась, пока он был закрыт, — прибраться.
  const handleGuest = useCallback(() => {
    if (readStorage(ACCOUNT_OWNED_KEY) === '1') releaseAccountData();
  }, [releaseAccountData]);

  const account = useAccount({ onSignedIn: handleSignedIn, onSignedOut: handleSignedOut, onGuest: handleGuest });
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
  const [mobileSheetDragOffset, setMobileSheetDragOffset] = useState(0);
  const [isDarkMode, setIsDarkMode] = useLocalStorageState(DARK_MODE_STORAGE_KEY, PREFERS_DARK, isBoolean);

  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false);
  // После первого открытия ассистент остаётся смонтированным и прячется, а не
  // уничтожается: иначе каждое закрытие стирает переписку.
  const [isAIAssistantMounted, setIsAIAssistantMounted] = useState(false);
  /*
   * Ассистент — только для вошедших в кабинет (сервер проверяет то же,
   * backend/api/chatAccess.js). Гость вместо чата видит предупреждение с
   * кнопкой входа; после входа из него чат открывается сам.
   */
  const [isChatNoticeOpen, setIsChatNoticeOpen] = useState(false);
  // Выключен в настройках админ-панели (значение приходит из /api/config ниже).
  const assistantDisabledRef = useRef(false);
  const [chatAfterSignIn, setChatAfterSignIn] = useState(false);
  const canUseAssistant = account.status === 'user' || account.features.chatRequiresAccount === false;
  const toggleAIAssistant = useCallback(() => {
    if (isAIAssistantOpen) {
      setIsAIAssistantOpen(false);
      return;
    }
    if (assistantDisabledRef.current) {
      showToast('Ассистент временно отключён администратором. Поиск и карта работают.', 'warning');
      return;
    }
    if (!canUseAssistant) {
      setIsChatNoticeOpen(true);
      return;
    }
    setIsAIAssistantMounted(true);
    setIsAIAssistantOpen(true);
  }, [isAIAssistantOpen, canUseAssistant, showToast]);
  const signInForAssistant = useCallback(() => {
    setIsChatNoticeOpen(false);
    setChatAfterSignIn(true);
    setIsAccountOpen(true);
  }, []);
  const closeAccountPanel = useCallback(() => {
    setIsAccountOpen(false);
    setChatAfterSignIn(false);
  }, []);
  useEffect(() => {
    if (account.status !== 'user' || !chatAfterSignIn) return;
    setChatAfterSignIn(false);
    setIsAccountOpen(false);
    setIsAIAssistantMounted(true);
    setIsAIAssistantOpen(true);
  }, [account.status, chatAfterSignIn]);
  // Ассистент ответил «нет входа»: сессия истекла или стёрта — выходим из кабинета и здесь.
  const handleAssistantLoginRequired = useCallback(() => {
    if (accountRef.current?.status === 'user') accountRef.current.expire?.();
    setIsAIAssistantOpen(false);
    setIsChatNoticeOpen(true);
  }, []);
  // Маршрут — компактной строкой; подробное окно открывается по нажатию.
  const [isRoutePanelCollapsed, setIsRoutePanelCollapsed] = useState(true);
  /*
   * «Топ-3» под ответами ассистента: id реплики → подборка. Подборка — снимок
   * на момент ответа: если потом поменять фильтры, старый ответ не меняется.
   */
  const [assistantPicks, setAssistantPicks] = useState({});
  /*
   * Демо-запись под ответами ассистента: id реплики → запрос строгого
   * подбора. Подбор исполняет сервер (DemoOffers → /api/demo/search).
   */
  const [assistantBookings, setAssistantBookings] = useState({});
  const bookingEnabledRef = useRef(false);
  const [bookingTarget, setBookingTarget] = useState(null);
  // Окно подробностей карточки: в списке — кратко, всё остальное — здесь.
  const [detailsId, setDetailsId] = useState(null);
  // Записи кабинета хранит сервер, записи гостя — этот браузер (см. эффекты ниже).
  const [myBookings, setMyBookings] = useState(EMPTY_LIST);
  const [bookingsRefresh, setBookingsRefresh] = useState(0);
  const [isMyBookingsOpen, setIsMyBookingsOpen] = useState(false);
  // Значок считает только предстоящие подтверждённые: прошедшие и пропавшие после сброса демо — нет.
  const upcomingBookings = myBookings.filter((item) => isUpcomingBooking(item)).length;
  // Ключ окна ассистента: после входа или выхода переписка начинается заново.
  const [assistantEpoch, setAssistantEpoch] = useState(0);
  const pendingPicksRef = useRef(null);
  const [picksTick, setPicksTick] = useState(0);
  const [buildRouteTrigger, setBuildRouteTrigger] = useState(false);
  const [targetStopsTrigger, setTargetStopsTrigger] = useState(null);

  /*
   * Вход и выход меняют владельца данных: переписка с ассистентом, подборки
   * под ней, открытое окно записи и номер диалога для сервера не переходят
   * к другому аккаунту или к гостю.
   */
  useEffect(() => {
    accountSwitchRef.current = () => {
      setIsAIAssistantOpen(false);
      setIsChatNoticeOpen(false);
      setAssistantPicks({});
      setAssistantBookings({});
      setAssistantEpoch((value) => value + 1);
      setBookingTarget(null);
      pendingPicksRef.current = null;
      resetAssistantSession();
    };
  }, []);

  // Чьи записи показывать: «user:<email>», «guest» или «loading» (пока неизвестно — никаких).
  const bookingsOwner = account.status === 'user' ? `user:${account.user?.email || ''}` : account.status;
  useEffect(() => {
    if (bookingsOwner === 'guest') setMyBookings(readMyBookings());
    else setMyBookings(EMPTY_LIST);
  }, [bookingsOwner]);
  useEffect(() => {
    if (!bookingsOwner.startsWith('user:') || !demoState.booking) return undefined;
    const controller = new AbortController();
    fetchAccountBookings({ signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setMyBookings((payload?.bookings || []).map(toStoredBooking).filter(Boolean));
      })
      .catch(() => {
        // Нет связи или сессия кончилась: список кабинета просто не обновился.
      });
    return () => controller.abort();
  }, [bookingsOwner, bookingsRefresh, demoState.booking]);

  // Справочники в ref: handleApplyTriage не должен пересоздаваться на каждый
  // пересчёт списков, иначе AIAssistant перерисовывается впустую.
  const districtSetRef = useRef(new Set());
  const clinicSetRef = useRef(new Set());
  const facilityTypeSetRef = useRef(new Set());
  const doctorProfileSetRef = useRef(new Set());
  const serviceSetRef = useRef(new Set());

  const handleApplyTriage = useCallback((result, meta = {}) => {
    searchSourceRef.current = { source: 'assistant', at: Date.now() };
    // Режим записи: вместо «топ-3» по справочнику — строгий подбор свободного времени.
    const bookingMode = Boolean(result.booking) && bookingEnabledRef.current && Number.isInteger(meta.messageId);
    if (bookingMode) {
      setAssistantBookings((current) => {
        const kept = Object.entries(current).slice(-19);
        return { ...Object.fromEntries(kept), [meta.messageId]: result.booking };
      });
    } else if (Number.isInteger(meta.messageId) && wantsTopPicks(result)) {
      pendingPicksRef.current = { messageId: meta.messageId, at: Date.now() };
      setAssistantPicks((current) => {
        // Хранятся подборки последних 20 ответов — переписка длинной не бывает.
        const kept = Object.entries(current).slice(-19);
        return { ...Object.fromEntries(kept), [meta.messageId]: { status: 'pending' } };
      });
    }
    // «Сбрось маршрут и фильтры» сбрасывает и то и другое.
    if (result.clearRoute) {
      setRouteTargets([]);
      setRouteData(null);
      setIsRouteStarted(false);
    }

    // Сброс фильтров маршрут не трогает.
    if (result.clearFilters) {
      setSearchQuery('');
      setIsSearchFocused(false);
      setSelectedFacilityType('all');
      setSelectedClinic('all');
      setSelectedDistrict('all');
      setSelectedDoctorProfile('all');
      setSelectedOwnership('all');
      setCardDisplayMode('all');
      setSelectedServices([]);
      setFavoritesOnly(false);
      setOpenOnly(false);
      setWeekendOnly(false);
      setEveningOnly(false);
      setOnlineOnly(false);
      setWheelchairOnly(false);
      setChildrenOnly(false);
      setMinRating(0);
      setMinExperience(0);
      setMaxDistance(0);
      setMaxTravelMinutes(0);
      setDmsOnly(false);
      setSortBy('recommendation');
    }

    if (result.darkMode === true) setIsDarkMode(true);
    if (result.darkMode === false) setIsDarkMode(false);

    if (result.travelMode && ['driving', 'foot', 'bike'].includes(result.travelMode)) {
      setTravelMode(result.travelMode);
    }

    if (result.ownership && ['Государственная', 'Частная'].includes(result.ownership)) {
      setSelectedOwnership(result.ownership);
    }
    // Значения справочников принимаются только если реально есть в данных:
    // модель может выдумать несуществующий район и «обнулить» выдачу.
    if (result.district && districtSetRef.current.has(result.district)) {
      setSelectedDistrict(result.district);
    }
    if (result.cardDisplayMode && ['all', 'doctor', 'facility'].includes(result.cardDisplayMode)) {
      setCardDisplayMode(result.cardDisplayMode);
    }
    if (result.openOnly === true) setOpenOnly(true);
    if (result.openOnly === false) setOpenOnly(false);
    if (result.favoritesOnly === true) setFavoritesOnly(true);
    if (result.favoritesOnly === false) setFavoritesOnly(false);
    if (result.weekendOnly === true) setWeekendOnly(true);
    if (result.weekendOnly === false) setWeekendOnly(false);
    if (result.eveningOnly === true) setEveningOnly(true);
    if (result.eveningOnly === false) setEveningOnly(false);
    if (result.onlineOnly === true) setOnlineOnly(true);
    if (result.onlineOnly === false) setOnlineOnly(false);
    if (result.wheelchairOnly === true) setWheelchairOnly(true);
    if (result.wheelchairOnly === false) setWheelchairOnly(false);
    if (result.isChild) setChildrenOnly(true);

    if (typeof result.minRating === 'number' && !Number.isNaN(result.minRating)) {
      setMinRating(Math.max(0, Math.min(5, result.minRating)));
    }
    if (typeof result.minExperience === 'number' && !Number.isNaN(result.minExperience)) {
      setMinExperience(Math.max(0, Math.min(40, result.minExperience)));
    }
    if (typeof result.maxDistance === 'number' && !Number.isNaN(result.maxDistance)) {
      setMaxDistance(Math.max(0, Math.min(50, result.maxDistance)));
    }
    if (result.dmsOnly) {
      // Есть ли справочник и выбрана ли программа, проверит эффект ниже:
      // здесь их значения могли устареть. В режиме записи программу
      // спрашивает подборка в чате — второй вопрос не нужен.
      setDmsOnly(true);
      if (!bookingMode) setDmsPromptPending(true);
    }
    if (Number.isInteger(result.maxTravelMinutes)) {
      // Ближайший вариант из списка не меньше запрошенного: «25 минут» → 30.
      const option = TRAVEL_LIMIT_OPTIONS.find((value) => value >= result.maxTravelMinutes) || TRAVEL_LIMIT_OPTIONS[TRAVEL_LIMIT_OPTIONS.length - 1];
      setMaxTravelMinutes(option);
    }

    if (result.clinic && clinicSetRef.current.has(result.clinic)) {
      setSelectedClinic(result.clinic);
    }
    if (result.facilityType && facilityTypeSetRef.current.has(result.facilityType)) {
      setSelectedFacilityType(result.facilityType);
    }
    if (result.doctorProfile && doctorProfileSetRef.current.has(result.doctorProfile)) {
      setSelectedDoctorProfile(result.doctorProfile);
    }
    if (Array.isArray(result.services) && result.services.length > 0) {
      const knownServices = result.services.filter((service) => serviceSetRef.current.has(service));
      if (knownServices.length > 0) {
        setSelectedServices(knownServices);
      }
    }

    if (SORT_MODES.includes(result.sortMode)) {
      setSortBy(result.sortMode);
    }

    if ((result.clearRoute || result.clearFilters) && !result.specialty && !result.service && !result.searchQuery && !result.buildRoute && !result.targetStops?.length) {
      return;
    }

    if (result.targetStops && result.targetStops.length > 0) {
      setTimeout(() => setTargetStopsTrigger(result.targetStops), 100);
      return;
    }

    // searchQuery — универсальный поиск (по клинике, адресу, врачу и т.д.)
    const isGenericRouteQuery = (value) => {
      if (!value || typeof value !== 'string') {
        return false;
      }

      const text = value.trim().toLowerCase();
      if (!text) {
        return false;
      }

      return /маршрут|путь|дорог|ближайш\s+маршрут|построй\s+маршрут/.test(text);
    };

    if (result.searchQuery && !isGenericRouteQuery(result.searchQuery)) {
      setSearchQuery(result.searchQuery);
    } else if (result.specialty) {
      setSearchQuery(result.specialty);
    } else if (result.service) {
      setSearchQuery(result.service);
    }

    if (result.buildRoute && !result.clearRoute && !result.clearFilters) {
      const candidates = enrichedDoctorsRef.current.filter((doc) => {
        const specialtyMatch = result.specialty
          ? (doc.specialty && doc.specialty.toLowerCase().includes(result.specialty.toLowerCase()))
          : true;
        const queryMatch = result.searchQuery && !result.specialty
          ? [doc.name, doc.specialty, doc.clinic, doc.address].join(' ').toLowerCase().includes(result.searchQuery.toLowerCase())
          : true;

        return specialtyMatch && queryMatch;
      });

      const sortedCandidates = [...candidates].sort((left, right) => (left.distanceKm || Infinity) - (right.distanceKm || Infinity));
      setRouteTargets((prev) => {
        const bestMatch = sortedCandidates.find((doc) => !prev.some((target) => target.id === doc.id));

        if (!bestMatch || prev.length >= MAX_ROUTE_STOPS) {
          return prev;
        }

        setRouteData(null);
        setFlyToTarget([bestMatch.lat, bestMatch.lng]);
        return [...prev, bestMatch];
      });
    }
    // Сеттеры useState стабильны; setIsDarkMode — из useLocalStorageState,
    // поэтому exhaustive-deps требует указать его явно.
  }, [setIsDarkMode]);

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [isTablet, setIsTablet] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth <= 1024);

  const sidebarRef = useRef(null);
  const mobileSheetTouchStartYRef = useRef(null);
  const pendingSidebarWidthRef = useRef(sidebarWidth);
  const resizeFrameRef = useRef(null);
  const enrichedDoctorsRef = useRef([]);
  const clinicsFacilities = useMemo(() => mapClinicsToFacilities(ClinicsData), []);
  const sourceFacilities = useMemo(() => {
    // Источники: проверенные врачи с официальных сайтов больниц,
    // учреждения из OpenStreetMap и данные по клиникам.
    // Реальная частная клиника из демо-набора заменяет свою карточку из OSM, а не дублирует её.
    const replacedByDemo = new Set(demoState.items.map((item) => item.osmId).filter(Boolean));
    const osmFacilities = replacedByDemo.size > 0 ? kazanFacilities.filter((item) => !replacedByDemo.has(item.id)) : kazanFacilities;
    // «Только демо» (DEMO_ONLY на сервере): на карте только вымышленные клиники и врачи.
    const all = demoState.demoOnly ? [...demoState.items]
      : [...verifiedDoctors, ...doctorsData, ...osmFacilities.map(withOsmSchedule), ...clinicsFacilities, ...COLLECTED_FACILITIES, ...demoState.items];
    // Демо-режим: государственные учреждения скрыты из выдачи (флаг сервера PUBLIC_CLINICS).
    const base = demoState.enabled && !demoState.publicClinics ? all.filter((item) => item.ownership !== PUBLIC_OWNERSHIP) : all;
    const clinicAddressMap = new Map();
    const clinicCoordsMap = new Map();

    base.forEach((item) => {
      const clinicName = (item.clinic || '').trim();
      const clinicKey = normalizeClinicKey(clinicName);
      const address = (item.address || '').trim();
      const hasCoords = typeof item.lat === 'number' && typeof item.lng === 'number';
      const isDoctor = Boolean(resolveDoctorProfile(item));

      if (clinicKey && address && !/уточняется/i.test(address) && !clinicAddressMap.has(clinicKey)) {
        clinicAddressMap.set(clinicKey, address);
      }

      if (clinicKey && hasCoords && !isDoctor && !clinicCoordsMap.has(clinicKey)) {
        clinicCoordsMap.set(clinicKey, { lat: item.lat, lng: item.lng });
      }
    });

    base.forEach((item) => {
      const clinicKey = normalizeClinicKey(item.clinic || '');
      const hasCoords = typeof item.lat === 'number' && typeof item.lng === 'number';
      if (clinicKey && hasCoords && !clinicCoordsMap.has(clinicKey)) {
        clinicCoordsMap.set(clinicKey, { lat: item.lat, lng: item.lng });
      }
    });

    return base
      .map((item) => {
        const clinicName = (item.clinic || '').trim();
        const clinicKey = normalizeClinicKey(clinicName);
        const fallbackAddress = clinicKey ? clinicAddressMap.get(clinicKey) : null;
        const fallbackCoords = clinicKey ? clinicCoordsMap.get(clinicKey) : null;
        const currentAddress = (item.address || '').trim();
        const normalizedAddress = currentAddress && !/уточняется/i.test(currentAddress)
          ? currentAddress
          : fallbackAddress || '';
        const isDoctor = Boolean(resolveDoctorProfile(item));
        const normalizedLat = isDoctor && fallbackCoords ? fallbackCoords.lat : item.lat;
        const normalizedLng = isDoctor && fallbackCoords ? fallbackCoords.lng : item.lng;

        return {
          ...item,
          address: normalizedAddress,
          lat: normalizedLat,
          lng: normalizedLng,
        };
      })
      .filter((item) => {
        const address = (item.address || '').trim();
        const hasCoords = typeof item.lat === 'number' && typeof item.lng === 'number';
        return Boolean(address) && !/уточняется/i.test(address) && hasCoords;
      });
  }, [clinicsFacilities, demoState.items, demoState.enabled, demoState.publicClinics, demoState.demoOnly]);

  const activeOrigin = isManualOrigin && customOrigin ? customOrigin : userLocation;
  // Поле ввода обновляется мгновенно, тяжёлая фильтрация — с задержкой.
  const deferredSearchQuery = useDebouncedValue(searchQuery, 180);

  useEffect(() => {
    const timerId = setInterval(() => setNow(kazanWallClock()), 300000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    pendingSidebarWidthRef.current = sidebarWidth;
    if (sidebarRef.current) {
      // На планшете ширина фиксирована (340): с шириной от десктопа CSS обрезает
      // её до 360, и после сворачивания на −340 остаётся полоса в 20 пикселей.
      sidebarRef.current.style.width = `${isTablet ? 340 : sidebarWidth}px`;
    }
  }, [sidebarWidth, isTablet]);

  useEffect(() => {
    if (!isDraggingPanel) {
      document.body.style.cursor = 'default';
      document.body.style.userSelect = '';
      return undefined;
    }

    const applyWidth = () => {
      resizeFrameRef.current = null;
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${pendingSidebarWidthRef.current}px`;
      }
    };

    const handleMouseMove = (event) => {
      pendingSidebarWidthRef.current = Math.max(360, Math.min(event.clientX, window.innerWidth / 2.1));
      if (!resizeFrameRef.current) {
        resizeFrameRef.current = requestAnimationFrame(applyWidth);
      }
    };

    const handleMouseUp = () => {
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      setSidebarWidth(pendingSidebarWidthRef.current);
      setIsDraggingPanel(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = '';
      if (resizeFrameRef.current) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [isDraggingPanel]);

  useEffect(() => {
    if (!hasGeolocationSupport) {
      return undefined;
    }

    let watchId;
    // После первой успешной позиции единичный таймаут или «позиция недоступна»
    // (в помещении — обычное дело) не переносят пользователя в центр Казани.
    let hadFix = false;
    const fallbackTimer = window.setTimeout(() => {
      setUserLocation(defaultLocation);
      setLocationError(true);
      setIsLocationReady(true);
    }, 8000);

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        window.clearTimeout(fallbackTimer);
        hadFix = true;
        setLocationError(false);
        const next = [position.coords.latitude, position.coords.longitude];
        setUserLocation((prev) => {
          // watchPosition срабатывает несколько раз в секунду, а каждая новая
          // ссылка пересчитывает расстояния до всех объектов: дрожание меньше
          // ~5 метров игнорируется.
          if (prev && Math.abs(prev[0] - next[0]) < 0.00005 && Math.abs(prev[1] - next[1]) < 0.00005) {
            return prev;
          }
          return next;
        });
        setIsLocationReady(true);
      },
      (error) => {
        window.clearTimeout(fallbackTimer);
        if (hadFix && error?.code !== error?.PERMISSION_DENIED) {
          return;
        }
        setUserLocation(defaultLocation);
        setLocationError(true);
        setIsLocationReady(true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 },
    );

    return () => {
      window.clearTimeout(fallbackTimer);
      if (watchId) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  useEffect(() => {
    let resizeTimer;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const w = window.innerWidth;
        setIsMobile(w < 768);
        setIsTablet(w >= 768 && w <= 1024);
        if (w < 768) {
          setSidebarWidth(420);
        } else if (w <= 1024) {
          setSidebarWidth(340);
        } else {
          setIsMobileFiltersOpen(false);
        }
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    if (isDarkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }

    const rafId = requestAnimationFrame(() => {
      root.classList.remove('theme-switching');
    });

    return () => {
      cancelAnimationFrame(rafId);
      root.classList.remove('theme-switching');
    };
  }, [isDarkMode]);

  // Тяжёлая часть: расстояния, расписание, бейджи. Пересчитывается только при
  // смене точки отсчёта, времени или набора данных.
  const baseEnrichedDoctors = useMemo(
    () =>
      sourceFacilities.map((doc) => {
        const distanceKm = activeOrigin ? calculateDistanceKm(activeOrigin, [doc.lat, doc.lng]) : null;
        const openState = resolveOpenState(doc.schedule, now);
        const openNow = openState === OPEN_STATE.OPEN;
        const weekendReception = isWeekendReception(doc.schedule);
        const eveningReception = hasEveningReception(doc.schedule);
        const todayHours = getTodaySchedule(doc.schedule, now);
        const weekSchedule = buildWeekSchedule(doc.schedule, now);
        const facilityType = resolveFacilityType(doc);
        const doctorProfile = resolveDoctorProfile(doc);
        const entityKind = doctorProfile ? 'doctor' : 'facility';
        const telHref = toTelHref(doc.phone);
        const websiteUrl = toSafeUrl(doc.website);
        const servicePrices = Array.isArray(doc.servicePrices)
          ? doc.servicePrices
              .map((entry) => ({ service: entry?.service, label: formatPriceRange(entry) }))
              .filter((entry) => entry.service && entry.label)
          : EMPTY_SERVICES;
        // Часть источников (OSM, ClinicsData) приходит без features/services.
        // «Детский ЛОР», «Педиатр», «Детская поликлиника» — детский приём,
        // даже если в источнике флаг не проставлен.
        const features = { ...(doc.features || {}), children: isPediatricRecord(doc) };
        const services = Array.isArray(doc.services) ? doc.services : EMPTY_SERVICES;

        /*
         * Проверка на сайте учреждения (npm run data:verify): «на месте» —
         * свежая дата проверки; «не найден» — предупреждение в карточке.
         */
        const check = VERIFICATION[doc.id];
        const verifiedAt = check?.status === 'present' && typeof check.verifiedAt === 'string'
          && (!doc.verifiedAt || check.verifiedAt > doc.verifiedAt)
          ? check.verifiedAt
          : doc.verifiedAt;
        const missingSince = check?.status === 'missing' && typeof check.checkedAt === 'string' ? check.checkedAt : null;

        // По одному, самому сильному бейджу на признак (стаж, рейтинг).
        const trustBadges = [];
        if (entityKind === 'doctor') {
          if (doc.experience >= 20) trustBadges.push('Высший стаж');
          else if (doc.experience >= 15) trustBadges.push('Опытный врач');

          if (doc.rating >= 4.8) trustBadges.push('Топ-врач');
          else if (doc.rating >= 4.5) trustBadges.push('Популярный');

          if (features.children) trustBadges.push('Детский врач');
        } else {
          if (doc.ownership === 'Государственная') trustBadges.push('Государственное');
          trustBadges.push(facilityType || 'Медучреждение');
        }

        return {
          ...doc,
          features,
          services,
          rating: Number(doc.rating) || 0,
          experience: Number(doc.experience) || 0,
          distanceKm,
          openState,
          openNow,
          weekendReception,
          eveningReception,
          todayHours,
          weekSchedule,
          telHref,
          websiteUrl,
          servicePrices,
          facilityType,
          doctorProfile,
          entityKind,
          trustBadges,
          verifiedAt,
          missingSince,
        };
      }),
    [activeOrigin, now, sourceFacilities],
  );

  // Set, а не favorites.includes() на каждую запись: иначе O(записи × избранное).
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);

  const enrichedDoctors = useMemo(
    () => baseEnrichedDoctors.map((doc) => ({ ...doc, isFavorite: favoriteIds.has(doc.id) })),
    [baseEnrichedDoctors, favoriteIds],
  );

  // --- Демо-режим и ДМС ---------------------------------------------------

  // Публичные настройки из админ-панели (название, сообщение о работах, ассистент).
  const [siteSettings, setSiteSettings] = useState(null);
  const [maintenanceDismissed, setMaintenanceDismissed] = useState(false);
  useEffect(() => {
    assistantDisabledRef.current = siteSettings?.assistant === false;
    if (siteSettings?.appName && siteSettings.appName !== 'МедКарта') document.title = `${siteSettings.appName} — врачи и клиники Казани`;
  }, [siteSettings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const preference = readDemoPreference();
      const config = await fetchServerConfig();
      if (!cancelled) setSiteSettings(config.settings);
      // «Только демо» на сервере: выбор «без демо» из браузера не действует.
      const enabled = config.demoOnly || (preference ?? config.demo);
      if (!enabled || cancelled) return;
      try {
        const data = await loadDemoData({ fictionalOnly: config.demoOnly });
        // Запись и скрытие госучреждений — только если демо включено и на сервере.
        if (!cancelled) setDemoState({ enabled: true, ...data, booking: config.demo && config.booking, publicClinics: !config.demo || config.publicClinics, demoOnly: config.demoOnly });
      } catch {
        // Демо-набор необязателен: без него работает обычный справочник.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const insurance = demoState.insurance;
  const dmsPlan = insurance && dmsPlanId ? findPlan(insurance, dmsPlanId) : null;
  const dmsProvider = dmsPlan ? findProvider(insurance, dmsPlan.providerId) : null;
  // «Сегодня» по Казани — из того же часового сдвига, что и «открыто сейчас».
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dmsFilterActive = dmsOnly && Boolean(dmsPlan);

  /*
   * Покрытие считается в браузере по публичному справочнику ДМС (какие клиники
   * входят в какую программу); для этого расчёта программа на сервер не уходит.
   */
  const dmsAnnotatedDoctors = useMemo(() => {
    if (!insurance || !dmsPlan) return enrichedDoctors;
    return enrichedDoctors.map((doc) => ({
      ...doc,
      dmsCoverage: coverageFor(insurance, dmsPlan.id, {
        clinicId: doc.clinicId,
        branchId: doc.branchId,
        entityKind: doc.entityKind,
        specialtyKey: specialtyCode(doc.doctorProfile || doc.specialty),
        pediatric: Boolean(doc.features?.children),
      }, { today: todayKey }),
    }));
  }, [enrichedDoctors, insurance, dmsPlan, todayKey]);

  useEffect(() => {
    if (!dmsPromptPending) return undefined;
    // Отложено на кадр: состояние меняется не в теле эффекта.
    const timerId = setTimeout(() => {
      setDmsPromptPending(false);
      if (!insurance) {
        showToast('Справочника программ ДМС пока нет — показываю все варианты.', 'info', 5000);
      } else if (!dmsPlan) {
        setIsDmsPanelOpen(true);
        setIsMobileFiltersOpen(true);
        showToast('Выберите свою программу ДМС — отмечу, что в неё входит.', 'info', 5000);
      }
    }, 0);
    return () => clearTimeout(timerId);
  }, [dmsPromptPending, insurance, dmsPlan, showToast]);

  const disableDemo = useCallback(() => {
    setDemoPreference(false);
    setDemoState(EMPTY_DEMO);
    setDmsOnly(false);
    setIsDmsPanelOpen(false);
    setIsMyBookingsOpen(false);
  }, []);

  useEffect(() => {
    bookingEnabledRef.current = demoState.booking;
  }, [demoState.booking]);

  useEffect(() => {
    enrichedDoctorsRef.current = enrichedDoctors;
  }, [enrichedDoctors]);

  const clinics = useMemo(() => uniqueSorted(sourceFacilities.map((doc) => doc.clinic)), [sourceFacilities]);
  const districts = useMemo(() => uniqueSorted(sourceFacilities.map((doc) => doc.district)), [sourceFacilities]);
  const doctorProfiles = useMemo(
    () => uniqueSorted(sourceFacilities.map((doc) => resolveDoctorProfile(doc))),
    [sourceFacilities],
  );
  const facilityTypes = useMemo(
    () => uniqueSorted(sourceFacilities.map((doc) => resolveFacilityType(doc))),
    [sourceFacilities],
  );
  const allServices = useMemo(
    () => uniqueSorted(sourceFacilities.flatMap((doc) => doc.services || [])),
    [sourceFacilities],
  );

  useEffect(() => {
    districtSetRef.current = new Set(districts);
    clinicSetRef.current = new Set(clinics);
    facilityTypeSetRef.current = new Set(facilityTypes);
    doctorProfileSetRef.current = new Set(doctorProfiles);
    serviceSetRef.current = new Set(allServices);
  }, [districts, clinics, facilityTypes, doctorProfiles, allServices]);

  // Индекс подсказок (Map на несколько тысяч ключей) строится один раз на набор
  // данных, а не на каждое нажатие клавиши.
  const suggestionIndex = useMemo(() => {
    const unique = new Map();
    const add = (value, type) => {
      if (!value) return;
      const key = normalizeText(value);
      if (key && !unique.has(key)) {
        unique.set(key, { value, type, key });
      }
    };

    for (const doc of sourceFacilities) {
      add(doc.name, 'Имя');
      add(doc.clinic, 'Клиника');
      add(doc.specialty, 'Специальность');
      add(doc.district, 'Район');
      for (const service of doc.services || EMPTY_SERVICES) {
        add(service, 'Услуга');
      }
    }

    return [...unique.values()];
  }, [sourceFacilities]);

  const searchSuggestions = useMemo(() => {
    if (!isSearchFocused) {
      return [];
    }

    const query = normalizeText(deferredSearchQuery).trim();
    if (query.length < 2) {
      return [];
    }

    const results = suggestionIndex.filter((item) => item.key.includes(query));

    results.sort((left, right) => {
      const leftStarts = left.key.startsWith(query);
      const rightStarts = right.key.startsWith(query);
      if (leftStarts !== rightStarts) {
        return Number(rightStarts) - Number(leftStarts);
      }
      return left.key.length - right.key.length;
    });

    return results.slice(0, 8);
  }, [deferredSearchQuery, suggestionIndex, isSearchFocused]);

  const filteredDoctors = useMemo(() => {
    const query = normalizeText(deferredSearchQuery).trim();
    const routeTargetIds = new Set(routeTargets.map(t => t.id));
    const selectedServiceList = selectedServices;
    const knownDoctorProfileQuery = doctorProfiles.find((profile) => normalizeText(profile) === query);

    return dmsAnnotatedDoctors.filter((doc) => {
      // Keep route targets visible
      if (routeTargetIds.has(doc.id)) return true;

      const matchesQuery = (() => {
        if (!query) {
          return true;
        }

        if (knownDoctorProfileQuery) {
          return doc.entityKind === 'doctor' && normalizeText(doc.doctorProfile) === query;
        }

        return [doc.name, doc.specialty, doc.clinic, doc.address, doc.district, doc.description, ...(doc.services || [])]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })();

      const matchesClinic = selectedClinic === 'all' || doc.clinic === selectedClinic;
      const matchesFacilityType = selectedFacilityType === 'all' || doc.facilityType === selectedFacilityType;
      const matchesDistrict = selectedDistrict === 'all' || doc.district === selectedDistrict;
      const matchesDoctorProfile = selectedDoctorProfile === 'all' || doc.doctorProfile === selectedDoctorProfile;
      const matchesCardDisplayMode = cardDisplayMode === 'all' || doc.entityKind === cardDisplayMode;
      const matchesOwnership = selectedOwnership === 'all' || doc.ownership === selectedOwnership;
      const matchesRating = doc.rating >= minRating;
      const matchesExperience = doc.experience >= minExperience;
      const matchesDistance = maxDistance === 0 || doc.distanceKm == null || doc.distanceKm <= maxDistance;
      const matchesOpen = !openOnly || doc.openNow;
      const matchesFavorites = !favoritesOnly || doc.isFavorite;
      const matchesWeekend = !weekendOnly || doc.weekendReception;
      const matchesEvening = !eveningOnly || doc.eveningReception;
      const matchesOnline = !onlineOnly || doc.features.onlineBooking;
      const matchesWheelchair = !wheelchairOnly || doc.features.wheelchair;
      const matchesChildren = !childrenOnly || doc.features.children;
      const matchesServices =
        selectedServiceList.length === 0 || selectedServiceList.every((service) => doc.services.includes(service));
      const matchesDms = !dmsFilterActive || doc.dmsCoverage?.status === 'covered';

      return (
        matchesDms &&
        matchesQuery &&
        matchesClinic &&
        matchesFacilityType &&
        matchesDistrict &&
        matchesDoctorProfile &&
        matchesCardDisplayMode &&
        matchesOwnership &&
        matchesRating &&
        matchesExperience &&
        matchesDistance &&
        matchesOpen &&
        matchesFavorites &&
        matchesWeekend &&
        matchesEvening &&
        matchesOnline &&
        matchesWheelchair &&
        matchesChildren &&
        matchesServices
      );
    });
  }, [
    dmsAnnotatedDoctors,
    dmsFilterActive,
    deferredSearchQuery,
    doctorProfiles,
    selectedFacilityType,
    selectedClinic,
    selectedDistrict,
    selectedDoctorProfile,
    cardDisplayMode,
    selectedOwnership,
    minRating,
    minExperience,
    maxDistance,
    openOnly,
    favoritesOnly,
    weekendOnly,
    eveningOnly,
    onlineOnly,
    wheelchairOnly,
    childrenOnly,
    selectedServices,
    routeTargets,
  ]);

  /*
   * Фильтр «не дольше N минут» — только от настоящей точки отправления: без
   * геолокации и ручной точки «20 минут от центра Казани» ничего не значат, и
   * фильтр не применяется (форма это объясняет).
   */
  const travelOriginKnown = isManualOrigin || !locationError;
  const travelFilterActive = maxTravelMinutes > 0 && travelOriginKnown && Boolean(activeOrigin);
  const travelKey = travelFilterActive
    ? `${travelMode}|${maxTravelMinutes}|${activeOrigin[0].toFixed(3)},${activeOrigin[1].toFixed(3)}`
    : null;

  // Уникальные адреса справочника: на одном адресе бывают десятки врачей.
  const travelPoints = useMemo(() => {
    const unique = new Map();
    for (const doc of sourceFacilities) {
      const key = pointKey(doc.lat, doc.lng);
      if (!unique.has(key)) unique.set(key, [Number(Number(doc.lat).toFixed(5)), Number(Number(doc.lng).toFixed(5))]);
    }
    return [...unique.entries()];
  }, [sourceFacilities]);

  useEffect(() => {
    if (!travelKey) return undefined;
    const controller = new AbortController();
    const origin = activeOrigin;
    const mode = travelMode;
    const limit = maxTravelMinutes;

    // «Считаем…» выводится из несовпадения ключа — отдельный setState не нужен.
    const timerId = setTimeout(async () => {
      // Больше 600 адресов сервер за раз не считает — берём ближайшие по прямой.
      const points = travelPoints.length > MAX_TRAVEL_POINTS
        ? [...travelPoints]
          .sort((left, right) => calculateDistanceKm(origin, left[1]) - calculateDistanceKm(origin, right[1]))
          .slice(0, MAX_TRAVEL_POINTS)
        : travelPoints;
      try {
        const durations = await fetchTravelTimes({
          origin,
          mode,
          maxMinutes: limit,
          points: points.map(([, coords]) => coords),
          signal: controller.signal,
        });
        const byPoint = new Map(points.map(([key], index) => [key, durations[index]]));
        setTravelTimes({ key: travelKey, status: 'ready', byPoint });
      } catch {
        if (controller.signal.aborted) return;
        setTravelTimes({ key: travelKey, status: 'error', byPoint: null });
      }
    }, 250);

    return () => {
      clearTimeout(timerId);
      controller.abort();
    };
    // travelKey огрубляет точку до ~100 м: дрожание GPS не перезапрашивает время.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [travelKey, travelPoints]);

  const travelEstimateState = !travelFilterActive
    ? 'off'
    : travelTimes.key === travelKey && travelTimes.status === 'ready'
      ? 'exact'
      : travelTimes.key === travelKey && travelTimes.status === 'error'
        ? 'approximate'
        : 'loading';

  const travelFilteredDoctors = useMemo(() => {
    if (!travelFilterActive) return filteredDoctors;
    const limitSeconds = maxTravelMinutes * 60;
    const routeTargetIds = new Set(routeTargets.map((target) => target.id));
    const exact = travelEstimateState === 'exact';
    const speedKmh = FALLBACK_SPEED_KMH[travelMode] || FALLBACK_SPEED_KMH.driving;

    return filteredDoctors
      .map((doc) => {
        const seconds = exact
          ? travelTimes.byPoint.get(pointKey(doc.lat, doc.lng)) ?? null
          // Пока сервер считает (или если он недоступен) — грубая оценка по
          // прямой с поправкой на извилистость улиц. Помечается как «≈».
          : doc.distanceKm == null
            ? null
            : Math.round(((doc.distanceKm * DETOUR_FACTOR) / speedKmh) * 3600);
        return { ...doc, travelSeconds: seconds, travelApproximate: !exact };
      })
      .filter((doc) => routeTargetIds.has(doc.id) || (doc.travelSeconds != null && doc.travelSeconds <= limitSeconds));
  }, [filteredDoctors, travelFilterActive, maxTravelMinutes, travelEstimateState, travelTimes, travelMode, routeTargets]);

  const sortedDoctors = useMemo(() => {
    const list = [...travelFilteredDoctors];
    const currentDayKey = dayKeys[now.getDay()];

    const compareByRecommendation = (left, right) => {
      const leftDistance = left.distanceKm == null ? Number.POSITIVE_INFINITY : left.distanceKm;
      const rightDistance = right.distanceKm == null ? Number.POSITIVE_INFINITY : right.distanceKm;

      return (
        Number(right.openNow) - Number(left.openNow) ||
        Number(right.isFavorite) - Number(left.isFavorite) ||
        right.rating - left.rating ||
        leftDistance - rightDistance ||
        right.experience - left.experience
      );
    };

    const compareBySchedule = (left, right) => {
      const leftRange = scheduleTextToRange(left.schedule?.[currentDayKey]);
      const rightRange = scheduleTextToRange(right.schedule?.[currentDayKey]);
      const leftStart = leftRange ? leftRange.start : Number.POSITIVE_INFINITY;
      const rightStart = rightRange ? rightRange.start : Number.POSITIVE_INFINITY;

      return Number(right.openNow) - Number(left.openNow) || leftStart - rightStart || right.rating - left.rating;
    };

    const comparators = {
      recommendation: compareByRecommendation,
      rating: (left, right) => right.rating - left.rating || right.experience - left.experience,
      experience: (left, right) => right.experience - left.experience || right.rating - left.rating,
      distance: (left, right) => {
        // С фильтром по времени «ближе» — это быстрее доехать, а не короче по прямой.
        if (left.travelSeconds != null && right.travelSeconds != null) {
          return left.travelSeconds - right.travelSeconds || Number(right.openNow) - Number(left.openNow);
        }
        const leftDistance = left.distanceKm == null ? Number.POSITIVE_INFINITY : left.distanceKm;
        const rightDistance = right.distanceKm == null ? Number.POSITIVE_INFINITY : right.distanceKm;

        return leftDistance - rightDistance || Number(right.openNow) - Number(left.openNow);
      },
      schedule: compareBySchedule,
      // Цена первичного приёма; без цены — в конце, а не «бесплатно».
      price: (left, right) =>
        (left.consultPrice ?? Number.POSITIVE_INFINITY) - (right.consultPrice ?? Number.POSITIVE_INFINITY)
        || compareByRecommendation(left, right),
      name: (left, right) => left.name.localeCompare(right.name, 'ru'),
      clinic: (left, right) => left.clinic.localeCompare(right.clinic, 'ru'),
    };

    list.sort(comparators[sortBy] || compareByRecommendation);
    return list;
  }, [travelFilteredDoctors, now, sortBy]);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Фильтры — в адресной строке через replaceState: иначе каждое движение
  // ползунка добавляет запись в историю, и «Назад» не работает.
  const urlQuery = useMemo(
    () =>
      buildUrlQuery({
        q: deferredSearchQuery,
        clinic: selectedClinic,
        district: selectedDistrict,
        facilityType: selectedFacilityType,
        doctorProfile: selectedDoctorProfile,
        ownership: selectedOwnership,
        cardDisplayMode,
        sortBy,
        services: selectedServices,
        minRating,
        minExperience,
        maxDistance,
        maxTravel: maxTravelMinutes,
        flags: [
          openOnly && 'open',
          favoritesOnly && 'fav',
          weekendOnly && 'weekend',
          eveningOnly && 'evening',
          onlineOnly && 'online',
          wheelchairOnly && 'wheelchair',
          childrenOnly && 'children',
          dmsOnly && 'dms',
        ].filter(Boolean),
      }),
    [
      deferredSearchQuery,
      selectedClinic,
      selectedDistrict,
      selectedFacilityType,
      selectedDoctorProfile,
      selectedOwnership,
      cardDisplayMode,
      sortBy,
      selectedServices,
      minRating,
      minExperience,
      maxDistance,
      maxTravelMinutes,
      openOnly,
      favoritesOnly,
      weekendOnly,
      eveningOnly,
      onlineOnly,
      wheelchairOnly,
      childrenOnly,
      dmsOnly,
    ],
  );

  useEffect(() => {
    const next = `${window.location.pathname}${urlQuery ? `?${urlQuery}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
  }, [urlQuery]);

  const handleShare = useCallback(async () => {
    const link = `${window.location.origin}${window.location.pathname}${urlQuery ? `?${urlQuery}` : ''}`;

    try {
      if (navigator.share) {
        await navigator.share({ title: 'МедКарта Казань', url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      showToast('Ссылка на подборку скопирована.', 'success');
    } catch (error) {
      // Пользователь закрыл системное окно «Поделиться» — это не ошибка.
      if (error?.name === 'AbortError') {
        return;
      }
      showToast('Не удалось скопировать ссылку. Скопируйте адрес из строки браузера.', 'warning');
    }
  }, [urlQuery, showToast]);

  // Пагинация сбрасывается при смене фильтра: иначе после «показать ещё» новый
  // поиск сразу отдаёт сотни карточек и подвешивает прокрутку.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [
    deferredSearchQuery,
    selectedFacilityType,
    selectedClinic,
    selectedDistrict,
    selectedDoctorProfile,
    selectedOwnership,
    cardDisplayMode,
    selectedServices,
    favoritesOnly,
    openOnly,
    weekendOnly,
    eveningOnly,
    onlineOnly,
    wheelchairOnly,
    childrenOnly,
    minRating,
    minExperience,
    maxDistance,
    maxTravelMinutes,
    dmsOnly,
    dmsPlanId,
    sortBy,
  ]);

  // --- Аналитика и обратная связь -----------------------------------------

  /*
   * Какие фильтры включены — без значений: в событие уходит «был фильтр по
   * клинике», а не какая клиника, и тем более не текст поиска.
   */
  const activeFilterKeys = useMemo(() => {
    const keys = [];
    if (deferredSearchQuery.trim()) keys.push('query');
    if (selectedDoctorProfile !== 'all') keys.push('profile');
    if (selectedFacilityType !== 'all') keys.push('facilityType');
    if (selectedOwnership !== 'all') keys.push('ownership');
    if (selectedClinic !== 'all') keys.push('clinic');
    if (selectedDistrict !== 'all') keys.push('district');
    if (selectedServices.length > 0) keys.push('services');
    if (childrenOnly) keys.push('children');
    if (openOnly) keys.push('open');
    if (weekendOnly) keys.push('weekend');
    if (eveningOnly) keys.push('evening');
    if (onlineOnly) keys.push('online');
    if (wheelchairOnly) keys.push('wheelchair');
    if (favoritesOnly) keys.push('favorites');
    if (minRating > 0) keys.push('minRating');
    if (minExperience > 0) keys.push('minExperience');
    if (maxDistance > 0) keys.push('maxDistance');
    if (maxTravelMinutes > 0) keys.push('maxTravel');
    if (dmsFilterActive) keys.push('dms');
    return keys;
  }, [
    deferredSearchQuery, selectedDoctorProfile, selectedFacilityType, selectedOwnership, selectedClinic,
    selectedDistrict, selectedServices, childrenOnly, openOnly, weekendOnly, eveningOnly, onlineOnly,
    wheelchairOnly, favoritesOnly, minRating, minExperience, maxDistance, maxTravelMinutes, dmsFilterActive,
  ]);

  // Подпись поиска — только для сравнения внутри вкладки, наружу не уходит.
  const searchSignature = activeFilterKeys.length === 0
    ? ''
    : JSON.stringify([
      normalizeText(deferredSearchQuery).trim(), selectedDoctorProfile, selectedFacilityType, selectedOwnership,
      selectedClinic, selectedDistrict, selectedServices, cardDisplayMode, childrenOnly, openOnly, weekendOnly,
      eveningOnly, onlineOnly, wheelchairOnly, favoritesOnly, minRating, minExperience, maxDistance,
      maxTravelMinutes, maxTravelMinutes > 0 ? travelMode : null, dmsFilterActive ? dmsPlanId : null,
    ]);

  /*
   * Специальность — только если она выбрана из справочника: в фильтре или
   * строка поиска совпала с названием профиля целиком. Свободный текст
   * поиска не разбирается и не отправляется.
   */
  const searchSpecialty = useMemo(() => {
    if (selectedDoctorProfile !== 'all') return specialtyCode(selectedDoctorProfile);
    const query = normalizeText(deferredSearchQuery).trim();
    const profile = query ? doctorProfiles.find((item) => normalizeText(item) === query) : null;
    return profile ? specialtyCode(profile) : null;
  }, [selectedDoctorProfile, deferredSearchQuery, doctorProfiles]);

  const resultCount = sortedDoctors.length;
  const resultsSettled = travelEstimateState !== 'loading';

  /*
   * Подборка для ответа ассистента собирается, когда выдача «устоялась»:
   * строка поиска дошла до фильтра, а время в пути посчитано. Ждём не
   * дольше PICKS_MAX_WAIT_MS — дальше берём оценку по прямой.
   */
  useEffect(() => {
    const pending = pendingPicksRef.current;
    if (!pending) return undefined;
    const settled = deferredSearchQuery === searchQuery && resultsSettled;
    if (!settled && Date.now() - pending.at < PICKS_MAX_WAIT_MS) {
      const timerId = setTimeout(() => setPicksTick((tick) => tick + 1), 300);
      return () => clearTimeout(timerId);
    }
    pendingPicksRef.current = null;

    const exclude = new Set(routeTargets.map((target) => target.id));
    const { picks, total } = selectTopPicks(sortedDoctors, { exclude });
    const query = normalizeText(deferredSearchQuery).trim();
    const queryProfile = query ? doctorProfiles.find((item) => normalizeText(item) === query) : null;
    const profile = selectedDoctorProfile !== 'all'
      ? selectedDoctorProfile
      : queryProfile || (deferredSearchQuery.trim() ? `«${deferredSearchQuery.trim()}»` : null);

    const snapshot = {
      status: 'ready',
      total,
      sortText: SORT_EXPLANATION[sortBy] || null,
      criteria: describeCriteria({
        profile,
        childrenOnly,
        maxTravelMinutes,
        travelMode,
        travelActive: travelFilterActive,
        dmsPlanName: dmsFilterActive ? dmsPlan?.name : null,
        openOnly,
        eveningOnly,
        weekendOnly,
        ownership: selectedOwnership,
        district: selectedDistrict,
      }),
      picks: picks.map((doc) => ({
        id: doc.id,
        name: doc.name,
        specialty: doc.specialty,
        doctorProfile: doc.doctorProfile,
        facilityType: doc.facilityType,
        entityKind: doc.entityKind,
        clinic: doc.clinic,
        address: doc.address,
        lat: doc.lat,
        lng: doc.lng,
        demo: Boolean(doc.demo),
        reasons: pickReasons(doc, { travelMode, childrenOnly }),
      })),
    };
    // Состояние меняется вне тела эффекта. Таймер не отменяется при перерисовке:
    // ожидание уже снято, и без него подборка навсегда останется «подбираю…».
    setTimeout(() => setAssistantPicks((current) => ({ ...current, [pending.messageId]: snapshot })), 0);
    return undefined;
    // Снимок зависит от выдачи и условий на момент ответа; перечислять всё,
    // что входит в снимок, незачем — эффект ждёт только «устоявшейся» выдачи.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantPicks, picksTick, sortedDoctors, deferredSearchQuery, searchQuery, resultsSettled]);

  const lastTrackedSearchRef = useRef('');
  const firstSearchRef = useRef(true);

  useEffect(() => {
    if (!searchSignature || !resultsSettled || searchSignature === lastTrackedSearchRef.current) return undefined;
    // Событие — когда поиск «устоялся», а не на каждую нажатую букву.
    const timerId = setTimeout(() => {
      lastTrackedSearchRef.current = searchSignature;
      const origin = searchSourceRef.current;
      const source = origin.source === 'assistant' && Date.now() - origin.at < 5000
        ? 'assistant'
        : origin.source === 'url' && firstSearchRef.current
          ? 'url'
          : 'filters';
      firstSearchRef.current = false;
      track('search', {
        source,
        specialty: searchSpecialty,
        ownership: selectedOwnership === 'all' ? 'any' : ownershipCode(selectedOwnership),
        filters: activeFilterKeys,
        results: Math.min(resultCount, 5000),
        hasLocation: travelOriginKnown,
        maxTravel: maxTravelMinutes || undefined,
        dmsPlan: insurance ? Boolean(dmsPlan) : undefined,
      });
    }, 1500);
    return () => clearTimeout(timerId);
  }, [searchSignature, resultsSettled, resultCount, searchSpecialty, selectedOwnership, activeFilterKeys, travelOriginKnown, maxTravelMinutes, insurance, dmsPlan]);

  // Вопрос «Нашли, куда обратиться?»: после целевого действия или через
  // 45 секунд на выдаче. Не чаще трёх раз за сессию и один раз на поиск.
  const [feedbackFor, setFeedbackFor] = useState(null);
  const feedbackDoneRef = useRef(new Set());
  const feedbackShownRef = useRef(new Set());

  const requestFeedback = useCallback((signature) => {
    if (!signature || feedbackDoneRef.current.has(signature)) return;
    if (!feedbackShownRef.current.has(signature) && feedbackShownRef.current.size >= 3) return;
    feedbackShownRef.current.add(signature);
    setFeedbackFor(signature);
  }, []);

  useEffect(() => {
    if (!searchSignature || resultCount === 0) return undefined;
    const timerId = setTimeout(() => requestFeedback(searchSignature), 45_000);
    return () => clearTimeout(timerId);
  }, [searchSignature, resultCount, requestFeedback]);

  const handleFeedbackAnswer = useCallback((answer, reason) => {
    track('feedback', { context: 'list', answer, reason: reason || undefined });
    if (feedbackFor) feedbackDoneRef.current.add(feedbackFor);
  }, [feedbackFor]);

  const handleFeedbackDismiss = useCallback(() => {
    if (feedbackFor) feedbackDoneRef.current.add(feedbackFor);
    setFeedbackFor(null);
  }, [feedbackFor]);

  const showFeedbackPrompt = Boolean(feedbackFor) && feedbackFor === searchSignature && resultCount > 0;

  /** Поля карточки для событий: тип, форма собственности, профиль, id записи. */
  const placeFields = useCallback((doc) => ({
    kind: doc.entityKind === 'doctor' ? 'doctor' : 'facility',
    ownership: ownershipCode(doc.ownership),
    specialty: doc.entityKind === 'doctor' ? specialtyCode(doc.doctorProfile || doc.specialty) ?? undefined : undefined,
    placeId: PLACE_ID_PATTERN.test(String(doc.id)) ? String(doc.id) : undefined,
  }), []);

  /** Целевое действие: звонок, сайт, Госуслуги, внешние карты. */
  const trackContact = useCallback((doc, channel) => {
    track('contact_click', { channel, ...placeFields(doc) });
    requestFeedback(searchSignature);
  }, [placeFields, requestFeedback, searchSignature]);

  const trackExternalMap = useCallback((provider, mode, targets, doc = null) => {
    track('external_map_click', {
      provider,
      mode,
      stops: Math.max(1, Math.min(6, targets.length)),
      placeId: doc && PLACE_ID_PATTERN.test(String(doc.id)) ? String(doc.id) : undefined,
    });
    requestFeedback(searchSignature);
  }, [requestFeedback, searchSignature]);

  const lastRouteDataRef = useRef(null);
  useEffect(() => {
    if (!routeData || routeData === lastRouteDataRef.current || routeTargets.length === 0) return undefined;
    lastRouteDataRef.current = routeData;
    track('route_build', {
      mode: travelMode,
      stops: Math.min(6, routeTargets.length),
      outcome: routeData.error ? 'failed' : 'ok',
    });
    if (routeData.error) return undefined;
    const timerId = setTimeout(() => requestFeedback(searchSignature), 1200);
    return () => clearTimeout(timerId);
  }, [routeData, routeTargets.length, travelMode, requestFeedback, searchSignature]);

  const favoritesCount = enrichedDoctors.filter((doc) => doc.isFavorite).length;
  // Сортировка «сначала дешевле» имеет смысл, только когда в справочнике есть цены.
  const hasPrices = useMemo(() => sourceFacilities.some((doc) => Number.isFinite(doc.consultPrice)), [sourceFacilities]);

  // Карточка в окне подробностей — та же, что в списке (со временем в пути), а если её отфильтровали — из справочника.
  const detailsDoc = useMemo(() => {
    if (!detailsId) return null;
    return sortedDoctors.find((doc) => doc.id === detailsId) || dmsAnnotatedDoctors.find((doc) => doc.id === detailsId) || null;
  }, [detailsId, sortedDoctors, dmsAnnotatedDoctors]);
  // Сколько записей фильтр «Открытые сейчас» прячет не потому, что они закрыты,
  // а потому, что графика нет в данных, — это показывается пользователю.
  const unknownScheduleCount = enrichedDoctors.filter((doc) => doc.openState === OPEN_STATE.UNKNOWN).length;
  // Только открытые сейчас: если таких нет — null, а не ближайшее закрытое
  // место или место без графика.
  const nearestOpenDoctor = useMemo(() => {
    const byDistance = [...enrichedDoctors].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    return byDistance.find((doc) => doc.openNow) || null;
  }, [enrichedDoctors]);
  const doctorCards = useMemo(() => sortedDoctors.filter((item) => item.entityKind === 'doctor'), [sortedDoctors]);

  // Ссылка ?doc=<id>: карта летит к этому врачу или учреждению, список сужается до него.
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current || !INITIAL_URL_STATE.focus || enrichedDoctors.length === 0) return;
    deepLinkHandledRef.current = true;
    const target = enrichedDoctors.find((doc) => String(doc.id) === INITIAL_URL_STATE.focus);
    if (!target) return;
    setSearchQuery(target.name);
    if (Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
      setFlyToTarget([target.lat, target.lng]);
    }
  }, [enrichedDoctors]);
  const facilityCards = useMemo(() => sortedDoctors.filter((item) => item.entityKind === 'facility'), [sortedDoctors]);

  useEffect(() => {
    if (targetStopsTrigger && targetStopsTrigger.length > 0 && enrichedDoctors.length > 0) {
      const requested = targetStopsTrigger.length;
      const foundTargets = [];
      targetStopsTrigger.forEach(stop => {
        const candidates = enrichedDoctors.filter(doc => {
          const specialtyMatch = stop.specialty
            ? (doc.specialty && doc.specialty.toLowerCase().includes(stop.specialty.toLowerCase()))
            : true;
          const clinicMatch = stop.clinic
            ? ((doc.clinic && doc.clinic.toLowerCase().includes(stop.clinic.toLowerCase())) ||
              (doc.name && doc.name.toLowerCase().includes(stop.clinic.toLowerCase())))
            : true;
          // Остановка может указывать на конкретного врача: backend разрешил
          // плейсхолдер @DOCTOR_A в реальную запись и передал её имя сюда.
          const doctorMatch = stop.doctor
            ? (doc.name && doc.name.toLowerCase().includes(stop.doctor.toLowerCase()))
            : true;
          return specialtyMatch && clinicMatch && doctorMatch;
        });

        if (candidates.length > 0) {
          const sorted = [...candidates].sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
          const best = sorted.find(c => !foundTargets.some(t => t.id === c.id));
          if (best && foundTargets.length < MAX_ROUTE_STOPS) {
            foundTargets.push(best);
          }
        }
      });

      // Сообщаем, сколько точек реально добавлено: часть может не найтись на
      // карте или не поместиться в MAX_ROUTE_STOPS.
      const room = Math.max(0, MAX_ROUTE_STOPS - routeTargets.length);
      const fresh = foundTargets.filter((ft) => !routeTargets.some((t) => t.id === ft.id));
      const added = Math.min(fresh.length, room);
      const alreadyThere = foundTargets.length - fresh.length;
      if (added + alreadyThere < requested) {
        const reason = fresh.length > room || requested > MAX_ROUTE_STOPS
          ? `в маршруте не больше ${MAX_ROUTE_STOPS} точек`
          : 'остальные не найдены на карте';
        showToast(
          added === 0
            ? `Точки из ответа не добавлены: ${reason}.`
            : `Добавлено точек: ${added} из ${requested} — ${reason}.`,
          'warning',
        );
      }

      if (foundTargets.length > 0) {
        setRouteTargets(prev => {
          const merged = [...prev];
          foundTargets.forEach(ft => {
            if (merged.length < MAX_ROUTE_STOPS && !merged.some(t => t.id === ft.id)) {
              merged.push(ft);
            }
          });
          return merged;
        });
        setRouteData(null);
        if (foundTargets[0]) {
          setFlyToTarget([foundTargets[0].lat, foundTargets[0].lng]);
        }
      }
      setTargetStopsTrigger(null);
    } else if (buildRouteTrigger && enrichedDoctors.length > 0) {
      const bestMatch = sortedDoctors.find(d => !routeTargets.some(t => t.id === d.id));
      if (bestMatch && routeTargets.length < MAX_ROUTE_STOPS) {
        setRouteTargets(prev => [...prev, bestMatch]);
        setRouteData(null);
        setFlyToTarget([bestMatch.lat, bestMatch.lng]);
      }
      setBuildRouteTrigger(false);
    }
  }, [buildRouteTrigger, targetStopsTrigger, enrichedDoctors, sortedDoctors, routeTargets, showToast]);

  const toggleFavorite = useCallback((id) => {
    const adding = !favoritesRef.current.includes(id);
    setFavorites((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    if (accountRef.current?.user) {
      accountRef.current.syncFavorites(adding ? 'add' : 'remove', [id]).catch((error) => {
        // 401 — сессия кончилась, об этом уже сказал кабинет.
        if (error?.status === 401) return;
        showToast('Не удалось сохранить избранное в кабинете — изменение осталось в этом браузере.', 'warning');
      });
    }
  }, [setFavorites, showToast]);

  const handleRouteClick = useCallback((doc) => {
    if (!activeOrigin) {
      showToast('Точка отправления не найдена. Разрешите геолокацию или перетащите красный маркер.', 'warning');
      return;
    }

    setRouteTargets((prev) => {
      if (prev.length >= MAX_ROUTE_STOPS) {
        showToast(`Достигнут лимит в ${MAX_ROUTE_STOPS} точек для маршрута.`, 'warning');
        return prev;
      }
      if (prev.some((target) => target.id === doc.id)) {
        return prev;
      }

      setRouteData(null);
      setFlyToTarget([doc.lat, doc.lng]);
      return [...prev, doc];
    });
  }, [activeOrigin, showToast]);

  const focusPick = useCallback((pick) => {
    if (!Number.isFinite(pick?.lat) || !Number.isFinite(pick?.lng)) return;
    setIsFollowingUser(false);
    setFlyToTarget([pick.lat, pick.lng]);
    if (isMobile) setIsAIAssistantOpen(false);
  }, [isMobile]);

  const routePick = useCallback((pick) => {
    const doc = enrichedDoctorsRef.current.find((item) => item.id === pick.id);
    if (!doc) {
      showToast('Этот вариант больше не найден в справочнике.', 'warning');
      return;
    }
    handleRouteClick(doc);
    if (isMobile) setIsAIAssistantOpen(false);
  }, [handleRouteClick, isMobile, showToast]);

  const showAllPicks = useCallback(() => {
    setIsSidebarCollapsed(false);
    if (isMobile) {
      setIsAIAssistantOpen(false);
      setIsMobileFiltersOpen(true);
    }
    setTimeout(() => document.getElementById('results-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, [isMobile]);

  // --- Демо-запись ---------------------------------------------------------

  /*
   * Точка отправления для подбора — только настоящая: геолокация или точка,
   * поставленная вручную. Центр Казани по умолчанию — не местоположение
   * пользователя, и время в пути от него не считается.
   */
  const bookingOrigin = isManualOrigin && customOrigin ? customOrigin : isLocationReady && !locationError ? userLocation : null;

  // В браузере хранятся только записи гостя; список кабинета обновляется с сервера.
  const updateMyBookings = useCallback((next) => {
    setMyBookings(next);
    if (accountRef.current?.status !== 'user') writeMyBookings(next);
  }, []);

  const openBooking = useCallback((option, slot, patient = null) => {
    setBookingTarget({
      doctorId: option.doctor.id,
      branchId: option.clinic.branchId,
      serviceId: slot?.serviceId || option.service?.id || null,
      slotId: slot?.id || null,
      patient,
      doctorName: option.doctor.name,
      specialty: option.doctor.specialty,
      clinicName: option.clinic.name,
      branchName: option.clinic.branchName,
      address: option.clinic.address,
    });
  }, []);

  const openBookingForDoc = useCallback((doc, slot = null) => {
    if (!doc?.doctorId || !doc.branchId) return;
    setBookingTarget({
      doctorId: doc.doctorId,
      branchId: doc.branchId,
      serviceId: slot?.serviceId || null,
      slotId: slot?.id || null,
      patient: childrenOnly && doc.ageGroups?.includes('child') ? 'child' : null,
      doctorName: doc.name,
      specialty: doc.specialty,
      clinicName: doc.clinic,
      branchName: null,
      address: doc.address,
    });
  }, [childrenOnly]);

  const handleBooked = useCallback((booking) => {
    const stored = toStoredBooking(booking);
    if (stored) {
      // Запись без владельца (гость или сессия успела кончиться) — номер и код отмены остаются в браузере.
      if (!booking.owned) writeMyBookings([stored, ...readMyBookings().filter((item) => item.number !== stored.number)]);
      setMyBookings((current) => [stored, ...current.filter((item) => item.number !== stored.number)]);
    }
    setBookingsRefresh((value) => value + 1);
  }, []);

  const handleBookingCancelled = useCallback((booking) => {
    const markCancelled = (items) => items.map((item) => (item.number === booking.number ? { ...item, status: 'CANCELLED' } : item));
    setMyBookings(markCancelled);
    const local = readMyBookings();
    if (local.some((item) => item.number === booking.number)) writeMyBookings(markCancelled(local));
    setBookingsRefresh((value) => value + 1);
  }, []);

  /** Маршрут к клинике записи — тем же движком, что и обычный маршрут. */
  const routeToBooking = useCallback((booking) => {
    const itemId = booking.itemId || (booking.doctor && booking.clinic ? `${booking.doctor.id}--${booking.clinic.branchId}` : null);
    const doc = itemId ? enrichedDoctorsRef.current.find((item) => item.id === itemId) : null;
    if (!doc) {
      showToast('Клиника этой записи не найдена на карте.', 'warning');
      return;
    }
    setBookingTarget(null);
    handleRouteClick(doc);
    setIsRouteStarted(false);
    if (isMobile) setIsAIAssistantOpen(false);
  }, [handleRouteClick, isMobile, showToast]);

  // Маршрут к варианту подбора: по кнопке «Маршрут» или сам, если маршрут просили в чате.
  const routeToOption = useCallback((option, { auto = false } = {}) => {
    const itemId = option?.doctor?.id && option?.clinic?.branchId ? `${option.doctor.id}--${option.clinic.branchId}` : null;
    const doc = itemId ? enrichedDoctorsRef.current.find((item) => item.id === itemId) : null;
    if (!doc) {
      if (!auto) showToast('Клиника этого варианта не найдена на карте.', 'warning');
      return;
    }
    handleRouteClick(doc);
    // Сам проложенный маршрут не закрывает чат: человек ещё выбирает время.
    if (isMobile && !auto) setIsAIAssistantOpen(false);
  }, [handleRouteClick, isMobile, showToast]);

  const requestBookingOrigin = useCallback(() => {
    setIsFollowingUser(false);
    setFlyToTarget(activeOrigin);
    if (isMobile) setIsAIAssistantOpen(false);
    showToast('Перетащите красную точку на карте туда, откуда поедете, — подбор пересчитается.', 'info', 6000);
  }, [activeOrigin, isMobile, showToast]);

  const choosePlanFromChat = useCallback((planId) => {
    setDmsPlanId(planId);
    if (account.user) {
      account.setPlan(planId).catch((error) => {
        if (error?.status !== 401) showToast('Не удалось сохранить программу в кабинете — она сохранена в этом браузере.', 'warning');
      });
    }
  }, [account, setDmsPlanId, showToast]);

  // Избранное для кабинета: id из аккаунта → записи справочника на карте.
  const favoriteDetails = useMemo(() => {
    if (!isAccountOpen) return [];
    const byId = new Map(enrichedDoctors.map((doc) => [doc.id, doc]));
    return [...favorites].reverse().map((id) => {
      const doc = byId.get(id);
      if (!doc) return { id, name: 'Запись больше не найдена', subtitle: 'Её убрали из справочника — можно удалить', found: false };
      const subtitle = doc.entityKind === 'doctor'
        ? [doc.doctorProfile || doc.specialty, doc.clinic].filter(Boolean).join(' · ')
        : [doc.facilityType, doc.address].filter(Boolean).join(' · ');
      return { id, name: doc.name, subtitle, lat: doc.lat, lng: doc.lng, found: true };
    });
  }, [isAccountOpen, enrichedDoctors, favorites]);

  const focusFavorite = useCallback((item) => {
    if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) return;
    setIsAccountOpen(false);
    setIsFollowingUser(false);
    setFlyToTarget([item.lat, item.lng]);
    if (isMobile) setIsMobileFiltersOpen(false);
  }, [isMobile]);

  const selectPlanFromAccount = useCallback(async (planId) => {
    await account.setPlan(planId);
    setDmsPlanId(planId);
    if (!planId) setDmsOnly(false);
  }, [account, setDmsPlanId]);

  const handleGoToNearest = () => {
    if (!nearestOpenDoctor) {
      showToast('Сейчас нет открытых мест с известным графиком работы.', 'warning');
      return;
    }
    if (routeTargets.length > 0) {
      // Не затираем собранный маршрут: добавляем точку, как кнопка «В маршрут» у карточки.
      handleRouteClick(nearestOpenDoctor);
      setIsFollowingUser(false);
      return;
    }
    setRouteTargets([nearestOpenDoctor]);
    setRouteData(null);
    setIsFollowingUser(false);
    setFlyToTarget([nearestOpenDoctor.lat, nearestOpenDoctor.lng]);
  };

  /*
   * Ссылки «Как добраться» в Яндекс Карты и 2ГИС. Точка отправления передаётся
   * всегда — та же, от которой построен наш маршрут (геолокация или красный
   * маркер): иначе навигатор спрашивает «Откуда?» и маршрут расходится с нашим.
   */
  const renderExternalRouteLinks = (targets, { doc = null, label = 'Как добраться:', className = '' } = {}) => {
    if (!targets || targets.length === 0) return null;
    const origin = activeOrigin;
    const mode = EXTERNAL_MODE_BY_TRAVEL_MODE[travelMode] || 'auto';
    const links = [
      { provider: 'yandex', mode, text: 'Яндекс Карты' },
      { provider: '2gis', mode, text: '2ГИС' },
      // Общественного транспорта в нашем движке нет — для него ведём в Яндекс.
      { provider: 'yandex', mode: 'transit', text: 'На транспорте', icon: Bus },
    ];
    return (
      <div className={`flex flex-wrap items-center gap-1.5 text-xs ${className}`}>
        {label && <span className="mr-0.5 text-slate-500 dark:text-slate-400">{label}</span>}
        {links.map((link) => {
          const href = buildExternalRouteUrl(link.provider, origin, targets, link.mode);
          if (!href) return null;
          return (
            <a
              key={`${link.provider}-${link.mode}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackExternalMap(link.provider, link.mode, targets, doc)}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:text-blue-300"
            >
              {link.icon && <link.icon size={12} aria-hidden="true" />}
              {link.text}
              <ExternalLink size={10} className="opacity-50" aria-hidden="true" />
            </a>
          );
        })}
      </div>
    );
  };

  const stableSetRouteData = useCallback((data) => {
    setRouteData(data);
  }, []);

  const clearRoute = useCallback(() => {
    setRouteTargets([]);
    setRouteData(null);
    setIsRoutePanelCollapsed(true);
    setIsRouteStarted(false);
  }, []);

  const removeFromRoute = useCallback((docId) => {
    setRouteTargets(prev => prev.filter(t => t.id !== docId));
    setRouteData(null);
    // Убрали последнюю точку — режим «маршрут начат» заканчивается: иначе карта
    // прячет все маркеры, а панели, чтобы их вернуть, уже нет.
    if (routeTargets.every((target) => target.id === docId)) {
      setIsRouteStarted(false);
    }
  }, [routeTargets]);

  const [draggedTargetIndex, setDraggedTargetIndex] = useState(null);

  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, idx) => {
    e.dataTransfer.setData('text/plain', idx.toString());
    setDraggedTargetIndex(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedTargetIndex !== null && draggedTargetIndex !== idx) {
      setDragOverIndex(idx);
    }
  };

  const handleDrop = (e, idx) => {
    e.preventDefault();
    /*
     * Индекс берётся из состояния, а не из перетаскиваемого текста: на список
     * можно бросить любой текст со страницы (например, «+7 (843)…»), и
     * parseInt даст индекс за пределами списка.
     */
    const sourceIdx = draggedTargetIndex;

    if (sourceIdx === null || sourceIdx === idx) {
      setDragOverIndex(null);
      return;
    }

    setRouteTargets(prev => {
      if (sourceIdx < 0 || sourceIdx >= prev.length || idx < 0 || idx >= prev.length) {
        return prev;
      }
      const newTargets = [...prev];
      const [movedItem] = newTargets.splice(sourceIdx, 1);
      newTargets.splice(idx, 0, movedItem);
      return newTargets;
    });

    setRouteData(null);
    setDraggedTargetIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedTargetIndex(null);
    setDragOverIndex(null);
  };

  // Touch-friendly: move route target up/down by index
  const moveRouteTarget = useCallback((fromIdx, toIdx) => {
    setRouteTargets(prev => {
      if (toIdx < 0 || toIdx >= prev.length) return prev;
      const newTargets = [...prev];
      const [moved] = newTargets.splice(fromIdx, 1);
      newTargets.splice(toIdx, 0, moved);
      return newTargets;
    });
    setRouteData(null);
  }, []);

  const markerNodes = useMemo(() => {
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 390;
    // Группировка по координатам: десятки маркеров друг на друге дают чёрный
    // ореол из теней.
    const groupsMap = new Map();

    sortedDoctors.forEach((doc) => {
      const routeIndex = routeTargets.findIndex((t) => t.id === doc.id);
      const isRouteTarget = routeIndex !== -1;

      if (routeStarted && !isRouteTarget) {
        return;
      }

      if (!routeStarted && cardDisplayMode !== 'all' && doc.entityKind !== cardDisplayMode) {
        return;
      }

      const key = `${Number(doc.lat).toFixed(5)},${Number(doc.lng).toFixed(5)}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          key,
          lat: doc.lat,
          lng: doc.lng,
          items: [],
        });
      }
      groupsMap.get(key).items.push({ ...doc, routeIndex, isRouteTarget });
    });

    return Array.from(groupsMap.values()).map((group) => {
      const { key, lat, lng, items } = group;
      // Есть точка маршрута среди врачей группы — маркер маршрутный.
      const targetItem = items.find((it) => it.isRouteTarget);
      const isRouteTarget = Boolean(targetItem);
      const routeIndex = targetItem ? targetItem.routeIndex : -1;

      const hasFavorite = items.some((it) => it.isFavorite);
      const isGovernment = items.some((it) => /государ/i.test(String(it.ownership || '')));
      const ownershipIcon = isGovernment ? blueArrowIcon : violetArrowIcon;

      const icon = isRouteTarget
        ? routeIconFor(routeIndex + 1)
        : hasFavorite
          ? amberArrowIcon
          : ownershipIcon;

      const primary = targetItem || items[0];
      const isSingle = items.length === 1;

      const popupRouteButtonClasses = (isTarget) =>
        isTarget
          ? 'mt-2 w-full text-xs font-medium py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all bg-red-50 text-red-600 border border-red-200'
          : 'mt-2 w-full text-xs font-medium py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800';

      return (
        <Marker
          key={`group-${key}`}
          position={stablePosition(key, lat, lng)}
          icon={icon}
          eventHandlers={{ popupopen: () => track('result_open', { surface: 'map', ...placeFields(primary) }) }}
        >
          <Popup
            // На телефоне окно не шире экрана. Высоту держат полосы прокрутки
            // внутри списка (PlaceDoctorList), а не maxHeight окна: с ним
            // прокрутка списка пальцем сдвигает карту.
            maxWidth={isMobile ? Math.min(320, viewportWidth - 48) : isSingle ? 300 : 360}
            minWidth={isMobile ? Math.min(260, viewportWidth - 64) : isSingle ? 240 : 300}
            // Открытая панель маршрута (справа) не должна закрывать окно.
            // У Leaflet отступ справа задаётся парой «снизу-справа».
            autoPanPaddingBottomRight={!isMobile && routeTargets.length > 0 ? [360, 24] : [24, 24]}
          >
            {/*
              Клик внутри окна не должен доходить до карты: React успевает убрать
              нажатую кнопку (сердечко, «в маршрут») из DOM, Leaflet не находит
              окно среди её предков, считает это кликом по карте и закрывает окно.
            */}
            <div
              className={`${isSingle ? 'min-w-[240px] max-w-[300px]' : 'w-full'} pb-1 dark:text-white`}
              onClick={(event) => event.stopPropagation()}
            >
              <strong className="mb-1 block text-lg font-bold leading-tight text-blue-600 dark:text-blue-400">
                {primary.clinic || primary.name}
              </strong>
              {primary.address && (
                <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">{primary.address}</div>
              )}

              {isSingle ? (
                <div>
                  <span className="text-sm font-medium text-slate-600 dark:text-slate-400">{primary.specialty}</span>
                  <br />
                  <span className="text-base text-slate-800 dark:text-white">{primary.name}</span>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    <span
                      className={`rounded-full px-2 py-1 font-semibold ${
                        primary.openState === OPEN_STATE.OPEN
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {primary.openState === OPEN_STATE.OPEN
                        ? 'Открыто'
                        : primary.openState === OPEN_STATE.CLOSED
                          ? 'Закрыто'
                          : 'График не указан'}
                    </span>
                    <span
                      className={`rounded-full px-2 py-1 font-semibold ${
                        isGovernment
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-200'
                      }`}
                    >
                      {primary.ownership || 'Не указано'}
                    </span>
                    {primary.district && (
                      <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        {primary.district}
                      </span>
                    )}
                  </div>
                  {primary.todayHours && (
                    <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">Сегодня: {primary.todayHours}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => (primary.isRouteTarget ? removeFromRoute(primary.id) : handleRouteClick(primary))}
                    className={popupRouteButtonClasses(primary.isRouteTarget)}
                  >
                    {primary.isRouteTarget ? <XCircle size={15} /> : <Navigation size={15} />}
                    {primary.isRouteTarget ? 'Убрать из маршрута' : 'Добавить в маршрут'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(primary.id)}
                    className={`mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                      primary.isFavorite
                        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-200'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400'
                    }`}
                  >
                    {primary.isFavorite ? <Heart size={14} fill="currentColor" /> : <HeartOff size={14} />}{' '}
                    {primary.isFavorite ? 'В избранном' : 'В избранное'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailsId(primary.id)}
                    className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-all hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                    data-testid="popup-details"
                  >
                    Подробнее{primary.demo && primary.entityKind === 'doctor' ? ' и расписание' : ''}
                  </button>
                </div>
              ) : (
                <PlaceDoctorList
                  items={items}
                  onAddToRoute={handleRouteClick}
                  onRemoveFromRoute={removeFromRoute}
                  onToggleFavorite={toggleFavorite}
                  onOpenDetails={setDetailsId}
                />
              )}
            </div>
          </Popup>
        </Marker>
      );
    });
  }, [sortedDoctors, routeTargets, cardDisplayMode, routeStarted, removeFromRoute, handleRouteClick, toggleFavorite, isMobile, placeFields]);

  const resetToGPS = () => {
    setIsManualOrigin(false);
    setCustomOrigin(null);
    setIsFollowingUser(true); // Включаем для синей иконки кнопки
    setRouteData(null);
    setFlyToTarget(userLocation);
  };

  const clearFilters = () => {
    setSearchQuery('');
    setIsSearchFocused(false);
    setSelectedFacilityType('all');
    setSelectedClinic('all');
    setSelectedDistrict('all');
    setSelectedDoctorProfile('all');
    setSelectedOwnership('all');
    setCardDisplayMode('all');
    setSelectedServices([]);
    setFavoritesOnly(false);
    setOpenOnly(false);
    setWeekendOnly(false);
    setEveningOnly(false);
    setOnlineOnly(false);
    setWheelchairOnly(false);
    setChildrenOnly(false);
    setMinRating(0);
    setMinExperience(0);
    setMaxDistance(0);
    setMaxTravelMinutes(0);
    setDmsOnly(false);
    setSortBy('recommendation');
    setVisibleCount(PAGE_SIZE);
  };

  const handleSearchSuggestionSelect = (value) => {
    setSearchQuery(value);
    setIsSearchFocused(false);
  };

  const handleMobileSheetTouchStart = (event) => {
    if (!isMobile) {
      return;
    }
    mobileSheetTouchStartYRef.current = event.touches[0].clientY;
  };

  const handleMobileSheetTouchMove = (event) => {
    if (!isMobile || mobileSheetTouchStartYRef.current == null) {
      return;
    }

    const currentY = event.touches[0].clientY;
    const delta = Math.max(0, currentY - mobileSheetTouchStartYRef.current);
    setMobileSheetDragOffset(delta);
  };

  const handleMobileSheetTouchEnd = () => {
    if (!isMobile) {
      return;
    }

    if (mobileSheetDragOffset > 90) {
      setIsMobileFiltersOpen(false);
    }

    mobileSheetTouchStartYRef.current = null;
    setMobileSheetDragOffset(0);
  };

  // Mouse support for drag handle (desktop testing)
  const handleMobileSheetMouseDown = (event) => {
    if (!isMobile) return;
    mobileSheetTouchStartYRef.current = event.clientY;
    const onMouseMove = (e) => {
      if (mobileSheetTouchStartYRef.current == null) return;
      const delta = Math.max(0, e.clientY - mobileSheetTouchStartYRef.current);
      setMobileSheetDragOffset(delta);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      handleMobileSheetTouchEnd();
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // variant: false — крупная кнопка (окно подробностей), true — окно на карте, 'compact' — краткая карточка списка.
  const renderRouteButton = (doc, variant = false) => {
    const isPopup = variant === true;
    const isTarget = routeTargets.some(t => t.id === doc.id);
    const commonClasses = isPopup
      ? 'mt-3 w-full text-sm font-medium py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all'
      : variant === 'compact'
        ? 'h-full min-h-8 min-w-9 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg inline-flex items-center justify-center gap-1.5 transition-all border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-700 dark:hover:text-blue-100'
        : 'w-full flex-1 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white font-medium px-5 py-2.5 rounded-xl inline-flex items-center justify-center gap-2.5 transition-all border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-700 dark:hover:text-blue-100';
    const iconSize = isPopup ? 16 : variant === 'compact' ? 13 : 18;

    const redClasses = isPopup
      ? `${commonClasses} bg-red-50 text-red-600 border border-red-200`
      : `${commonClasses} bg-red-50 text-red-600 hover:bg-red-600 hover:text-white border-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-700 dark:hover:text-red-100 dark:border-red-800`;

    const compact = variant === 'compact';
    // В краткой карточке подпись видна, только если хватает ширины (контейнер карточки ≥ 21rem).
    const compactLabel = (text) => <span className="hidden @min-[21rem]:inline">{text}</span>;
    if (isTarget) {
      return (
        <button type="button" onClick={() => removeFromRoute(doc.id)} className={redClasses} aria-label={compact ? 'Убрать из маршрута' : undefined} title={compact ? 'Убрать из маршрута' : undefined}>
          <XCircle size={iconSize} className="shrink-0" /> {isPopup ? 'Убрать' : compact ? compactLabel('Убрать') : 'Убрать из маршрута'}
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => handleRouteClick(doc)}
        className={isPopup ? `${commonClasses} bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800` : commonClasses}
        aria-label={compact ? 'Добавить в маршрут' : undefined}
        title={compact ? 'Добавить в маршрут' : undefined}
      >
        <Navigation size={iconSize} className="shrink-0" /> {isPopup ? 'Показать путь' : compact ? compactLabel('В маршрут') : 'Добавить в маршрут'}
      </button>
    );
  };

  // Краткая карточка списка: кто, где, сколько ехать, цена, ДМС и действия;
  // остальное — в окне «Подробнее».
  const renderListingCard = (doc, index = 0) => {
    const isTarget = routeTargets.some((t) => t.id === doc.id);
    const isDoctorCard = doc.entityKind === 'doctor';
    const distanceLabel = doc.distanceKm == null ? null : formatDistance(doc.distanceKm * 1000);
    const dmsBadge = dmsPlan && doc.dmsCoverage ? coverageBadge(doc.dmsCoverage, dmsPlan) : null;
    const subtitle = isDoctorCard ? doc.doctorProfile || doc.specialty : doc.facilityType || doc.specialty;
    const openDetails = () => {
      track('result_open', { surface: 'list', rank: Math.min(index + 1, 500), ...placeFields(doc) });
      setDetailsId(doc.id);
    };

    return (
      <div
        key={doc.id}
        className={`card-fade-in @container rounded-2xl border bg-white p-3 shadow-sm transition-all dark:bg-slate-800 dark:text-white ${isTarget ? 'border-blue-400 ring-2 ring-blue-100 dark:border-blue-500 dark:ring-blue-900' : isDoctorCard ? 'border-blue-100 hover:shadow-md dark:border-blue-900' : 'border-emerald-100 hover:shadow-md dark:border-emerald-900'}`}
        data-testid="place-card"
      >
        <div className="flex items-start gap-2">
          <button type="button" onClick={openDetails} className="min-w-0 flex-1 text-left" aria-label={`Подробнее: ${doc.name}`}>
            <h3 className="text-[15px] font-extrabold leading-5 text-slate-800 hover:text-blue-700 dark:text-white dark:hover:text-blue-300">{doc.name}</h3>
            <p className="mt-0.5 truncate text-xs font-semibold text-blue-600 dark:text-blue-400">
              {subtitle}{isDoctorCard && doc.experience > 0 ? ` · стаж ${doc.experience} ${pluralYears(doc.experience)}` : ''}
            </p>
            <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{isDoctorCard ? doc.clinic : doc.address}</p>
          </button>
          <button
            type="button"
            onClick={() => toggleFavorite(doc.id)}
            className={`shrink-0 rounded-full border p-1.5 transition-all ${doc.isFavorite ? 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-300' : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400'}`}
            title={doc.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
            aria-label={doc.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
          >
            {doc.isFavorite ? <Heart size={16} fill="currentColor" /> : <HeartOff size={16} />}
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
          {doc.demo && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 uppercase tracking-[0.08em] text-amber-800 dark:bg-amber-900 dark:text-amber-100" title={doc.realClinic ? 'Клиника реальная, врачи и расписание вымышлены' : 'Вымышленная запись для проверки сценариев'}>
              <FlaskConical size={11} aria-hidden="true" /> Демо
            </span>
          )}
          {doc.realClinic && (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700 dark:bg-sky-900/50 dark:text-sky-200" title="Название, адрес и часы — из OpenStreetMap">Реальная клиника</span>
          )}
          {doc.openState === OPEN_STATE.OPEN && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100">Открыто</span>}
          {doc.openState === OPEN_STATE.CLOSED && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500 dark:bg-slate-700 dark:text-slate-300">Закрыто</span>}
          {distanceLabel && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300">{distanceLabel}</span>}
          {doc.travelSeconds != null && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-900 dark:text-blue-200" title={doc.travelApproximate ? 'Оценка по расстоянию: точное время ещё считается' : 'Время по дорогам, без учёта пробок'}>
              <Timer size={11} aria-hidden="true" /> {doc.travelApproximate ? '≈ ' : ''}{Math.max(1, Math.round(doc.travelSeconds / 60))} мин
            </span>
          )}
          {Number.isFinite(doc.consultPrice) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              <Wallet size={11} aria-hidden="true" /> от {doc.consultPrice.toLocaleString('ru-RU')} ₽
            </span>
          )}
          {dmsBadge && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${dmsBadge.tone === 'covered' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
              <ShieldCheck size={11} aria-hidden="true" /> {dmsBadge.tone === 'covered' ? 'ДМС' : 'не по ДМС'}
            </span>
          )}
        </div>

        {/*
          Кнопки — одной строкой при любой ширине панели: на узкой (планшет)
          у «В маршрут» остаётся значок, подпись — в aria-label и подсказке.
        */}
        <div className="mt-2.5 flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={openDetails}
            className="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:border-blue-300 hover:text-blue-700 dark:border-slate-600 dark:text-slate-200"
            data-testid="place-card-details"
          >
            <span className="truncate">{doc.demo && isDoctorCard && demoState.booking ? 'Расписание' : 'Подробнее'}</span>
          </button>
          {doc.demo && isDoctorCard && demoState.booking && doc.doctorId && (
            <button
              type="button"
              onClick={() => openBookingForDoc(doc)}
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-violet-600 px-2 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-violet-700"
              data-testid="card-book-button"
            >
              <CalendarCheck size={13} className="shrink-0" aria-hidden="true" /> <span className="truncate">Записаться</span>
            </button>
          )}
          <div className="shrink-0">{renderRouteButton(doc, 'compact')}</div>
        </div>
      </div>
    );
  };

  const renderPlaceDetails = (doc) => {
    const isDoctorCard = doc.entityKind === 'doctor';
    const distanceLabel = doc.distanceKm == null ? 'Геолокация недоступна' : formatDistance(doc.distanceKm * 1000);
    const hasVisibleDescription = Boolean((doc.description || '').trim()) && !/данные из openstreetmap/i.test(String(doc.description));
    // В окне подробностей график на неделю виден сразу — без лишнего нажатия.
    const isScheduleOpen = true;
    const isState = doc.ownership === 'Государственная';
    const oms = omsHint(doc);
    const referralUrl = withReferral(doc.websiteUrl, 'card');
    const verifiedLabel = formatVerifiedAt(doc.verifiedAt);
    const verifiedDays = daysSince(doc.verifiedAt, now);
    const isOsm = /^osm$/i.test(String(doc.source || '')) || /^osm-/.test(String(doc.id || ''));
    const dmsBadge = dmsPlan && doc.dmsCoverage ? coverageBadge(doc.dmsCoverage, dmsPlan) : null;
    const pultHref = dmsProvider ? toTelHref(dmsProvider.pultPhone) : null;

    return (
      <div className="text-slate-800 dark:text-white" data-testid="place-details-body">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${isDoctorCard ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-100' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100'}`}>
                {isDoctorCard ? 'Врач' : 'Учреждение'}
              </span>
              {doc.demo && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-amber-800 dark:bg-amber-900 dark:text-amber-100" title="Вымышленная запись для проверки сценариев">
                  <FlaskConical size={12} aria-hidden="true" /> Демо
                </span>
              )}
              {doc.openState === OPEN_STATE.OPEN && (
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100">
                  Открыто сейчас
                </span>
              )}
              {doc.openState === OPEN_STATE.CLOSED && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                  Закрыто
                </span>
              )}
              {doc.openState === OPEN_STATE.UNKNOWN && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100/70 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400 dark:bg-slate-700/60 dark:text-slate-400"
                  title="В источнике данных нет расписания этого объекта"
                >
                  <HelpCircle size={12} aria-hidden="true" /> График не указан
                </span>
              )}
            </div>
            <p className="break-words text-sm font-semibold text-blue-600 dark:text-blue-400">{isDoctorCard ? doc.doctorProfile || doc.specialty : doc.facilityType || doc.specialty}</p>
          </div>

          <button
            type="button"
            onClick={() => toggleFavorite(doc.id)}
            className={`rounded-full border p-2 transition-all ${doc.isFavorite ? 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-300' : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400'}`}
            title={doc.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
          >
            {doc.isFavorite ? <Heart size={18} fill="currentColor" /> : <HeartOff size={18} />}
          </button>
        </div>

        {/* Trust badges */}
        {doc.trustBadges && doc.trustBadges.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {doc.trustBadges.slice(0, 3).map((badge) => (
              <span key={badge} className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-200">
                ⭐ {badge}
              </span>
            ))}
          </div>
        )}

        {/* Запись взята с официального сайта учреждения — ссылка, чтобы проверить самому. */}
        {toSafeUrl(doc.sourceUrl) ? (
          <a
            href={toSafeUrl(doc.sourceUrl)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackContact(doc, 'source')}
            className={`mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
              verifiedDays != null && verifiedDays > STALE_AFTER_DAYS
                ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
            }`}
            title="Данные с официального сайта учреждения — откройте, чтобы сверить"
          >
            <ShieldCheck size={13} aria-hidden="true" />
            {verifiedLabel ? `Официальный сайт · проверено ${verifiedLabel}` : 'Проверено по официальному сайту'}
            <ExternalLink size={11} className="opacity-60" aria-hidden="true" />
          </a>
        ) : doc.demo && doc.realClinic ? (
          <p className="mt-3 text-[11px] leading-4 text-amber-700 dark:text-amber-300" data-testid="real-clinic-note">
            Клиника реальная: название, адрес, точка и часы работы — из OpenStreetMap. {isDoctorCard ? 'Врач, его расписание и цены' : 'Врачи, расписание и цены'} — вымышленные, демонстрационные; запись в клинику не уходит, телефон клиники в демо не показываем.
          </p>
        ) : doc.demo ? (
          <p className="mt-3 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            Демо-данные: вымышленная клиника для проверки сценариев. Сайт и телефон не настоящие.
          </p>
        ) : isOsm ? (
          <p className="mt-3 text-[11px] leading-4 text-slate-400 dark:text-slate-500" title="Открытые данные OpenStreetMap: адрес и часы работы могут быть неточны">
            Данные: OpenStreetMap · часы и телефон уточняйте
          </p>
        ) : null}
        {doc.missingSince && (
          <p className="mt-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            При проверке {formatVerifiedAt(doc.missingSince)} врача не нашли на странице учреждения — уточните по телефону, принимает ли он.
          </p>
        )}
        {verifiedDays != null && verifiedDays > STALE_AFTER_DAYS && (
          <p className="mt-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            Сведения проверялись {verifiedDays} дн. назад — перед визитом уточните расписание.
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-slate-600 sm:grid-cols-2 dark:text-slate-300">
          <div className="flex items-center gap-2">
            {isDoctorCard ? <UserRound size={16} className="shrink-0 text-slate-400 dark:text-slate-500" /> : <Hospital size={16} className="shrink-0 text-slate-400 dark:text-slate-500" />}
            <span className="break-words">{doc.clinic}</span>
          </div>
          <div className="flex items-center gap-2">
            <MapPin size={16} className="shrink-0 text-slate-400 dark:text-slate-500" />
            <span className="break-words">{doc.address}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={16} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
            {doc.weekSchedule ? (
              <span>Сегодня: {doc.todayHours}</span>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">График не указан</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isDoctorCard ? <TrendingUp size={16} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" /> : <Building2 size={16} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
            <span>{isDoctorCard ? `Стаж: ${doc.experience > 0 ? `${doc.experience} ${pluralYears(doc.experience)}` : 'не указан'}` : `Тип: ${doc.facilityType || doc.specialty}`}</span>
          </div>
        </div>

        {doc.demo && isDoctorCard && demoState.booking && doc.doctorId && doc.branchId && (
          <DemoDoctorSchedule
            doctorId={doc.doctorId}
            branchId={doc.branchId}
            planId={dmsPlan?.id || null}
            patient={childrenOnly && doc.ageGroups?.includes('child') ? 'child' : null}
            onPick={(slot) => openBookingForDoc(doc, slot)}
          />
        )}

        {/* Расписание на неделю из doc.schedule. */}
        {isScheduleOpen && doc.weekSchedule && (
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <caption className="sr-only">Расписание работы на неделю</caption>
              <tbody>
                {doc.weekSchedule.map((day) => (
                  <tr
                    key={day.key}
                    className={`border-b border-slate-100 last:border-0 dark:border-slate-700/70 ${
                      day.isToday ? 'bg-blue-50 font-semibold dark:bg-blue-900/30' : ''
                    }`}
                  >
                    <th scope="row" className="px-3 py-1.5 text-left font-medium text-slate-600 dark:text-slate-300">
                      {day.label}
                      {day.isToday && <span className="ml-2 text-[10px] uppercase tracking-wider text-blue-600 dark:text-blue-400">сегодня</span>}
                    </th>
                    <td className={`px-3 py-1.5 text-right ${day.isDayOff ? 'text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-200'}`}>
                      {day.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Цены: диапазоны из servicePrices. */}
        {doc.servicePrices.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
            <div className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
              <Wallet size={14} aria-hidden="true" /> Стоимость услуг
            </div>
            <ul className="space-y-1">
              {doc.servicePrices.map((price) => (
                <li key={price.service} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-slate-600 dark:text-slate-300">{price.service}</span>
                  <span className="shrink-0 font-semibold text-slate-800 tabular-nums dark:text-white">{price.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
              {doc.demo ? 'Демо-цены, вымышленные.' : 'Ориентировочные цены. Уточняйте в учреждении.'}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {isDoctorCard ? (
            // Без рейтинга бейджа нет: «Рейтинг: н/д» ничего не сообщает.
            doc.rating > 0 && (
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-200">
                <Star size={13} className="inline-block -translate-y-[1px]" fill="currentColor" /> {doc.rating}
              </span>
            )
          ) : (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">{doc.facilityType || doc.specialty}</span>
          )}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{doc.ownership}</span>
          {doc.district && <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{doc.district}</span>}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{distanceLabel}</span>
          {doc.travelSeconds != null && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200"
              title={doc.travelApproximate ? 'Оценка по расстоянию: точное время ещё считается' : 'Время по дорогам, без учёта пробок'}
            >
              <Timer size={12} aria-hidden="true" />
              {doc.travelApproximate ? '≈ ' : ''}{Math.max(1, Math.round(doc.travelSeconds / 60))} мин {TRAVEL_MODE_LABEL[travelMode] || ''}
            </span>
          )}
          {doc.features.onlineBooking && <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Онлайн-запись</span>}
          {doc.features.wheelchair && <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200">Доступная среда</span>}
          {doc.features.children && <span className="rounded-full bg-pink-50 px-3 py-1 text-xs font-semibold text-pink-700 dark:bg-pink-900 dark:text-pink-200">Детский приём</span>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {/* Тип учреждения уже показан отдельной меткой выше — не повторяем. */}
          {(doc.services || []).filter((service) => isDoctorCard || service !== (doc.facilityType || doc.specialty)).map((service) => (
            <span key={service} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {service}
            </span>
          ))}
        </div>

        {hasVisibleDescription && <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-400">{doc.description}</p>}

        {/*
          ДМС: покрытие выбранной программой, считается в браузере.
          «Через пульт» — кнопка звонка на пульт страховой.
        */}
        {dmsBadge && dmsBadge.tone === 'covered' && (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs leading-5 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
            <p className="inline-flex items-center gap-1.5 font-bold"><ShieldCheck size={14} aria-hidden="true" /> {dmsBadge.text}</p>
            {dmsBadge.detail && <p className="mt-0.5">Как попасть: {dmsBadge.detail}.</p>}
            {doc.dmsCoverage.notes && <p className="mt-0.5">{doc.dmsCoverage.notes}</p>}
            {doc.dmsCoverage.access === 'direct' && <p className="mt-0.5">Назовите в регистратуре номер полиса и программу.</p>}
            {pultHref && ['via_pult', 'approval_required'].includes(doc.dmsCoverage.access) && (
              <a
                href={pultHref}
                onClick={() => trackContact(doc, 'pult')}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                <Phone size={13} aria-hidden="true" /> Позвонить на пульт {dmsProvider.name}
              </a>
            )}
          </div>
        )}
        {dmsBadge && dmsBadge.tone === 'not_covered' && (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {dmsBadge.text}{dmsBadge.detail ? `: ${dmsBadge.detail}` : ''}.
          </p>
        )}

        {/* Своей записи у МедКарты нет: ведём туда, где записываются, с пояснением по ОМС. */}
        {oms && (
          <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/60 p-3 text-xs leading-5 text-slate-600 dark:border-blue-900 dark:bg-blue-950/30 dark:text-slate-300">
            <p>{oms.text}</p>
            <a
              href={GOSUSLUGI_APPOINTMENT_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackContact(doc, 'gosuslugi')}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
            >
              <CalendarCheck size={14} aria-hidden="true" /> Записаться через Госуслуги
              <ExternalLink size={11} className="opacity-70" aria-hidden="true" />
            </a>
          </div>
        )}

        {(doc.telHref || referralUrl || (doc.demo && demoState.booking)) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {doc.demo && isDoctorCard && demoState.booking && doc.doctorId && (
              <button
                type="button"
                onClick={() => openBookingForDoc(doc)}
                className="inline-flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
                data-testid="card-book-button"
              >
                <CalendarCheck size={16} aria-hidden="true" /> Записаться (демо)
              </button>
            )}
            {!isState && referralUrl && !(doc.demo && demoState.booking) && (
              <a
                href={referralUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackContact(doc, 'website')}
                className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                <CalendarCheck size={16} aria-hidden="true" /> Записаться на сайте
                <ExternalLink size={13} className="opacity-70" aria-hidden="true" />
              </a>
            )}
            {doc.telHref && (
              <a
                href={doc.telHref}
                onClick={() => trackContact(doc, 'phone')}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              >
                <Phone size={16} aria-hidden="true" /> {doc.phone}
              </a>
            )}
            {isState && referralUrl && (
              <a
                href={referralUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackContact(doc, 'website')}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
              >
                <Globe size={16} aria-hidden="true" /> Сайт
                <ExternalLink size={13} className="opacity-60" aria-hidden="true" />
              </a>
            )}
          </div>
        )}

        {renderExternalRouteLinks([doc], { doc, className: 'mt-3' })}

        <div className={`mt-4 grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {renderRouteButton(doc, false)}
          <button
            type="button"
            onClick={() => toggleFavorite(doc.id)}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 font-semibold transition-all ${doc.isFavorite ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-200' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400 dark:hover:bg-slate-600'}`}
          >
            {doc.isFavorite ? <Heart size={16} fill="currentColor" /> : <HeartOff size={16} />}
            {doc.isFavorite ? 'В избранном' : 'В избранное'}
          </button>
        </div>

        {PLACE_ID_PATTERN.test(String(doc.id)) && (
          <DataReportButton
            onReport={(reason) => track('data_report', { reason, kind: isDoctorCard ? 'doctor' : 'facility', placeId: String(doc.id) })}
          />
        )}
      </div>
    );
  };

  if (!isLocationReady) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#f4f7fb] dark:bg-slate-900">
        <div className="flex flex-col items-center gap-3 text-blue-600 dark:text-blue-400">
          <Loader2 className="animate-spin" size={48} />
          <h2 className="text-xl font-semibold">Определяем местоположение...</h2>
        </div>
      </div>
    );
  }

  const filters = {
    searchQuery, cardDisplayMode, doctorProfile: selectedDoctorProfile,
    facilityType: selectedFacilityType, ownership: selectedOwnership,
    clinic: selectedClinic, district: selectedDistrict, services: selectedServices,
    childrenOnly, openOnly, favoritesOnly, weekendOnly, eveningOnly,
    onlineOnly, wheelchairOnly, minRating, minExperience, maxDistance,
    maxTravelMinutes, dmsOnly,
  };
  const filterSetters = {
    searchQuery: setSearchQuery, doctorProfile: setSelectedDoctorProfile,
    facilityType: setSelectedFacilityType, ownership: setSelectedOwnership,
    clinic: setSelectedClinic, district: setSelectedDistrict, services: setSelectedServices,
    childrenOnly: setChildrenOnly, openOnly: setOpenOnly, favoritesOnly: setFavoritesOnly,
    weekendOnly: setWeekendOnly, eveningOnly: setEveningOnly,
    onlineOnly: setOnlineOnly, wheelchairOnly: setWheelchairOnly,
    minRating: setMinRating, minExperience: setMinExperience, maxDistance: setMaxDistance,
    maxTravelMinutes: setMaxTravelMinutes,
    dmsOnly: setDmsOnly,
  };
  const handleFilterChange = (field, value) => {
    // «По моему ДМС» без выбранной программы — сначала выбрать программу.
    if (field === 'dmsOnly' && value && !dmsPlan) {
      setIsDmsPanelOpen(true);
      setDmsOnly(true);
      return;
    }
    if (field === 'cardDisplayMode') {
      setCardDisplayMode(value);
      // При смене раздела убираем условия, относящиеся только к другому типу.
      if (value === 'facility') setSelectedDoctorProfile('all');
      if (value !== 'facility') setSelectedFacilityType('all');
      if (value === 'doctor') {
        setOpenOnly(false);
      }
      return;
    }
    filterSetters[field]?.(value);
  };

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-100 font-sans dark:bg-slate-900">
      {/* Sidebar: desktop + mobile overlay panel */}
      {(!isMobile || isMobileFiltersOpen) && (
        <>
          {isMobile && (
            <div
              className="mobile-sheet-backdrop fixed inset-0 z-[998] bg-slate-900/40 backdrop-blur-[1px]"
              onClick={() => setIsMobileFiltersOpen(false)}
            />
          )}
          {!isMobile && (
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed((current) => !current)}
              aria-label={isSidebarCollapsed ? 'Показать панель поиска' : 'Скрыть панель поиска'}
              aria-expanded={!isSidebarCollapsed}
              className="absolute top-1/2 z-[1010] flex h-12 w-5 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-slate-200 bg-white text-slate-500 shadow-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
              style={{ left: isSidebarCollapsed ? 0 : (isTablet ? 340 : sidebarWidth) }}
            >
              {isSidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          )}
          {/*
            На телефоне панель — «шторка» с position: fixed и без relative:
            Tailwind выводит .relative позже, и он перебил бы fixed.
          */}
          <aside
            ref={sidebarRef}
            aria-label="Поиск врачей и учреждений"
            inert={isSidebarCollapsed && !isMobile}
            className={`search-sidebar ${isMobile ? 'mobile-bottom-sheet' : 'relative'} z-[1000] flex shrink-0 flex-col bg-white shadow-2xl overflow-hidden dark:bg-slate-800 transition-all duration-300 ease-in-out ${isSidebarCollapsed && !isMobile ? 'border-r-0' : ''} ${isMobile ? 'fixed inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-3xl' : ''}`}
            style={
              isMobile
                ? { transform: `translateY(${mobileSheetDragOffset}px)` }
                : { width: `${isTablet ? 340 : sidebarWidth}px`, marginLeft: isSidebarCollapsed ? `-${isTablet ? 340 : sidebarWidth}px` : '0px' }
            }
          >
            {isMobile && (
              <div
                className="flex cursor-grab justify-center py-3 active:cursor-grabbing select-none"
                onTouchStart={handleMobileSheetTouchStart}
                onTouchMove={handleMobileSheetTouchMove}
                onTouchEnd={handleMobileSheetTouchEnd}
                onMouseDown={handleMobileSheetMouseDown}
              >
                <div className="h-1.5 w-14 rounded-full bg-slate-300 dark:bg-slate-600" />
              </div>
            )}
            {/*
              Шапка подстраивается под ширину панели (контейнерные запросы,
              SearchFilters.css): на узкой панели (планшет, 340 px) значок и
              кнопки компактнее, и название не наезжает на кнопки.
            */}
            <header className="sidebar-header shrink-0 px-4 pb-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <MapPin size={24} className="sidebar-title-pin shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  <div className="min-w-0">
                    <h1 className="sidebar-title truncate text-[23px] font-extrabold leading-none tracking-tight text-blue-600 dark:text-blue-400">{siteSettings?.appName || 'МедКарта'}</h1>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Казань</p>
                  </div>
                </div>
                <div className="sidebar-header-icons flex shrink-0 items-center gap-1">
                  {(account.user || account.features.available) && (
                    <button
                      type="button"
                      className="sidebar-icon-button relative"
                      onClick={() => setIsAccountOpen(true)}
                      aria-label={account.user ? `Личный кабинет: ${account.user.displayName}` : 'Войти в личный кабинет'}
                      title={account.user ? account.user.displayName : 'Личный кабинет'}
                      data-testid="account-button"
                    >
                      {account.user ? (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white" aria-hidden="true">
                          {accountInitials(account.user.displayName)}
                        </span>
                      ) : (
                        <CircleUserRound size={20} aria-hidden="true" />
                      )}
                    </button>
                  )}
                  {insurance && (
                    <button
                      type="button"
                      className="sidebar-icon-button relative"
                      onClick={() => setIsDmsPanelOpen((current) => !current)}
                      aria-label={dmsPlan ? `Мой ДМС: ${dmsPlan.name}` : 'Мой ДМС: выбрать программу'}
                      aria-expanded={isDmsPanelOpen}
                      title={dmsPlan ? `ДМС: ${dmsProvider?.name || ''} «${dmsPlan.name}»` : 'Мой ДМС'}
                    >
                      <ShieldPlus size={19} aria-hidden="true" />
                      {dmsPlan && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />}
                    </button>
                  )}
                  {demoState.booking && (
                    <button
                      type="button"
                      className="sidebar-icon-button relative"
                      onClick={() => setIsMyBookingsOpen((current) => !current)}
                      aria-label={`Мои демо-записи: ${upcomingBookings}`}
                      aria-expanded={isMyBookingsOpen}
                      title="Мои демо-записи"
                      data-testid="my-bookings-button"
                    >
                      <CalendarCheck size={19} aria-hidden="true" />
                      {upcomingBookings > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 rounded-full bg-violet-600 px-1 text-[10px] leading-4 text-white">{upcomingBookings}</span>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sidebar-icon-button relative"
                    onClick={() => setFavoritesOnly((current) => !current)}
                    aria-label={favoritesOnly ? 'Показать все вместо избранного' : 'Показать избранное'}
                    aria-pressed={favoritesOnly}
                    title={`Избранное: ${favoritesCount}`}
                  >
                    <Heart size={19} fill={favoritesOnly ? 'currentColor' : 'none'} aria-hidden="true" />
                    {favoritesCount > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-blue-600 px-1 text-[10px] leading-4 text-white">{favoritesCount}</span>}
                  </button>
                  <button
                    type="button"
                    className="sidebar-icon-button"
                    onClick={() => setIsDarkMode((current) => !current)}
                    aria-label={isDarkMode ? 'Включить светлую тему' : 'Включить тёмную тему'}
                    aria-pressed={isDarkMode}
                    title={isDarkMode ? 'Светлая тема' : 'Тёмная тема'}
                  >
                    {isDarkMode ? <Sun size={19} /> : <Moon size={19} />}
                  </button>
                  {isMobile && (
                    <button type="button" className="sidebar-icon-button" aria-label="Закрыть поиск" onClick={() => setIsMobileFiltersOpen(false)}>
                      <X size={20} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
              <div className="relative mt-3">
                <label className="sr-only" htmlFor="facility-search">Поиск по врачу, клинике, адресу или услуге</label>
                <Search className="pointer-events-none absolute left-3 top-3.5 text-slate-500 dark:text-slate-400" size={17} aria-hidden="true" />
                <input
                  id="facility-search"
                  type="search"
                  autoComplete="off"
                  maxLength={100}
                  placeholder="Врач, клиника или адрес"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setIsSearchFocused(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setIsSearchFocused(false);
                  }}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={isSearchFocused && searchSuggestions.length > 0}
                  aria-controls="search-suggestions"
                  className="sidebar-search-input"
                />
                {searchQuery && (
                  <button type="button" className="sidebar-icon-button absolute right-1 top-1 !h-9 !w-8" aria-label="Очистить поиск" onClick={() => setSearchQuery('')}>
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
                {isSearchFocused && searchSuggestions.length > 0 && (
                  <div id="search-suggestions" role="listbox" aria-label="Варианты поиска" className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800">
                    {searchSuggestions.map((item) => (
                      <button
                        key={`${item.type}-${item.key}`}
                        role="option"
                        aria-selected="false"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleSearchSuggestionSelect(item.value)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
                      >
                        <span className="truncate">{item.value}</span>
                        <span className="ml-3 shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{item.type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {locationError && <p className="mt-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">Геолокация недоступна · поиск от центра Казани</p>}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {demoState.enabled && (
                <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100" role="note">
                  <FlaskConical size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {demoState.demoOnly ? (
                    <p data-testid="demo-only-note">
                      <b>Демо-версия.</b> Все клиники, врачи, адреса, расписание, цены и программы ДМС вымышлены.
                      {demoState.booking && ' Запись демонстрационная — никуда не отправляется.'}
                    </p>
                  ) : (
                    <p>
                      <b>Демо-режим.</b> Врачи, расписание, цены и ДМС с пометкой «Демо» вымышлены; клиники — вымышленные и реальные частные (данные OSM).
                      {demoState.booking && ' Запись демонстрационная — в клиники ничего не уходит.'}
                      {!demoState.publicClinics && ' Госклиники временно скрыты.'}{' '}
                      <button type="button" onClick={disableDemo} className="font-semibold underline underline-offset-2">Выключить</button>
                    </p>
                  )}
                </div>
              )}
              {demoState.booking && isMyBookingsOpen && (
                <MyBookingsPanel
                  bookings={myBookings}
                  inAccount={account.status === 'user'}
                  onChange={(next, info) => {
                    updateMyBookings(next);
                    if (info?.cancelled) setBookingsRefresh((value) => value + 1);
                  }}
                  onRoute={routeToBooking}
                  onClose={() => setIsMyBookingsOpen(false)}
                />
              )}
              {insurance && isDmsPanelOpen && (
                <DmsPanel
                  insurance={insurance}
                  planId={dmsPlan?.id || null}
                  today={todayKey}
                  isDemo={demoState.enabled}
                  onCallPult={() => track('contact_click', { channel: 'pult', kind: 'facility' })}
                  onClose={() => setIsDmsPanelOpen(false)}
                  onSave={(planId) => {
                    setDmsPlanId(planId);
                    setIsDmsPanelOpen(false);
                    if (!planId) setDmsOnly(false);
                    if (account.user) {
                      account.setPlan(planId).then(
                        () => planId && showToast('Программа сохранена в личном кабинете. Карточки отмечены по ней.', 'success'),
                        (error) => error?.status !== 401 && showToast('Не удалось сохранить программу в кабинете — она сохранена в этом браузере.', 'warning'),
                      );
                    } else if (planId) {
                      showToast('Программа сохранена в этом браузере. Карточки отмечены по ней.', 'success');
                    }
                  }}
                />
              )}
              <SearchFilters
                filters={filters}
                options={{ doctorProfiles, facilityTypes, clinics, services: allServices, travelLimits: TRAVEL_LIMIT_OPTIONS }}
                travel={{
                  modeLabel: TRAVEL_MODE_LABEL[travelMode] || '',
                  originKnown: travelOriginKnown,
                  state: travelEstimateState,
                }}
                dms={{ available: Boolean(insurance), planName: dmsPlan?.name || null }}
                onChange={handleFilterChange}
                onReset={clearFilters}
                onNearest={handleGoToNearest}
              />
              <div className="sidebar-results mt-1">
                <h2 id="results-heading" role="status" aria-live="polite">Найдено {sortedDoctors.length.toLocaleString('ru-RU')}</h2>
                <div className="sidebar-results-actions">
                  <label className="filter-select-wrap">
                    <span className="sr-only">Сортировка результатов</span>
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                      <option value="recommendation">По рекомендации</option>
                      <option value="distance">По расстоянию</option>
                      <option value="schedule">Сначала открытые</option>
                      <option value="name">По имени</option>
                      <option value="clinic">По клинике</option>
                      {(hasPrices || sortBy === 'price') && <option value="price">Сначала дешевле</option>}
                      {sortBy === 'rating' && <option value="rating">По рейтингу</option>}
                      {sortBy === 'experience' && <option value="experience">По стажу</option>}
                    </select>
                    <ChevronDown size={13} aria-hidden="true" />
                  </label>
                  <button type="button" className="sidebar-icon-button" onClick={handleShare} aria-label="Поделиться подборкой" title="Поделиться подборкой">
                    <Share2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {openOnly && unknownScheduleCount > 0 && (
                <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                  Объекты без расписания скрыты. <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setOpenOnly(false)}>Показать все</button>
                </p>
              )}
              <div className="space-y-3">
                {showFeedbackPrompt && (
                  <SearchFeedbackPrompt key={feedbackFor} onAnswer={handleFeedbackAnswer} onDismiss={handleFeedbackDismiss} />
                )}
                {sortedDoctors.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {/* Пустое состояние называет конкретную причину: общее
                        «ослабьте фильтры» не подсказывает, какой снять. */}
                    {favoritesOnly && favoritesCount === 0 ? (
                      <>
                        <p className="font-semibold text-slate-700 dark:text-slate-300">В избранном пока пусто</p>
                        <p className="mt-1">
                          Нажмите на сердечко в любой карточке — она появится здесь и сохранится после перезагрузки.
                        </p>
                        <button
                          type="button"
                          onClick={() => setFavoritesOnly(false)}
                          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-blue-700"
                        >
                          <HeartOff size={16} aria-hidden="true" /> Показать все карточки
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="font-semibold text-slate-700 dark:text-slate-300">Ничего не найдено</p>
                        <p className="mt-1">
                          {openOnly && unknownScheduleCount > 0
                            ? `Возможно, дело в фильтре «Открытые сейчас»: у ${unknownScheduleCount} объектов график не указан, и они не проходят проверку.`
                            : travelFilterActive
                              ? `В пределах ${maxTravelMinutes} мин ${TRAVEL_MODE_LABEL[travelMode] || ''} ничего не нашлось. Увеличьте время в пути или смените способ передвижения.`
                              : searchQuery
                              ? `По запросу «${searchQuery}» совпадений нет. Проверьте раскладку или попробуйте более общее слово.`
                              : 'Ослабьте фильтры или очистите поиск, чтобы вернуть карточки.'}
                        </p>
                        <div className="mt-4 flex flex-wrap justify-center gap-2">
                          {travelFilterActive && (
                            <button
                              type="button"
                              onClick={() => setMaxTravelMinutes(0)}
                              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                            >
                              Снять ограничение по времени
                            </button>
                          )}
                          {openOnly && (
                            <button
                              type="button"
                              onClick={() => setOpenOnly(false)}
                              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                            >
                              Снять «Открытые сейчас»
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={clearFilters}
                            className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-blue-700"
                          >
                            <RefreshCcw size={16} aria-hidden="true" /> Сбросить фильтры
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : cardDisplayMode === 'all' && doctorCards.length > 0 && facilityCards.length > 0 ? (
                  <>
                    <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-blue-700 dark:border-blue-800 dark:bg-blue-900/60 dark:text-blue-300">
                      Врачи ({doctorCards.length})
                    </div>
                    {doctorCards.slice(0, visibleCount).map(renderListingCard)}
                    {doctorCards.length > visibleCount && (
                      <button
                        type="button"
                        onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                        className="w-full rounded-2xl border border-blue-200 bg-blue-50 py-3 text-sm font-semibold text-blue-700 transition-all hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800"
                      >
                        Показать ещё ({doctorCards.length - visibleCount} врачей)
                      </button>
                    )}
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                      Учреждения ({facilityCards.length})
                    </div>
                    {facilityCards.slice(0, visibleCount).map(renderListingCard)}
                    {facilityCards.length > visibleCount && (
                      <button
                        type="button"
                        onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                        className="w-full rounded-2xl border border-emerald-200 bg-emerald-50 py-3 text-sm font-semibold text-emerald-700 transition-all hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-800"
                      >
                        Показать ещё ({facilityCards.length - visibleCount} учреждений)
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {sortedDoctors.slice(0, visibleCount).map(renderListingCard)}
                    {sortedDoctors.length > visibleCount && (
                      <button
                        type="button"
                        onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                        className="w-full rounded-2xl border border-slate-200 bg-white py-3 text-sm font-semibold text-slate-700 transition-all hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                      >
                        Показать ещё ({sortedDoctors.length - visibleCount} карточек)
                      </button>
                    )}
                  </>
                )}
              </div>
              <footer className="py-5 text-center text-[11px] text-slate-400 dark:text-slate-500">© 2026 МедКарта Казань</footer>
            </div>
          </aside>
        </>
      )}

      {/* Mobile bottom bar: route panel stacked above nav buttons */}
      {isMobile && !isMobileFiltersOpen && (
        <div className="fixed bottom-0 left-0 right-0 z-[999] flex flex-col">
          {/* Маршрут одной строкой */}
          {routeTargets.length > 0 && isRoutePanelCollapsed && (
            <RoutePill
              className="mx-3 mb-2"
              count={routeTargets.length}
              routeData={routeData}
              expanded={false}
              onToggle={() => setIsRoutePanelCollapsed(false)}
              onClear={clearRoute}
            />
          )}

          {/* Expanded route panel */}
          {routeTargets.length > 0 && !isRoutePanelCollapsed && (
            <div className="mx-2 mb-2 max-h-[50vh] overflow-hidden overflow-y-auto rounded-2xl border border-slate-100 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800">
              <div className="sticky top-0 z-10 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white px-4 py-3 dark:border-slate-700 dark:from-slate-700 dark:to-slate-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">Маршрут</div>
                    <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">{routeTargets.length}</div>
                  </div>
                  <button type="button" onClick={() => setIsRoutePanelCollapsed(true)} aria-label="Свернуть маршрут" className="rounded-lg p-1.5 text-slate-400 transition-colors active:bg-slate-200 dark:active:bg-slate-700">
                    <ChevronDown size={16} />
                  </button>
                </div>
              </div>

              <div className="px-3 py-2">
                <div className="flex flex-col gap-2">
                  {routeTargets.map((target, idx) => (
                    <div key={target.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/50 bg-white/60 p-2.5 shadow-sm dark:border-slate-700/50 dark:bg-slate-800/60">
                      {routeTargets.length > 1 && (
                        <div className="flex flex-col gap-0.5">
                          <button type="button" onClick={() => moveRouteTarget(idx, idx - 1)} disabled={idx === 0} aria-label="Переместить точку выше"  className="rounded p-0.5 text-slate-400 disabled:opacity-20 active:bg-slate-100 dark:active:bg-slate-700">
                            <ChevronUp size={14} />
                          </button>
                          <button type="button" onClick={() => moveRouteTarget(idx, idx + 1)} disabled={idx === routeTargets.length - 1} aria-label="Переместить точку ниже"  className="rounded p-0.5 text-slate-400 disabled:opacity-20 active:bg-slate-100 dark:active:bg-slate-700">
                            <ChevronDown size={14} />
                          </button>
                        </div>
                      )}
                      <div className="cursor-pointer flex-1 min-w-0" role="button" tabIndex={0} aria-label={`Показать на карте: ${target.clinic || target.name}`} onClick={() => setFlyToTarget([target.lat, target.lng])} onKeyDown={activateOnKey(() => setFlyToTarget([target.lat, target.lng]))}>
                        <div className="text-[13px] font-bold leading-tight text-slate-800 dark:text-white">{idx + 1}. {target.clinic || target.name}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">{target.address}</div>
                      </div>
                      <button type="button" aria-label="Убрать точку из маршрута" onClick={() => removeFromRoute(target.id)} className="shrink-0 rounded-lg p-1 text-slate-400 transition-colors active:bg-red-50 dark:active:bg-red-900/30">
                        <XCircle size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 border-y border-slate-100 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-700">
                {TRAVEL_MODE_OPTIONS.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    aria-label={mode.label}
                    aria-pressed={travelMode === mode.id}
                    title={mode.label}
                    onClick={() => { setTravelMode(mode.id); setRouteData(null); }}
                    className={`flex flex-1 items-center justify-center rounded-xl py-2 transition-all ${travelMode === mode.id ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-800 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'}`}
                  >
                    <mode.icon size={20} aria-hidden="true" />
                  </button>
                ))}
              </div>

              <div className="p-4 text-center">
                {routeData ? (
                  routeData.error ? (
                    <RouteErrorNotice routeData={routeData} routeTargets={routeTargets} fallback="Маршрут не найден" onRetry={() => setRouteData(null)} />
                  ) : (
                    <>
                      <div className="text-3xl font-extrabold tracking-tight text-slate-800 dark:text-white">{formatTime(routeData.time)}</div>
                      <div className="mt-1 font-medium text-slate-500 dark:text-slate-400">{formatDistance(routeData.distance)} · без учёта пробок</div>
                    </>
                  )
                ) : (
                  <div className="flex items-center justify-center gap-2 py-2 opacity-60">
                    <Loader2 className="animate-spin text-slate-400" size={20} />
                    <span className="text-sm dark:text-slate-400">Строим маршрут...</span>
                  </div>
                )}
              </div>

              {renderExternalRouteLinks(routeTargets, { label: 'Открыть в:', className: 'justify-center border-t border-slate-100 px-3 py-2.5 dark:border-slate-700' })}

              <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/50">
                {!routeStarted ? (
                  <button type="button" onClick={() => setIsRouteStarted(true)} disabled={!routeData || routeData.error} className="w-full rounded-xl bg-blue-600 py-3 font-semibold text-white transition-colors active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-600 dark:active:bg-blue-500">
                    Начать маршрут
                  </button>
                ) : (
                  <button type="button" onClick={() => setIsRouteStarted(false)} className="w-full rounded-xl bg-slate-200 py-3 font-semibold text-slate-700 transition-colors active:bg-slate-300 dark:bg-slate-600 dark:text-white dark:active:bg-slate-500">
                    Редактировать маршрут
                  </button>
                )}

                <button type="button" onClick={clearRoute} className="w-full rounded-xl border border-slate-200 bg-white py-3 font-semibold text-red-500 transition-colors active:bg-red-50 dark:border-slate-600 dark:bg-slate-800 dark:active:bg-red-900/30">
                  Очистить маршрут
                </button>
              </div>
            </div>
          )}

          {/* Navigation buttons */}
          <div className="mobile-bottom-bar flex items-center justify-around px-2 py-2">
            <button type="button" onClick={() => setIsMobileFiltersOpen(true)} aria-label="Открыть поиск и фильтры" className="flex flex-col items-center gap-1 rounded-2xl px-5 py-2 text-blue-600 transition-all active:bg-blue-50 dark:text-blue-400 dark:active:bg-slate-700">
              <Search size={22} />
              <span className="text-[11px] font-semibold">Поиск</span>
            </button>
            <button type="button" onClick={toggleAIAssistant} aria-label="Открыть AI-ассистента" className="flex flex-col items-center gap-1 rounded-2xl px-5 py-2 text-violet-600 transition-all active:bg-violet-50 dark:text-violet-400 dark:active:bg-slate-700">
              <Bot size={22} />
              <span className="text-[11px] font-semibold">Помощник</span>
            </button>
            <button type="button" onClick={resetToGPS} aria-label="Вернуться к моему местоположению" className={`flex flex-col items-center gap-1 rounded-2xl px-5 py-2 transition-all active:bg-blue-50 dark:active:bg-slate-700 ${(isFollowingUser && !isManualOrigin) ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'}`}>
              <MapPin size={22} />
              <span className="text-[10px] font-semibold">Местоположение</span>
            </button>
          </div>
        </div>
      )}

      {!isMobile && !isTablet && !isSidebarCollapsed && (
        <div className="z-[1010] flex w-2 cursor-col-resize items-center justify-center bg-slate-200 transition-colors hover:bg-blue-400 dark:bg-slate-600" onMouseDown={() => setIsDraggingPanel(true)}>
          <div className="h-8 w-1 rounded-full bg-slate-400 transition-colors group-hover:bg-white dark:bg-slate-500 dark:group-hover:bg-slate-300" />
        </div>
      )}

      <main className="relative flex-1 bg-slate-100 dark:bg-slate-900">
        {/* Кто вошёл: аватар, имя и роль, профиль, админ-панель (сотрудникам), выход. */}
        <div
          className={`absolute z-[1001] flex items-center gap-2 ${isMobile ? 'right-3' : 'right-6 top-6'}`}
          style={isMobile ? { top: 'calc(env(safe-area-inset-top, 0px) + 30px)' } : undefined}
        >
          {!isMobile && routeTargets.length > 0 && (
            <RoutePill
              count={routeTargets.length}
              routeData={routeData}
              expanded={!isRoutePanelCollapsed}
              onToggle={() => setIsRoutePanelCollapsed((current) => !current)}
              onClear={clearRoute}
            />
          )}
          {account.status === 'user' && account.user ? (
            isMobile ? (
              <button type="button" onClick={() => setIsAccountOpen(true)} className="block rounded-full shadow-lg ring-2 ring-white dark:ring-slate-800" aria-label={`Личный кабинет: ${account.user.displayName}`} data-testid="user-chip">
                <Avatar name={account.user.displayName} src={account.user.avatarUrl} seed={account.user.id} size={38} />
              </button>
            ) : (
              <div className="flex items-center gap-0.5 rounded-2xl border border-slate-200 bg-white/95 py-1 pl-1 pr-1 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-800/95" data-testid="user-chip">
                <button type="button" onClick={() => setIsAccountOpen(true)} className="flex items-center gap-2 rounded-xl px-1.5 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-700" title="Личный кабинет">
                  <Avatar name={account.user.displayName} src={account.user.avatarUrl} seed={account.user.id} size={30} />
                  <span className="max-w-[170px] leading-tight">
                    <span className="block truncate text-[13px] font-bold text-slate-800 dark:text-white" data-testid="user-chip-name">{account.user.displayName}</span>
                    <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{account.user.isDemo ? 'Демо-аккаунт' : account.user.roleLabel}</span>
                  </span>
                </button>
                <span className="mx-0.5 h-6 w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
                <Link to="/profile" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" data-testid="user-chip-profile">
                  <UserRound size={15} aria-hidden="true" />Профиль
                </Link>
                {account.user.permissions?.includes('admin.access') && (
                  <Link to="/admin" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40" data-testid="user-chip-admin">
                    <LayoutDashboard size={15} aria-hidden="true" />Админ-панель
                  </Link>
                )}
                <button type="button" onClick={() => account.logout()} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-slate-600 hover:bg-red-50 hover:text-red-600 dark:text-slate-300 dark:hover:bg-red-950/40" data-testid="user-chip-logout">
                  <LogOut size={15} aria-hidden="true" />Выйти
                </button>
              </div>
            )
          ) : account.status === 'guest' && account.features.available ? (
            <button type="button" onClick={() => setIsAccountOpen(true)} className="inline-flex h-10 items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/95 px-3.5 text-[13px] font-semibold text-slate-700 shadow-lg backdrop-blur hover:bg-white dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-200" data-testid="sign-in-button">
              <LogIn size={16} aria-hidden="true" />Войти
            </button>
          ) : null}
        </div>

        {siteSettings?.maintenance && !maintenanceDismissed && (
          <div role="status" className={`absolute left-1/2 z-[1002] flex w-[min(92%,560px)] -translate-x-1/2 items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/95 px-4 py-2.5 text-[13px] leading-5 text-amber-900 shadow-lg backdrop-blur dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-100 ${isMobile ? 'top-[84px]' : 'top-[76px]'}`} data-testid="maintenance-banner">
            <Wrench size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 whitespace-pre-line">{siteSettings.maintenance}</span>
            <button type="button" onClick={() => setMaintenanceDismissed(true)} className="-mr-1 shrink-0 rounded-lg p-1 hover:bg-amber-100 dark:hover:bg-amber-900" aria-label="Скрыть сообщение">
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {!isMobile && routeTargets.length > 0 && !isRoutePanelCollapsed && (
          <div
            className={`route-panel-slide-in absolute z-[1000] flex flex-col overflow-hidden border border-slate-100 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 ${isMobile ? 'left-2 right-2 rounded-2xl' : 'right-6 top-[84px] w-80 rounded-3xl'}`}
            /*
             * Высота ограничена, чтобы с пятью точками «Начать маршрут» и
             * «Очистить» не уходили за нижний край; снизу — место под кнопки
             * ИИ и геолокации.
             */
            style={isMobile ? { bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))', maxHeight: '55vh' } : { maxHeight: 'calc(100% - 244px)' }}
          >
            <div className={`border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white dark:border-slate-700 dark:from-slate-700 dark:to-slate-800 ${isMobile ? 'px-4 py-3' : 'px-5 py-4'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">Маршрут</div>
                  <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">{routeTargets.length}</div>
                </div>
                <button type="button" onClick={() => setIsRoutePanelCollapsed(true)} aria-label="Свернуть маршрут" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 active:bg-slate-200 dark:hover:bg-slate-700">
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>

            {/* Route targets list */}
            <div className={`${isMobile ? 'px-3 py-2 max-h-[30vh] overflow-y-auto' : 'min-h-0 flex-1 overflow-y-auto px-5 py-3'}`}>
              <div className="flex flex-col gap-2">
                {routeTargets.map((target, idx) => (
                  <div
                    key={target.id}
                    {...(!isMobile ? {
                      draggable: true,
                      onDragStart: (e) => handleDragStart(e, idx),
                      onDragOver: (e) => handleDragOver(e, idx),
                      onDrop: (e) => handleDrop(e, idx),
                      onDragEnd: handleDragEnd,
                      onDragLeave: () => setDragOverIndex(null),
                    } : {})}
                    className={`flex items-center justify-between gap-2 rounded-xl p-2.5 shadow-sm border transition-all duration-200 ${
                      !isMobile && dragOverIndex === idx && draggedTargetIndex !== idx
                        ? 'border-blue-400 bg-blue-50/80 scale-[1.03] dark:bg-blue-900/30 dark:border-blue-500'
                        : !isMobile && draggedTargetIndex === idx
                          ? 'border-violet-400 bg-violet-50/60 opacity-50 scale-95 dark:bg-violet-900/30 dark:border-violet-500'
                          : 'border-white/50 bg-white/60 dark:bg-slate-800/60 dark:border-slate-700/50'
                    }`}
                  >
                    {routeTargets.length > 1 && (
                      <div className="flex flex-col gap-0.5">
                        <button type="button" onClick={() => moveRouteTarget(idx, idx - 1)} disabled={idx === 0} aria-label="Переместить точку выше"  className="rounded p-0.5 text-slate-400 disabled:opacity-20 active:bg-slate-100 dark:active:bg-slate-700">
                          <ChevronUp size={14} />
                        </button>
                        <button type="button" onClick={() => moveRouteTarget(idx, idx + 1)} disabled={idx === routeTargets.length - 1} aria-label="Переместить точку ниже"  className="rounded p-0.5 text-slate-400 disabled:opacity-20 active:bg-slate-100 dark:active:bg-slate-700">
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    )}
                    {!isMobile && (
                      <div className="mt-0.5 cursor-grab text-slate-400 active:cursor-grabbing">
                        <GripVertical size={16} />
                      </div>
                    )}
                    <div className="cursor-pointer flex-1 min-w-0" role="button" tabIndex={0} aria-label={`Показать на карте: ${target.clinic || target.name}`} onClick={() => setFlyToTarget([target.lat, target.lng])} onKeyDown={activateOnKey(() => setFlyToTarget([target.lat, target.lng]))}>
                      <div className="text-[13px] font-bold leading-tight text-slate-800 dark:text-white">{idx + 1}. {target.clinic || target.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">{target.address}</div>
                    </div>
                    <button type="button" aria-label="Убрать точку из маршрута" onClick={() => removeFromRoute(target.id)} className="shrink-0 rounded-lg p-1 text-slate-400 transition-colors hover:text-red-500 active:bg-red-50 dark:active:bg-red-900/30">
                      <XCircle size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {isManualOrigin && (
              <div className="flex flex-col items-center border-b border-amber-100 bg-amber-50 px-4 py-2 text-center text-[13px] text-amber-700 dark:border-amber-800 dark:bg-amber-900 dark:text-amber-300">
                <span>Маршрут от выбранной точки</span>
                <button type="button" onClick={resetToGPS} className="mt-1 font-bold underline hover:text-amber-900">
                  Вернуться к моей геопозиции
                </button>
              </div>
            )}

            <div className="flex gap-2 border-b border-slate-100 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-700">
              {TRAVEL_MODE_OPTIONS.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  aria-label={mode.label}
                  aria-pressed={travelMode === mode.id}
                  title={mode.label}
                  onClick={() => {
                    setTravelMode(mode.id);
                    setRouteData(null);
                  }}
                  className={`flex flex-1 items-center justify-center rounded-xl py-2 transition-all ${travelMode === mode.id ? 'bg-white text-blue-600 shadow-sm dark:bg-slate-800 dark:text-blue-400' : 'text-slate-400 hover:bg-slate-100 dark:text-slate-500 dark:hover:bg-slate-600'}`}
                >
                  <mode.icon size={20} aria-hidden="true" />
                </button>
              ))}
            </div>

            <div className={`${isMobile ? 'p-4' : 'p-6'} text-center`}>
              {routeData ? (
                routeData.error ? (
                  <RouteErrorNotice routeData={routeData} routeTargets={routeTargets} fallback="Маршрут для этого транспорта не найден" onRetry={() => setRouteData(null)} />
                ) : (
                  <>
                    <div className={`${isMobile ? 'text-3xl' : 'text-4xl'} font-extrabold tracking-tight text-slate-800 dark:text-white`}>{formatTime(routeData.time)}</div>
                    <div className="mt-1 font-medium text-slate-500 dark:text-slate-400">{formatDistance(routeData.distance)} · без учёта пробок</div>
                  </>
                )
              ) : (
                <div className="flex flex-col items-center justify-center py-2 opacity-60">
                  <Loader2 className="mb-2 animate-spin text-slate-400 dark:text-slate-500" size={24} />
                  <span className="text-sm dark:text-slate-400">Строим маршрут...</span>
                </div>
              )}
            </div>

            {renderExternalRouteLinks(routeTargets, { label: 'Открыть в:', className: 'justify-center border-t border-slate-100 px-4 py-3 dark:border-slate-700' })}

            <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/50">
              {!routeStarted ? (
                <button type="button" onClick={() => setIsRouteStarted(true)} disabled={!routeData || routeData.error} className="w-full rounded-xl bg-blue-600 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500">
                  Начать маршрут
                </button>
              ) : (
                <button type="button" onClick={() => setIsRouteStarted(false)} className="w-full rounded-xl bg-slate-200 py-3 font-semibold text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-600 dark:text-white dark:hover:bg-slate-500">
                  Редактировать маршрут
                </button>
              )}

              <button type="button" onClick={clearRoute} className="w-full rounded-xl border border-slate-200 bg-white py-3 font-semibold text-red-500 transition-colors hover:bg-red-50 dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-red-900/30">
                Очистить весь маршрут
              </button>
            </div>
          </div>
        )}

        <MapContainer center={activeOrigin} zoom={13} className="h-full w-full" zoomControl attributionControl={false}>
          {/*
            Подпись «© OpenStreetMap» обязательна по лицензии ODbL и правилам
            использования тайлов; стоит там, где её не закрывают панели и меню.
          */}
          <AttributionControl position={isMobile ? 'topright' : 'bottomleft'} prefix={false} />
          <PopupPanGuard rightPadding={!isMobile && routeTargets.length > 0 && !isRoutePanelCollapsed ? 360 : 24} />
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />

          <Marker
            position={activeOrigin}
            icon={userDotIcon}
            draggable
            eventHandlers={{
              dragend: (event) => {
                const marker = event.target;
                const position = marker.getLatLng();
                setCustomOrigin([position.lat, position.lng]);
                setIsManualOrigin(true);
                setIsFollowingUser(false);
                setRouteData(null);
              },
            }}
          >
            <Popup>
              <div className="dark:text-white">
                <b className="text-base text-red-600">{isManualOrigin ? 'Произвольная точка отправления' : 'Вы здесь'}</b>
                <br />
                <span className="mt-1 block text-xs leading-tight text-slate-500">Перетащите эту точку, чтобы изменить старт маршрута</span>
              </div>
            </Popup>
          </Marker>

          <MarkerClusterGroup disableClusteringAtZoom={16}>
            {markerNodes}
          </MarkerClusterGroup>

          <RoutingMachine originLocation={activeOrigin} routeTargets={routeTargets} travelMode={travelMode} routeData={routeData} setRouteData={stableSetRouteData} />
          <InvalidateMapSize />

          <InitialCenterMap location={userLocation} />
          {flyToTarget && (
            <FlyToPoint
              target={flyToTarget}
              onDone={() => setFlyToTarget(null)}
              // На телефоне развёрнутая панель маршрута закрывает нижнюю
              // половину карты: точку ставим выше центра, в видимую часть.
              offsetRatio={isMobile && routeTargets.length > 0 && !isRoutePanelCollapsed ? 0.3 : 0}
            />
          )}
        </MapContainer>

        {/* Кнопки на карте — скрываем на мобильных (есть bottom bar) */}
        {!isMobile && (
          <>
            <button
              type="button"
              onClick={resetToGPS}
              aria-label="Вернуться к моему местоположению"
              className={`absolute bottom-6 right-6 z-[1000] rounded-full border-2 p-3 shadow-lg transition-all ${(isFollowingUser && !isManualOrigin) ? 'border-blue-700 bg-blue-600 text-white hover:bg-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-400 dark:hover:bg-slate-600'}`}
              title="Вернуться к моему местоположению"
            >
              <MapPin size={24} />
            </button>

            <button
              type="button"
              onClick={toggleAIAssistant}
              aria-label="Открыть AI-ассистента"
              aria-expanded={isAIAssistantOpen}
              className="absolute bottom-[88px] right-6 z-[1000] rounded-full bg-violet-600 p-3 text-white shadow-[0_4px_20px_rgba(124,58,237,0.4)] transition-all hover:scale-105 hover:bg-violet-700"
              title="AI-Ассистент"
            >
              <Bot size={24} />
            </button>
          </>
        )}

        {isAccountOpen && (
          <Suspense fallback={null}>
            <AccountPanel
              account={account}
              insurance={insurance}
              today={todayKey}
              planId={dmsPlanId}
              onSelectPlan={selectPlanFromAccount}
              favorites={favoriteDetails}
              onFocusFavorite={focusFavorite}
              onRemoveFavorite={toggleFavorite}
              onClose={closeAccountPanel}
              isMobile={isMobile}
              intro={chatAfterSignIn ? 'Войдите, чтобы поговорить с ассистентом: переписка будет только вашей.' : null}
              support={{ email: siteSettings?.supportEmail || null, phone: siteSettings?.supportPhone || null }}
            />
          </Suspense>
        )}

        {isAIAssistantMounted && (
          <Suspense fallback={null}>
            <AIAssistant
              key={assistantEpoch}
              isOpen={isAIAssistantOpen}
              onClose={() => setIsAIAssistantOpen(false)}
              onApplyTriage={handleApplyTriage}
              picks={assistantPicks}
              onFocusPick={focusPick}
              onRoutePick={routePick}
              onShowAllPicks={showAllPicks}
              bookings={demoState.booking ? assistantBookings : null}
              bookingOrigin={bookingOrigin}
              bookingPlanId={dmsPlan?.id || null}
              bookingsRefresh={bookingsRefresh}
              onBookOption={openBooking}
              onRouteOption={routeToOption}
              onSelectPlan={choosePlanFromChat}
              onRequestOrigin={requestBookingOrigin}
              onLoginRequired={handleAssistantLoginRequired}
              isMobile={isMobile}
              avoidRoutePanel={!isMobile && routeTargets.length > 0 && !isRoutePanelCollapsed}
            />
          </Suspense>
        )}

        {isChatNoticeOpen && (
          <Suspense fallback={null}>
            <ChatLoginNotice
              canSignIn={account.features.available}
              hasDemo={Boolean(account.features.demo && account.features.demoAccounts?.length)}
              onSignIn={signInForAssistant}
              onClose={() => setIsChatNoticeOpen(false)}
              isMobile={isMobile}
            />
          </Suspense>
        )}
      </main>

      {detailsDoc && (
        <PlaceDetailsModal
          key={detailsDoc.id}
          title={detailsDoc.name}
          subtitle={detailsDoc.entityKind === 'doctor' ? detailsDoc.clinic : detailsDoc.facilityType || detailsDoc.specialty}
          onClose={() => setDetailsId(null)}
        >
          {renderPlaceDetails(detailsDoc)}
        </PlaceDetailsModal>
      )}

      {bookingTarget && (
        <Suspense fallback={null}>
          <BookingDialog
            key={`${bookingTarget.doctorId}|${bookingTarget.branchId}|${bookingTarget.slotId || ''}`}
            target={bookingTarget}
            planId={dmsPlan?.id || null}
            onClose={() => setBookingTarget(null)}
            onBooked={handleBooked}
            onCancelled={handleBookingCancelled}
            onRoute={routeToBooking}
          />
        </Suspense>
      )}

      <Toast toast={toast} onDismiss={dismissToast} />
      {account.status === 'user' && account.user?.mustChangePassword && (
        <ForcedPasswordChange
          user={account.user}
          onDone={(user) => {
            account.applyUser(user);
            showToast('Пароль изменён. Добро пожаловать!', 'success');
          }}
          onLogout={account.logout}
        />
      )}
    </div>
  );
}
