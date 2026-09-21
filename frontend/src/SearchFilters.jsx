import { Baby, Building2, ChevronDown, Clock, LayoutGrid, Navigation, SlidersHorizontal, UserRound, X } from 'lucide-react';
import './SearchFilters.css';

const MODES = [
  { value: 'all', label: 'Все', icon: LayoutGrid },
  { value: 'doctor', label: 'Врачи', icon: UserRound },
  { value: 'facility', label: 'Учреждения', icon: Building2 },
];

const EXTRA_OPTIONS = [
  { field: 'weekendOnly', label: 'По выходным' },
  { field: 'eveningOnly', label: 'Вечерний приём', title: 'Работают до 20:00 или позже' },
  { field: 'onlineOnly', label: 'Онлайн-запись' },
  { field: 'wheelchairOnly', label: 'Доступная среда' },
];

function FilterSelect({ label, value, onChange, placeholder, options, disabled = false }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <span className="filter-select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
          <option value="all">{placeholder}</option>
          {options.map((option, index) => <option key={`${option}-${index}`} value={option}>{option}</option>)}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </span>
    </label>
  );
}

function FilterPill({ active, onClick, children }) {
  return (
    <button type="button" className="filter-pill" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

export default function SearchFilters({ filters, options, onChange, onReset, onNearest }) {
  const isFacility = filters.cardDisplayMode === 'facility';
  const activeFilters = [];
  const add = (field, label, emptyValue = 'all') => {
    if (filters[field] !== emptyValue) {
      activeFilters.push({ key: field, label, clear: () => onChange(field, emptyValue) });
    }
  };

  if (filters.searchQuery) add('searchQuery', `Поиск: ${filters.searchQuery}`, '');
  add('cardDisplayMode', filters.cardDisplayMode === 'doctor' ? 'Врачи' : 'Учреждения');
  add('doctorProfile', filters.doctorProfile);
  add('facilityType', filters.facilityType);
  add('ownership', filters.ownership === 'Государственная' ? 'Государственные' : 'Частные');
  add('clinic', filters.clinic);
  add('childrenOnly', 'Для детей', false);
  add('openOnly', 'Открыто сейчас', false);
  add('favoritesOnly', 'Избранное', false);
  EXTRA_OPTIONS.forEach(({ field, label }) => add(field, label, false));
  add('maxDistance', `До ${filters.maxDistance} км`, 0);

  // Старые ссылки и AI могут задавать условия, которых больше нет в форме.
  // Они остаются видимыми, чтобы ни один фильтр не скрывал выдачу незаметно.
  add('district', filters.district);
  add('minRating', `Рейтинг от ${filters.minRating}`, 0);
  add('minExperience', `Стаж от ${filters.minExperience} лет`, 0);
  filters.services.forEach((service) => activeFilters.push({
    key: `service-${service}`,
    label: service,
    clear: () => onChange('services', filters.services.filter((item) => item !== service)),
  }));

  const extraCount = Number(filters.clinic !== 'all') + Number(filters.maxDistance > 0)
    + EXTRA_OPTIONS.filter(({ field }) => filters[field]).length + filters.services.length;
  const canReset = activeFilters.length > 0 || filters.cardDisplayMode !== 'all';

  return (
    <section className="search-filters" aria-label="Фильтры поиска">
      <div className="filter-modes" role="group" aria-label="Что ищем">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            aria-pressed={filters.cardDisplayMode === mode.value}
            onClick={() => onChange('cardDisplayMode', mode.value)}
          >
            <mode.icon size={15} aria-hidden="true" /> {mode.label}
          </button>
        ))}
      </div>

      <FilterSelect
        label={isFacility ? 'Тип учреждения' : 'Специальность врача'}
        value={isFacility ? filters.facilityType : filters.doctorProfile}
        onChange={(value) => onChange(isFacility ? 'facilityType' : 'doctorProfile', value)}
        placeholder={isFacility ? 'Любой тип' : 'Любая специальность'}
        options={isFacility ? options.facilityTypes : options.doctorProfiles}
      />

      <div className="filter-pills" role="group" aria-label="Форма собственности">
        {['Государственная', 'Частная'].map((ownership) => (
          <FilterPill
            key={ownership}
            active={filters.ownership === ownership}
            onClick={() => onChange('ownership', filters.ownership === ownership ? 'all' : ownership)}
          >
            {ownership === 'Государственная' ? 'Государственные' : 'Частные'}
          </FilterPill>
        ))}
        <FilterPill active={filters.childrenOnly} onClick={() => onChange('childrenOnly', !filters.childrenOnly)}>
          <Baby size={15} aria-hidden="true" /> Для детей
        </FilterPill>
        {filters.cardDisplayMode !== 'doctor' && (
          <FilterPill active={filters.openOnly} onClick={() => onChange('openOnly', !filters.openOnly)}>
            <Clock size={15} aria-hidden="true" /> Открыто сейчас
          </FilterPill>
        )}
      </div>

      <details className="filter-more">
        <summary>
          <SlidersHorizontal size={16} aria-hidden="true" />
          <span>Дополнительные фильтры</span>
          {extraCount > 0 && <span className="filter-count">{extraCount}</span>}
          <ChevronDown className="filter-more-chevron" size={16} aria-hidden="true" />
        </summary>
        <div className="filter-more-content">
          <FilterSelect
            label="Конкретная клиника"
            value={filters.clinic}
            onChange={(value) => onChange('clinic', value)}
            placeholder="Любая клиника"
            options={options.clinics}
          />
          <label className="filter-field">
            <span className="filter-distance-label">
              Расстояние <span>{filters.maxDistance === 0 ? 'Не ограничено' : `До ${filters.maxDistance} км`}</span>
            </span>
            <input
              type="range"
              min="0"
              max="50"
              step="1"
              value={filters.maxDistance}
              aria-label="Максимальное расстояние"
              aria-valuetext={filters.maxDistance === 0 ? 'Без ограничения' : `${filters.maxDistance} километров`}
              onChange={(event) => onChange('maxDistance', Number(event.target.value))}
            />
          </label>
          <fieldset className="filter-options">
            <legend>Условия приёма</legend>
            <div>
              {EXTRA_OPTIONS.map(({ field, label, title }) => (
                <label key={field} title={title}>
                  <input type="checkbox" checked={filters[field]} onChange={(event) => onChange(field, event.target.checked)} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <FilterSelect
            label="Услуги"
            value="all"
            onChange={(value) => {
              if (value !== 'all') onChange('services', [...filters.services, value]);
            }}
            placeholder={filters.services.length >= 6 ? 'Выбрано 6 услуг' : 'Добавить услугу'}
            options={options.services.filter((service) => !filters.services.includes(service))}
            disabled={filters.services.length >= 6}
          />
          <button type="button" className="filter-nearest" onClick={onNearest}>
            <Navigation size={15} aria-hidden="true" /> Ближайшая открытая на карте
          </button>
        </div>
      </details>

      {canReset && (
        <div className="active-filters">
          <div className="active-filters-heading">
            <span>Выбрано{activeFilters.length > 0 ? ` · ${activeFilters.length}` : ''}</span>
            <button type="button" onClick={onReset}>Сбросить</button>
          </div>
          {activeFilters.length > 0 && (
            <ul aria-label="Выбранные фильтры">
              {activeFilters.map(({ key, label, clear }) => (
                <li key={key}>
                  <button type="button" onClick={clear} aria-label={`Убрать фильтр: ${label}`} title={label}>
                    <span>{label}</span><X size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
