/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Этот код является интеллектуальной собственностью автора.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
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
} from 'lucide-react';
import { doctorsData } from '@data/doctors.legacy.js';
import { verifiedDoctors } from '@data/doctors';
import { kazanFacilities } from '@data/facilities.js';
import { ClinicsData } from '@data/clinics.js';
import Toast, { useToast } from './Toast';
import SearchFilters from './SearchFilters';
import { SORT_MODES } from '@shared/contract.js';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { isBoolean, isStringIdArray, useLocalStorageState } from './hooks/useLocalStorageState';

// Помощник и его зависимости грузятся отдельным чанком: большинство сессий
// открывается ради карты, а не чата, — нет смысла тянуть его в первый байт.
const AIAssistant = lazy(() => import('./AIAssistant'));

delete L.Icon.Default.prototype._getIconUrl;

// L.divIcon вставляет строку через innerHTML. Даже если сейчас сюда приходят
// только константы, значения приводим к безопасному виду — чтобы будущая
// правка не превратила это в точку внедрения разметки.
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
const DARK_MODE_STORAGE_KEY = 'med-navigator-dark-mode';
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
      const doctorName = doctor?.full_name || `Врач клиники №${index + 1}`;
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
        services: [clinic.facility_type, specialty].filter(Boolean),
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

// Initial map view reset (once)
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

// Animate map transition to coordinates
const FlyToPoint = ({ target, onDone }) => {
  const map = useMap();
  const prevTarget = useRef(null);
  useEffect(() => {
    if (target && target !== prevTarget.current) {
      prevTarget.current = target;
      map.flyTo(target, map.getZoom() < 14 ? 15 : map.getZoom(), { duration: 1.0 });
      if (onDone) setTimeout(onDone, 1100);
    }
  }, [target, map, onDone]);
  return null;
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

const RoutingMachine = ({ originLocation, routeTargets, travelMode, setRouteData }) => {
  const map = useMap();
  const layerRef = useRef(null);

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

    /*
     * Маршрут строит НАШ сервер (backend/routing), а не сторонний сервис.
     * Раньше координаты пользователя и всех точек уходили на публичный
     * демо-сервер OSRM — при том что языковой модели мы отдаём @HOME вместо
     * адреса. Теперь координаты дальше нашего бекенда не идут.
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
          // Граф не собран или маршрут не построился: рисуем прямые линии
          // между точками и честно помечаем оценку приблизительной, вместо
          // того чтобы оставить пользователя без всякой подсказки.
          clear();
          layerRef.current = L.polyline(
            waypoints.map((point) => [point.lat, point.lng]),
            { color: lineColors[mode], weight: 4, opacity: 0.55, dashArray: '8 10' },
          ).addTo(map);
          setRouteData({ distance: 0, time: 0, error: true });
          return;
        }

        const payload = await response.json();
        if (cancelled || !Array.isArray(payload.geometry) || payload.geometry.length < 2) {
          setRouteData({ distance: 0, time: 0, error: true });
          return;
        }

        clear();
        layerRef.current = L.polyline(payload.geometry, {
          color: lineColors[mode],
          weight: 6,
          opacity: 0.9,
        }).addTo(map);

        setRouteData({ distance: payload.distance, time: payload.time, error: false });
      } catch (error) {
        if (cancelled || error?.name === 'AbortError') return;
        setRouteData({ distance: 0, time: 0, error: true });
      }
    };

    draw();

    return () => {
      cancelled = true;
      controller.abort();
      clear();
    };
    // routeKey намеренно заменяет собой список зависимостей: он и есть
    // огрублённый снимок входных данных.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, routeKey]);

  return null;
};

const timeToMinutes = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const parts = value.trim().split(':');
  if (parts.length !== 2) {
    return null;
  }

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
};

const normalizeText = (value) => (value ? value.toString().toLowerCase() : '');

const normalizeClinicKey = (value) =>
  (value || '')
    .toString()
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const scheduleTextToRange = (value) => {
  if (!value || /выход/i.test(value) || /closed/i.test(value)) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized.includes('круглосуточ')) {
    return { start: 0, end: 24 * 60 };
  }

  const rangePart = value.split(';')[0].split(',')[0].trim();
  const dashIndex = rangePart.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const start = timeToMinutes(rangePart.slice(0, dashIndex).trim());
  const end = timeToMinutes(rangePart.slice(dashIndex + 1).trim());
  if (start === null || end === null) {
    return null;
  }

  return { start, end };
};

// Расписание бывает трёх видов, и раньше два последних не различались.
// 487 объектов из OpenStreetMap приходят с schedule: null — графика попросту
// нет в данных. Старая логика возвращала для них false, и карточка показывала
// красное «Закрыто», противореча собственной строке «График уточняется».
// OPEN_STATE.UNKNOWN отделяет «точно закрыто» от «мы не знаем».
const OPEN_STATE = { OPEN: 'open', CLOSED: 'closed', UNKNOWN: 'unknown' };

const hasAnyScheduleData = (schedule) =>
  Boolean(schedule) && dayKeys.some((dayKey) => {
    const value = schedule[dayKey];
    return typeof value === 'string' && value.trim().length > 0;
  });

const resolveOpenState = (schedule, now) => {
  if (!hasAnyScheduleData(schedule)) {
    return OPEN_STATE.UNKNOWN;
  }

  const range = scheduleTextToRange(schedule[dayKeys[now.getDay()]]);
  if (!range) {
    return OPEN_STATE.CLOSED;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= range.start && currentMinutes < range.end
    ? OPEN_STATE.OPEN
    : OPEN_STATE.CLOSED;
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

  return schedule[dayKeys[now.getDay()]] || 'График уточняется';
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
  const cleaned = String(phone || '').replace(/[^\d+]/g, '');
  return cleaned.length >= 6 ? `tel:${cleaned}` : null;
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
  if (Number.isFinite(min) && Number.isFinite(max) && min !== max) {
    return `${format(min)}–${format(max)} ₽`;
  }
  return `${format(Number.isFinite(min) ? min : max)} ₽`;
};

// --- Внешние карты --------------------------------------------------------

const YANDEX_ROUTE_TYPE = { driving: 'auto', foot: 'pd', bike: 'bc' };

/**
 * Ссылка на Яндекс.Карты для одной или нескольких точек — на всех платформах.
 * Промежуточные точки Яндекс принимает через «~», поэтому весь маршрут
 * передаётся целиком. На телефоне ссылка открывается в приложении Яндекс.Карт,
 * если оно установлено, иначе в браузере.
 */
const buildExternalMapUrl = (origin, targets, travelMode) => {
  const points = (targets || []).filter((t) => Number.isFinite(t?.lat) && Number.isFinite(t?.lng));
  if (points.length === 0) {
    return null;
  }

  const coords = (point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;

  const segments = [];
  if (origin) {
    segments.push(`${origin[0].toFixed(6)},${origin[1].toFixed(6)}`);
  }
  points.forEach((point) => segments.push(coords(point)));

  const params = new URLSearchParams({
    rtext: segments.join('~'),
    rtt: YANDEX_ROUTE_TYPE[travelMode] || 'auto',
  });
  return `https://yandex.ru/maps/?${params.toString()}`;
};

const externalMapLabel = () => 'Открыть в Яндекс.Картах';

// --- Состояние в адресной строке -----------------------------------------

/*
 * Фильтры живут в URL, чтобы ссылку можно было переслать или сохранить.
 * Параметры из адресной строки — недоверенный ввод: значения из перечислений
 * сверяются со списком, числа зажимаются в диапазон, строки обрезаются.
 * Дальше их всё равно фильтрует справочник, но проверять надо на входе.
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
  flags: 'flags',
  focus: 'doc',
};

const FLAG_KEYS = ['open', 'fav', 'weekend', 'evening', 'online', 'wheelchair', 'children'];

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

const formatDistance = (meters) => {
  if (meters == null) {
    return '—';
  }

  if (meters < 1000) {
    return `${Math.round(meters)} м`;
  }

  return `${(meters / 1000).toFixed(1)} км`;
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
  // Избранное и тема читаются из localStorage через валидатор: испорченное или
  // подменённое значение раньше роняло приложение на favorites.includes(...).
  const [favorites, setFavorites] = useLocalStorageState(FAVORITES_STORAGE_KEY, [], isStringIdArray);
  const [now, setNow] = useState(() => new Date());
  const [isLocationReady, setIsLocationReady] = useState(!hasGeolocationSupport);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
  const [mobileSheetDragOffset, setMobileSheetDragOffset] = useState(0);
  const [isDarkMode, setIsDarkMode] = useLocalStorageState(DARK_MODE_STORAGE_KEY, false, isBoolean);
  const { toast, showToast, dismiss: dismissToast } = useToast();

  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false);
  const [isRoutePanelCollapsed, setIsRoutePanelCollapsed] = useState(false);
  const [buildRouteTrigger, setBuildRouteTrigger] = useState(false);
  const [targetStopsTrigger, setTargetStopsTrigger] = useState(null); // Apply processing results to UI state

  // Справочники в ref: handleApplyTriage не должен пересоздаваться на каждый
  // пересчёт списков, иначе AIAssistant перерисовывается впустую.
  const districtSetRef = useRef(new Set());
  const clinicSetRef = useRef(new Set());
  const facilityTypeSetRef = useRef(new Set());
  const doctorProfileSetRef = useRef(new Set());
  const serviceSetRef = useRef(new Set());

  const handleApplyTriage = useCallback((result) => {
    // === МАРШРУТ ===
    if (result.clearRoute && !result.clearFilters) {
      setRouteTargets([]);
      setRouteData(null);
    }

    // === СБРОС ФИЛЬТРОВ (НЕ трогает маршрут!) ===
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
      setSortBy('recommendation');
    }

    // === ТЁМНАЯ ТЕМА ===
    if (result.darkMode === true) setIsDarkMode(true);
    if (result.darkMode === false) setIsDarkMode(false);

    // === РЕЖИМ ПЕРЕДВИЖЕНИЯ ===
    if (result.travelMode && ['driving', 'foot', 'bike'].includes(result.travelMode)) {
      setTravelMode(result.travelMode);
    }

    // === ФИЛЬТРЫ ===
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

    // === СОРТИРОВКА ===
    if (SORT_MODES.includes(result.sortMode)) {
      setSortBy(result.sortMode);
    }

    // Если только clearRoute/clearFilters без дополнительных действий — выходим
    if ((result.clearRoute || result.clearFilters) && !result.specialty && !result.service && !result.searchQuery && !result.buildRoute && !result.targetStops?.length) {
      return;
    }

    // Complex routing
    if (result.targetStops && result.targetStops.length > 0) {
      setTimeout(() => setTargetStopsTrigger(result.targetStops), 100);
      return;
    }

    // === ПОИСК ===
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

    // === ПОСТРОИТЬ МАРШРУТ ===
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
    // Сеттеры useState стабильны; перечислены явно, чтобы правило
    // exhaustive-deps не считало их пропущенными зависимостями.
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
    const base = [...verifiedDoctors, ...doctorsData, ...kazanFacilities, ...clinicsFacilities];
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
  }, [clinicsFacilities]);

  const activeOrigin = isManualOrigin && customOrigin ? customOrigin : userLocation;
  // Поле ввода обновляется мгновенно, тяжёлая фильтрация — с задержкой.
  const deferredSearchQuery = useDebouncedValue(searchQuery, 180);

  useEffect(() => {
    const timerId = setInterval(() => setNow(new Date()), 300000);
    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    pendingSidebarWidthRef.current = sidebarWidth;
    if (sidebarRef.current) {
      sidebarRef.current.style.width = `${sidebarWidth}px`;
    }
  }, [sidebarWidth]);

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
    const fallbackTimer = window.setTimeout(() => {
      // Use fallback location on timeout
      setUserLocation(defaultLocation);
      setLocationError(true);
      setIsLocationReady(true);
    }, 8000);

    watchId = navigator.geolocation.watchPosition(
      (position) => {
        window.clearTimeout(fallbackTimer);
        const next = [position.coords.latitude, position.coords.longitude];
        setUserLocation((prev) => {
          // watchPosition срабатывает несколько раз в секунду, а каждая новая
          // ссылка пересчитывала расстояния до всех ~1000 объектов.
          // Игнорируем дрожание меньше ~5 метров.
          if (prev && Math.abs(prev[0] - next[0]) < 0.00005 && Math.abs(prev[1] - next[1]) < 0.00005) {
            return prev;
          }
          return next;
        });
        setIsLocationReady(true);
      },
      () => {
        window.clearTimeout(fallbackTimer);
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
        // Часть источников (OSM, ClinicsData) может прийти без features/services —
        // раньше это роняло рендер на doc.features.children.
        const features = doc.features || {};
        const services = Array.isArray(doc.services) ? doc.services : EMPTY_SERVICES;

        // Бейджи раньше дублировали друг друга: врач со стажем 20+ получал
        // сразу «Опытный врач» и «Высший стаж», а с рейтингом 4.9 — ещё
        // «Топ-врач» и «Популярный». Оставляем по одному, самому сильному.
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
        };
      }),
    [activeOrigin, now, sourceFacilities],
  );

  // Set вместо массива: раньше на каждую из ~1000 записей выполнялся
  // линейный favorites.includes(), то есть O(записи × избранное).
  const favoriteIds = useMemo(() => new Set(favorites), [favorites]);

  const enrichedDoctors = useMemo(
    () => baseEnrichedDoctors.map((doc) => ({ ...doc, isFavorite: favoriteIds.has(doc.id) })),
    [baseEnrichedDoctors, favoriteIds],
  );

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

  // Индекс подсказок строится ОДИН раз на набор данных. Раньше эта Map на
  // несколько тысяч ключей пересобиралась на каждое нажатие клавиши.
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

    return enrichedDoctors.filter((doc) => {
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
      // Скобки расставлены явно: без них тернарник читался как (a || b) ? true : c.
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

      return (
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
    enrichedDoctors,
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

  const sortedDoctors = useMemo(() => {
    const list = [...filteredDoctors];
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
        const leftDistance = left.distanceKm == null ? Number.POSITIVE_INFINITY : left.distanceKm;
        const rightDistance = right.distanceKm == null ? Number.POSITIVE_INFINITY : right.distanceKm;

        return leftDistance - rightDistance || Number(right.openNow) - Number(left.openNow);
      },
      schedule: compareBySchedule,
      name: (left, right) => left.name.localeCompare(right.name, 'ru'),
      clinic: (left, right) => left.clinic.localeCompare(right.clinic, 'ru'),
    };

    list.sort(comparators[sortBy] || compareByRecommendation);
    return list;
  }, [filteredDoctors, now, sortBy]);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedSchedules, setExpandedSchedules] = useState(() => new Set());

  const toggleSchedule = useCallback((id) => {
    setExpandedSchedules((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Отражаем фильтры в адресной строке через replaceState: ссылку можно
  // переслать или сохранить, но история браузера не засоряется — иначе
  // каждое движение ползунка добавляло бы запись, и «Назад» не работал бы.
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
        flags: [
          openOnly && 'open',
          favoritesOnly && 'fav',
          weekendOnly && 'weekend',
          eveningOnly && 'evening',
          onlineOnly && 'online',
          wheelchairOnly && 'wheelchair',
          childrenOnly && 'children',
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
      openOnly,
      favoritesOnly,
      weekendOnly,
      eveningOnly,
      onlineOnly,
      wheelchairOnly,
      childrenOnly,
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

  // Раньше пагинация не сбрасывалась при смене фильтра: после «показать ещё»
  // новый поиск сразу отдавал сотни карточек и подвешивал прокрутку.
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
    sortBy,
  ]);

  const favoritesCount = enrichedDoctors.filter((doc) => doc.isFavorite).length;
  // Сколько записей фильтр «Открытые сейчас» прячет не потому, что они закрыты,
  // а потому, что графика нет в данных. Молча терять половину базы нечестно.
  const unknownScheduleCount = enrichedDoctors.filter((doc) => doc.openState === OPEN_STATE.UNKNOWN).length;
  const nearestOpenDoctor = useMemo(() => {
    const byDistance = [...enrichedDoctors].sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
    return byDistance.find((doc) => doc.openNow) || byDistance[0] || null;
  }, [enrichedDoctors]);
  const doctorCards = useMemo(() => sortedDoctors.filter((item) => item.entityKind === 'doctor'), [sortedDoctors]);
  const facilityCards = useMemo(() => sortedDoctors.filter((item) => item.entityKind === 'facility'), [sortedDoctors]);

  useEffect(() => {
    if (targetStopsTrigger && targetStopsTrigger.length > 0 && enrichedDoctors.length > 0) {
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
  }, [buildRouteTrigger, targetStopsTrigger, enrichedDoctors, sortedDoctors, routeTargets]);

  // Toggle favorite status
  const toggleFavorite = useCallback((id) => {
    setFavorites((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }, [setFavorites]);

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

  const handleGoToNearest = () => {
    if (!nearestOpenDoctor) return;
    // Сбрасываем фильтры, чтобы маршрут строился к реально ближайшей
    setRouteTargets([nearestOpenDoctor]);
    setRouteData(null);
    setIsFollowingUser(false);
    setFlyToTarget([nearestOpenDoctor.lat, nearestOpenDoctor.lng]);
  };

  // Ссылка на весь маршрут во внешних картах: там есть голосовое ведение,
  // которого у нас нет. Яндекс принимает промежуточные точки, Apple — только
  // конечную, поэтому buildExternalMapUrl разводит эти случаи.
  const externalRouteUrl = useMemo(
    () => buildExternalMapUrl(activeOrigin, routeTargets, travelMode),
    [activeOrigin, routeTargets, travelMode],
  );

  const stableSetRouteData = useCallback((data) => {
    setRouteData(data);
  }, []);

  const clearRoute = useCallback(() => {
    setRouteTargets([]);
    setRouteData(null);
    setIsRoutePanelCollapsed(false);
    setIsRouteStarted(false);
  }, []);

  const removeFromRoute = useCallback((docId) => {
    setRouteTargets(prev => prev.filter(t => t.id !== docId));
    setRouteData(null);
  }, []);

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
    const sourceIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);

    if (isNaN(sourceIdx) || sourceIdx === idx) {
      setDragOverIndex(null);
      return;
    }

    setRouteTargets(prev => {
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
    // Группируем врачей и клиники по координатам, чтобы избежать наложения
    // десятков одинаковых маркеров друг на друга (что вызывало черный ореол из теней)
    const groupsMap = new Map();

    sortedDoctors.forEach((doc) => {
      const routeIndex = routeTargets.findIndex((t) => t.id === doc.id);
      const isRouteTarget = routeIndex !== -1;

      // Если пользователь нажал "Начать маршрут" — скрываем все остальные маркеры
      if (isRouteStarted && !isRouteTarget) {
        return;
      }

      // Если маршрут не начат — применяем обычный фильтр по типу карточки
      if (!isRouteStarted && cardDisplayMode !== 'all' && doc.entityKind !== cardDisplayMode) {
        return;
      }

      const key = `${Number(doc.lat).toFixed(5)},${Number(doc.lng).toFixed(5)}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          lat: doc.lat,
          lng: doc.lng,
          items: [],
        });
      }
      groupsMap.get(key).items.push({ ...doc, routeIndex, isRouteTarget });
    });

    return Array.from(groupsMap.values()).map((group) => {
      const { lat, lng, items } = group;
      // Если среди специалистов точки есть точка маршрута — маркер должен быть красным маршрутным
      const targetItem = items.find((it) => it.isRouteTarget);
      const isRouteTarget = Boolean(targetItem);
      const routeIndex = targetItem ? targetItem.routeIndex : -1;

      const hasFavorite = items.some((it) => it.isFavorite);
      const isGovernment = items.some((it) => /государ/i.test(String(it.ownership || '')));
      const ownershipIcon = isGovernment ? blueArrowIcon : violetArrowIcon;

      // Приоритет иконки: Маршрут -> Избранное -> Государственная/Частная
      const icon = isRouteTarget
        ? createBeautifulArrow('#ef4444', false, (routeIndex + 1).toString())
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
        <Marker key={`group-${lat}-${lng}`} position={[lat, lng]} icon={icon}>
          <Popup>
            <div className="min-w-[240px] max-w-[300px] pb-1 dark:text-white">
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
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                    <span>Специалисты в учреждении:</span>
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                      {items.length}
                    </span>
                  </div>
                  <div className="max-h-52 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                    {items.map((doc) => (
                      <div
                        key={doc.id}
                        className={`rounded-xl border p-2 text-xs transition-colors ${
                          doc.isRouteTarget
                            ? 'border-red-200 bg-red-50/50 dark:border-red-900/50 dark:bg-red-950/20'
                            : 'border-slate-100 bg-slate-50 dark:border-slate-700 dark:bg-slate-800'
                        }`}
                      >
                        <div className="font-bold text-slate-800 dark:text-white">{doc.name}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{doc.specialty}</div>
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => (doc.isRouteTarget ? removeFromRoute(doc.id) : handleRouteClick(doc))}
                            className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-1 text-[11px] font-medium transition-all ${
                              doc.isRouteTarget
                                ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-200'
                                : 'bg-blue-600 text-white hover:bg-blue-700'
                            }`}
                          >
                            {doc.isRouteTarget ? <XCircle size={12} /> : <Navigation size={12} />}
                            {doc.isRouteTarget ? 'Убрать' : 'В маршрут'}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleFavorite(doc.id)}
                            className={`flex h-7 w-7 items-center justify-center rounded-lg border text-slate-500 transition-colors ${
                              doc.isFavorite
                                ? 'border-amber-200 bg-amber-50 text-amber-600'
                                : 'border-slate-200 bg-white hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-700'
                            }`}
                            title={doc.isFavorite ? 'В избранном' : 'В избранное'}
                          >
                            <Heart size={13} fill={doc.isFavorite ? 'currentColor' : 'none'} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Popup>
        </Marker>
      );
    });
  }, [sortedDoctors, routeTargets, cardDisplayMode, isRouteStarted, removeFromRoute, handleRouteClick, toggleFavorite]);

  const resetToGPS = () => {
    setIsManualOrigin(false);
    setCustomOrigin(null);
    setIsFollowingUser(true); // Включаем для синей иконки кнопки
    setRouteData(null);
    // Плавный перелёт к текущему местоположению
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

  const renderRouteButton = (doc, isPopup = false) => {
    const isTarget = routeTargets.some(t => t.id === doc.id);
    const commonClasses = isPopup
      ? 'mt-3 w-full text-sm font-medium py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition-all'
      : 'w-full flex-1 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white font-medium px-5 py-2.5 rounded-xl inline-flex items-center justify-center gap-2.5 transition-all border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-700 dark:hover:text-blue-100';

    const redClasses = isPopup
      ? `${commonClasses} bg-red-50 text-red-600 border border-red-200`
      : `${commonClasses} bg-red-50 text-red-600 hover:bg-red-600 hover:text-white border-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-700 dark:hover:text-red-100 dark:border-red-800`;

    if (isTarget) {
      return (
        <button type="button" onClick={() => removeFromRoute(doc.id)} className={redClasses}>
          <XCircle size={isPopup ? 16 : 18} /> {isPopup ? 'Убрать' : 'Убрать из маршрута'}
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => handleRouteClick(doc)}
        className={isPopup ? `${commonClasses} bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:border-blue-800` : commonClasses}
      >
        <Navigation size={isPopup ? 16 : 18} /> {isPopup ? 'Показать путь' : 'Добавить в маршрут'}
      </button>
    );
  };

  const renderListingCard = (doc) => {
    const isTarget = routeTargets.some(t => t.id === doc.id);
    const isDoctorCard = doc.entityKind === 'doctor';
    const distanceLabel = doc.distanceKm == null ? 'Геолокация недоступна' : formatDistance(doc.distanceKm * 1000);
    const hasVisibleDescription = Boolean((doc.description || '').trim()) && !/данные из openstreetmap/i.test(String(doc.description));
    const isScheduleOpen = expandedSchedules.has(doc.id);
    const externalMapUrl = buildExternalMapUrl(activeOrigin, [doc], travelMode);

    return (
      <div
        key={doc.id}
        className={`card-fade-in rounded-2xl sm:rounded-3xl border bg-white p-3 sm:p-5 shadow-sm transition-all dark:bg-slate-800 dark:text-white ${isTarget ? 'border-blue-400 ring-2 ring-blue-100 dark:border-blue-500 dark:ring-blue-900' : isDoctorCard ? 'border-blue-100 hover:shadow-md dark:border-blue-900' : 'border-emerald-100 hover:shadow-md dark:border-emerald-900'
          }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-extrabold text-slate-800 dark:text-white">{doc.name}</h3>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] ${isDoctorCard ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-100' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-100'}`}>
                {isDoctorCard ? 'Врач' : 'Учреждение'}
              </span>
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

        {/* Пометка о происхождении данных: запись взята с официального сайта
            учреждения, и на неё можно перейти и проверить самому. */}
        {doc.sourceUrl && (
          <a
            href={doc.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
            title={`Данные с официального сайта учреждения. Сверено ${doc.verifiedAt || ''}`}
          >
            <ShieldCheck size={13} aria-hidden="true" />
            Проверено по официальному сайту
            <ExternalLink size={11} className="opacity-60" aria-hidden="true" />
          </a>
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
              <button
                type="button"
                onClick={() => toggleSchedule(doc.id)}
                aria-expanded={isScheduleOpen}
                className="inline-flex items-center gap-1 text-left underline decoration-dotted underline-offset-4 transition-colors hover:text-blue-600 dark:hover:text-blue-400"
              >
                Сегодня: {doc.todayHours}
                {isScheduleOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              </button>
            ) : (
              <span className="text-slate-400 dark:text-slate-500">График не указан</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isDoctorCard ? <TrendingUp size={16} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" /> : <Building2 size={16} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />}
            <span>{isDoctorCard ? `Стаж: ${doc.experience > 0 ? `${doc.experience} лет` : 'не указан'}` : `Тип: ${doc.facilityType || doc.specialty}`}</span>
          </div>
        </div>

        {/* Расписание на неделю — данные лежали в doc.schedule, но наружу
            выходил только сегодняшний день. */}
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

        {/* Цены: диапазоны лежали в servicePrices и никогда не показывались. */}
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
              Ориентировочные цены. Уточняйте в учреждении.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {isDoctorCard ? (
            // Пустой бейдж «Рейтинг: н/д» стоял почти на половине карточек и
            // ничего не сообщал — теперь его просто нет.
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
          {doc.features.onlineBooking && <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200">Онлайн-запись</span>}
          {doc.features.wheelchair && <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 dark:bg-blue-900 dark:text-blue-200">Доступная среда</span>}
          {doc.features.children && <span className="rounded-full bg-pink-50 px-3 py-1 text-xs font-semibold text-pink-700 dark:bg-pink-900 dark:text-pink-200">Детский приём</span>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {(doc.services || []).map((service) => (
            <span key={service} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {service}
            </span>
          ))}
        </div>

        {hasVisibleDescription && <p className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-400">{doc.description}</p>}

        {/* Контакты: телефон и сайт лежали в данных, но в интерфейс не выходили.
            На телефоне звонок — основное целевое действие, поэтому он первым. */}
        {(doc.telHref || doc.websiteUrl) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {doc.telHref && (
              <a
                href={doc.telHref}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              >
                <Phone size={16} aria-hidden="true" /> {doc.phone}
              </a>
            )}
            {doc.websiteUrl && (
              <a
                href={doc.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
              >
                <Globe size={16} aria-hidden="true" /> Сайт
                <ExternalLink size={13} className="opacity-60" aria-hidden="true" />
              </a>
            )}
          </div>
        )}

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
  };
  const filterSetters = {
    searchQuery: setSearchQuery, doctorProfile: setSelectedDoctorProfile,
    facilityType: setSelectedFacilityType, ownership: setSelectedOwnership,
    clinic: setSelectedClinic, district: setSelectedDistrict, services: setSelectedServices,
    childrenOnly: setChildrenOnly, openOnly: setOpenOnly, favoritesOnly: setFavoritesOnly,
    weekendOnly: setWeekendOnly, eveningOnly: setEveningOnly,
    onlineOnly: setOnlineOnly, wheelchairOnly: setWheelchairOnly,
    minRating: setMinRating, minExperience: setMinExperience, maxDistance: setMaxDistance,
  };
  const handleFilterChange = (field, value) => {
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
          <aside
            ref={sidebarRef}
            aria-label="Поиск врачей и учреждений"
            inert={isSidebarCollapsed && !isMobile}
            className={`search-sidebar ${isMobile ? 'mobile-bottom-sheet' : ''} z-[1000] relative flex shrink-0 flex-col bg-white shadow-2xl overflow-hidden dark:bg-slate-800 transition-all duration-300 ease-in-out ${isSidebarCollapsed && !isMobile ? 'border-r-0' : ''} ${isMobile ? 'fixed inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-3xl' : ''}`}
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
            <header className="shrink-0 px-4 pb-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <MapPin size={24} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  <div>
                    <h1 className="text-[23px] font-extrabold leading-none tracking-tight text-blue-600 dark:text-blue-400">МедКарта</h1>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Казань</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
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
              <SearchFilters
                filters={filters}
                options={{ doctorProfiles, facilityTypes, clinics, services: allServices }}
                onChange={handleFilterChange}
                onReset={clearFilters}
                onNearest={handleGoToNearest}
              />
              <div className="sidebar-results mt-1">
                <h2 role="status" aria-live="polite">Найдено {sortedDoctors.length.toLocaleString('ru-RU')}</h2>
                <div className="sidebar-results-actions">
                  <label className="filter-select-wrap">
                    <span className="sr-only">Сортировка результатов</span>
                    <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                      <option value="recommendation">По рекомендации</option>
                      <option value="distance">По расстоянию</option>
                      <option value="schedule">Сначала открытые</option>
                      <option value="name">По имени</option>
                      <option value="clinic">По клинике</option>
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
                {sortedDoctors.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
                    {/* Пустое состояние теперь называет конкретную причину:
                        общее «ослабьте фильтры» не подсказывает, какой снять. */}
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
                            : searchQuery
                              ? `По запросу «${searchQuery}» совпадений нет. Проверьте раскладку или попробуйте более общее слово.`
                              : 'Ослабьте фильтры или очистите поиск, чтобы вернуть карточки.'}
                        </p>
                        <div className="mt-4 flex flex-wrap justify-center gap-2">
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
          {/* Collapsed route pill */}
          {routeTargets.length > 0 && isRoutePanelCollapsed && (
            <div
              className="mx-3 mb-2 cursor-pointer"
              onClick={() => setIsRoutePanelCollapsed(false)}
            >
              <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-3 shadow-[0_4px_20px_rgba(59,130,246,0.35)] transition-transform active:scale-[0.98] dark:from-blue-700 dark:to-blue-600">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
                  <Navigation size={18} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-blue-100">Smart-маршрут · {routeTargets.length} {routeTargets.length === 1 ? 'точка' : routeTargets.length < 5 ? 'точки' : 'точек'}</div>
                  {routeData && !routeData.error ? (
                    <div className="mt-0.5 text-[15px] font-extrabold text-white">{formatTime(routeData.time)} <span className="font-medium text-blue-200">· {formatDistance(routeData.distance)}</span></div>
                  ) : (
                    <div className="mt-0.5 text-sm font-medium text-blue-200">Построение маршрута...</div>
                  )}
                </div>
                <ChevronUp size={20} className="shrink-0 text-white/70" />
              </div>
            </div>
          )}

          {/* Expanded route panel */}
          {routeTargets.length > 0 && !isRoutePanelCollapsed && (
            <div className="mx-2 mb-2 max-h-[55vh] overflow-hidden overflow-y-auto rounded-2xl border border-slate-100 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800">
              <div className="sticky top-0 z-10 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white px-4 py-3 dark:border-slate-700 dark:from-slate-700 dark:to-slate-800">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">Smart-Маршрут</div>
                    <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">{routeTargets.length}</div>
                  </div>
                  <button type="button" onClick={() => setIsRoutePanelCollapsed(true)} className="rounded-lg p-1.5 text-slate-400 transition-colors active:bg-slate-200 dark:active:bg-slate-700">
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
                      <div className="cursor-pointer flex-1 min-w-0" onClick={() => setFlyToTarget([target.lat, target.lng])}>
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
                    <div className="text-sm font-medium text-red-500">Маршрут не найден</div>
                  ) : (
                    <>
                      <div className="text-3xl font-extrabold tracking-tight text-slate-800 dark:text-white">{formatTime(routeData.time)}</div>
                      <div className="mt-1 font-medium text-slate-500 dark:text-slate-400">{formatDistance(routeData.distance)}</div>
                    </>
                  )
                ) : (
                  <div className="flex items-center justify-center gap-2 py-2 opacity-60">
                    <Loader2 className="animate-spin text-slate-400" size={20} />
                    <span className="text-sm dark:text-slate-400">Строим маршрут...</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/50">
                {!isRouteStarted ? (
                  <button type="button" onClick={() => setIsRouteStarted(true)} className="w-full rounded-xl bg-blue-600 py-3 font-semibold text-white transition-colors active:bg-blue-700 dark:bg-blue-600 dark:active:bg-blue-500">
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
            <button type="button" onClick={() => setIsAIAssistantOpen(current => !current)} aria-label="Открыть AI-ассистента" className="flex flex-col items-center gap-1 rounded-2xl px-5 py-2 text-violet-600 transition-all active:bg-violet-50 dark:text-violet-400 dark:active:bg-slate-700">
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

      {!isMobile && !isSidebarCollapsed && (
        <div className="z-[1010] flex w-2 cursor-col-resize items-center justify-center bg-slate-200 transition-colors hover:bg-blue-400 dark:bg-slate-600" onMouseDown={() => setIsDraggingPanel(true)}>
          <div className="h-8 w-1 rounded-full bg-slate-400 transition-colors group-hover:bg-white dark:bg-slate-500 dark:group-hover:bg-slate-300" />
        </div>
      )}

      <main className="relative flex-1 bg-slate-100 dark:bg-slate-900">
        {!isMobile && routeTargets.length > 0 && isRoutePanelCollapsed && (
          <div
            className={`route-panel-slide-in absolute z-[1000] cursor-pointer ${isMobile ? 'left-3 right-3' : 'right-6 top-6'}`}
            style={isMobile ? { bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))' } : undefined}
            onClick={() => setIsRoutePanelCollapsed(false)}
          >
            <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-3 shadow-[0_4px_20px_rgba(59,130,246,0.35)] transition-transform active:scale-[0.98] dark:from-blue-700 dark:to-blue-600">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
                <Navigation size={18} className="text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-blue-100">Smart-маршрут · {routeTargets.length} {routeTargets.length === 1 ? 'точка' : routeTargets.length < 5 ? 'точки' : 'точек'}</div>
                {routeData && !routeData.error ? (
                  <div className="mt-0.5 text-[15px] font-extrabold text-white">{formatTime(routeData.time)} <span className="font-medium text-blue-200">· {formatDistance(routeData.distance)}</span></div>
                ) : (
                  <div className="mt-0.5 text-sm font-medium text-blue-200">Построение маршрута...</div>
                )}
              </div>
              <ChevronUp size={20} className="shrink-0 text-white/70" />
            </div>
          </div>
        )}

        {!isMobile && routeTargets.length > 0 && !isRoutePanelCollapsed && (
          <div
            className={`route-panel-slide-in absolute z-[1000] overflow-hidden border border-slate-100 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 ${isMobile ? 'left-2 right-2 rounded-2xl' : 'right-6 top-6 w-80 rounded-3xl'}`}
            style={isMobile ? { bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))', maxHeight: '55vh' } : undefined}
          >
            <div className={`border-b border-slate-100 bg-gradient-to-r from-blue-50 to-white dark:border-slate-700 dark:from-slate-700 dark:to-slate-800 ${isMobile ? 'px-4 py-3' : 'px-5 py-4'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-600 dark:text-blue-400">Smart-Маршрут</div>
                  <div className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900 dark:text-blue-300">{routeTargets.length}</div>
                </div>
                <button type="button" onClick={() => setIsRoutePanelCollapsed(true)} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 active:bg-slate-200 dark:hover:bg-slate-700">
                  <ChevronDown size={16} />
                </button>
              </div>
            </div>

            {/* Route targets list */}
            <div className={`${isMobile ? 'px-3 py-2 max-h-[30vh] overflow-y-auto' : 'px-5 py-3'}`}>
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
                    {isMobile && routeTargets.length > 1 && (
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
                    <div className="cursor-pointer flex-1 min-w-0" onClick={() => setFlyToTarget([target.lat, target.lng])}>
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
                  <div className="text-sm font-medium text-red-500">Маршрут для этого транспорта не найден</div>
                ) : (
                  <>
                    <div className={`${isMobile ? 'text-3xl' : 'text-4xl'} font-extrabold tracking-tight text-slate-800 dark:text-white`}>{formatTime(routeData.time)}</div>
                    <div className="mt-1 font-medium text-slate-500 dark:text-slate-400">{formatDistance(routeData.distance)}</div>
                  </>
                )
              ) : (
                <div className="flex flex-col items-center justify-center py-2 opacity-60">
                  <Loader2 className="mb-2 animate-spin text-slate-400 dark:text-slate-500" size={24} />
                  <span className="text-sm dark:text-slate-400">Строим маршрут...</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/50">
              {!isRouteStarted ? (
                <button type="button" onClick={() => setIsRouteStarted(true)} className="w-full rounded-xl bg-blue-600 py-3 font-semibold text-white transition-colors hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500">
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

          <RoutingMachine originLocation={activeOrigin} routeTargets={routeTargets} travelMode={travelMode} setRouteData={stableSetRouteData} />
          <InvalidateMapSize />

          <InitialCenterMap location={userLocation} />
          {flyToTarget && <FlyToPoint target={flyToTarget} onDone={() => setFlyToTarget(null)} />}
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
              onClick={() => setIsAIAssistantOpen(current => !current)}
              aria-label="Открыть AI-ассистента"
              aria-expanded={isAIAssistantOpen}
              className="absolute bottom-[88px] right-6 z-[1000] rounded-full bg-violet-600 p-3 text-white shadow-[0_4px_20px_rgba(124,58,237,0.4)] transition-all hover:scale-105 hover:bg-violet-700"
              title="AI-Ассистент"
            >
              <Bot size={24} />
            </button>
          </>
        )}

        {isAIAssistantOpen && (
          <Suspense fallback={null}>
            <AIAssistant
              isOpen={isAIAssistantOpen}
              onClose={() => setIsAIAssistantOpen(false)}
              onApplyTriage={handleApplyTriage}
              isMobile={isMobile}
            />
          </Suspense>
        )}
      </main>

      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
// [GitHub Actions] Simulated map route stabilization
