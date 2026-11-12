/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории в админ-панели: лаборатории, филиалы и расписания, исследования,
 * цены и доступность, процедуры взятия, демо-записи. Права проверяет сервер
 * (labs.view, labs.manage, labs.bookings) — кнопки здесь только отражают их.
 * Все данные — демонстрационные.
 */
import { useMemo, useState } from 'react';
import { FlaskConical, Plus, Save, Search, XCircle } from 'lucide-react';

import { api, useApi } from '../api';
import { useAdmin } from '../model';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, inputClass, Modal, SelectInput, Skeleton, Tabs, TextInput, Toggle } from '../../ui/kit';
import { formatDateTime } from '../../ui/format';
import { useToast } from '../../ui/hooks';

const CATEGORIES = [
  ['clinical', 'Общеклинические'], ['biochemistry', 'Биохимия'], ['hormones', 'Гормоны'], ['vitamins', 'Витамины и микроэлементы'], ['coagulation', 'Гемостаз'],
  ['immunology', 'Иммунология'], ['infections', 'Инфекции'], ['urine', 'Моча'], ['feces', 'Кал'],
];
const BIOMATERIALS = [['venous_blood', 'Венозная кровь'], ['capillary_blood', 'Капиллярная кровь'], ['urine', 'Моча'], ['feces', 'Кал'], ['swab', 'Мазок']];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const rub = (value) => `${Number(value).toLocaleString('ru-RU')} ₽`;

/** «07:00-12:00, 14:00-17:00» ↔ [["07:00","12:00"],["14:00","17:00"]]. */
const weeklyToText = (weekly) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, (weekly?.[day] || weekly?.[String(day)] || []).map(([from, to]) => `${from}-${to}`).join(', ')]));
const textToWeekly = (texts) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, String(texts[day] || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => part.split('-').map((item) => item.trim()))]));

function LabsTab({ canManage }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/labs'), []);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    try {
      if (edit.id) await api.patch(`/api/admin/labs/${edit.id}`, { name: edit.name, description: edit.description, phone: edit.phone, active: edit.active, version: edit.version });
      else await api.post('/api/admin/labs', { name: edit.name, description: edit.description, phone: edit.phone });
      toast(edit.id ? 'Лаборатория сохранена' : 'Лаборатория создана', 'success');
      setEdit(null);
      reload();
    } catch (saveError) {
      toast(saveError.message, 'error');
    }
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <Card title="Лаборатории" description={data ? `Филиалов: ${data.stats.branches}, исследований: ${data.stats.tests}, предложений: ${data.stats.offerings}, активных записей: ${data.stats.bookings}` : ''}
      actions={canManage && <Button icon={Plus} variant="primary" onClick={() => setEdit({ name: '', description: '', phone: '', active: true })}>Добавить</Button>}>
      {loading && !data ? <Skeleton className="h-24 w-full" /> : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="admin-labs-list">
          {data.labs.map((lab) => (
            <li key={lab.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0"><p className="font-semibold">{lab.name} {!lab.active && <Badge tone="slate">выключена</Badge>} {lab.demo && <Badge tone="amber">демо</Badge>}</p><p className="truncate text-[12.5px] text-slate-500">{lab.description}</p></div>
              {canManage && <Button size="sm" onClick={() => setEdit({ ...lab })}>Изменить</Button>}
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <Modal title={edit.id ? 'Лаборатория' : 'Новая лаборатория'} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Отмена</Button><Button variant="primary" icon={Save} onClick={save}>Сохранить</Button></>}>
          <div className="space-y-3">
            <TextInput label="Название" value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} maxLength={80} />
            <TextInput label="Описание" value={edit.description || ''} onChange={(event) => setEdit({ ...edit, description: event.target.value })} maxLength={600} />
            <TextInput label="Телефон" value={edit.phone || ''} onChange={(event) => setEdit({ ...edit, phone: event.target.value })} maxLength={40} />
            {edit.id && <Toggle checked={edit.active} onChange={(value) => setEdit({ ...edit, active: value })} label="Активна" description="Выключенная лаборатория не показывается в подборе и каталоге." />}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function BranchModal({ branch, labs, onClose, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => ({
    ...branch,
    hoursText: weeklyToText(branch.hours),
    collectionText: weeklyToText(branch.collection),
  }));
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const body = {
      name: draft.name, address: draft.address, district: draft.district || null, phone: draft.phone || null, lat: Number(draft.lat), lng: Number(draft.lng),
      slotMinutes: Number(draft.slotMinutes), slotCapacity: Number(draft.slotCapacity), hours: textToWeekly(draft.hoursText), collection: textToWeekly(draft.collectionText),
    };
    try {
      if (draft.id) await api.patch(`/api/admin/labs/branches/${draft.id}`, { ...body, active: draft.active, version: draft.version });
      else await api.post('/api/admin/labs/branches', { ...body, labId: draft.labId });
      toast('Филиал сохранён. Будущие слоты без записей пересчитаны по новому расписанию.', 'success');
      onSaved();
    } catch (saveError) {
      toast(saveError.message, 'error');
    }
  };
  return (
    <Modal size="lg" title={draft.id ? draft.name : 'Новый филиал'} onClose={onClose} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" icon={Save} onClick={save}>Сохранить</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!draft.id && <SelectInput label="Лаборатория" value={draft.labId} onChange={(event) => set('labId', event.target.value)} options={labs.map((lab) => ({ value: lab.id, label: lab.name }))} />}
        <TextInput label="Название" value={draft.name} onChange={(event) => set('name', event.target.value)} />
        <TextInput label="Адрес" value={draft.address} onChange={(event) => set('address', event.target.value)} />
        <TextInput label="Район" value={draft.district || ''} onChange={(event) => set('district', event.target.value)} />
        <TextInput label="Широта" value={draft.lat} onChange={(event) => set('lat', event.target.value)} inputMode="decimal" />
        <TextInput label="Долгота" value={draft.lng} onChange={(event) => set('lng', event.target.value)} inputMode="decimal" />
        <TextInput label="Длительность слота, мин" value={draft.slotMinutes} onChange={(event) => set('slotMinutes', event.target.value)} inputMode="numeric" />
        <TextInput label="Мест в слоте" value={draft.slotCapacity} onChange={(event) => set('slotCapacity', event.target.value)} inputMode="numeric" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {[['hoursText', 'Часы работы'], ['collectionText', 'Приём биоматериала']].map(([key, title]) => (
          <fieldset key={key} className="space-y-1.5">
            <legend className="mb-1 text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">{title} (ЧЧ:ММ-ЧЧ:ММ через запятую, пусто — закрыто)</legend>
            {WEEKDAYS.map((label, index) => (
              <label key={label} className="flex items-center gap-2 text-[13px]"><span className="w-6 text-slate-500">{label}</span>
                <input className={inputClass} value={draft[key][index + 1]} onChange={(event) => set(key, { ...draft[key], [index + 1]: event.target.value })} aria-label={`${title}: ${label}`} />
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {draft.id && <div className="mt-4"><Toggle checked={draft.active} onChange={(value) => set('active', value)} label="Филиал работает" description="Выключенный филиал не участвует в подборе; существующие записи сохраняются." /></div>}
    </Modal>
  );
}

function BranchesTab({ canManage }) {
  const toast = useToast();
  const labs = useApi(() => api.get('/api/admin/labs'), []);
  const [labId, setLabId] = useState('');
  const branches = useApi(() => api.get('/api/admin/labs/branches', labId ? { labId } : {}), [labId]);
  const [edit, setEdit] = useState(null);
  const setFee = async (branch, kind, value) => {
    try {
      await api.put(`/api/admin/labs/branches/${branch.id}/fees/${kind}`, { price: value === '' ? null : Number(value) });
      toast('Стоимость процедуры сохранена', 'success');
      branches.reload();
    } catch (feeError) {
      toast(feeError.message, 'error');
    }
  };
  if (branches.error) return <ErrorState error={branches.error} onRetry={branches.reload} />;
  const labList = labs.data?.labs || [];
  return (
    <Card title="Филиалы и расписания" actions={canManage && labList.length > 0 && <Button icon={Plus} variant="primary" onClick={() => setEdit({ labId: labId || labList[0].id, name: '', address: '', lat: 55.7963, lng: 49.1088, slotMinutes: 10, slotCapacity: 2, hours: {}, collection: {} })}>Добавить</Button>}>
      <div className="mb-3 max-w-xs"><SelectInput label="Лаборатория" value={labId} onChange={(event) => setLabId(event.target.value)} options={[{ value: '', label: 'Все' }, ...labList.map((lab) => ({ value: lab.id, label: lab.name }))]} /></div>
      {!branches.data ? <Skeleton className="h-24 w-full" /> : (
        <ul className="space-y-3" data-testid="admin-branches-list">
          {branches.data.branches.map((branch) => (
            <li key={branch.id} className="rounded-2xl border border-slate-200 p-3 text-[13px] dark:border-slate-800">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-semibold">{branch.name} {!branch.active && <Badge tone="slate">выключен</Badge>}</p><p className="text-slate-500">{branch.address} · слот {branch.slotMinutes} мин × {branch.slotCapacity} места</p></div>
                {canManage && <Button size="sm" onClick={() => setEdit(branch)}>Изменить</Button>}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {BIOMATERIALS.map(([kind, label]) => {
                  const fee = branch.fees.find((item) => item.kind === kind);
                  return (
                    <label key={kind} className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300">{label}:
                      <input defaultValue={fee ? fee.price : ''} placeholder="не принимают" disabled={!canManage} className="w-24 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                        onBlur={(event) => event.target.value !== String(fee?.price ?? '') && setFee(branch, kind, event.target.value.replace(/\D/g, ''))} aria-label={`Взятие: ${label}, ₽`} />
                    </label>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit && <BranchModal branch={edit} labs={labList} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); branches.reload(); }} />}
    </Card>
  );
}

function TestModal({ test, onClose, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(() => ({ ...test, synonymsText: (test.synonyms || []).join(', '), componentsText: (test.components || []).join(', ') }));
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    const body = {
      name: draft.name, category: draft.category, biomaterial: draft.biomaterial, unit: draft.unit || null, description: draft.description || '', preparation: draft.preparation || '',
      turnaroundHours: Number(draft.turnaroundHours), fasting: Boolean(draft.fasting), requiresBooking: Boolean(draft.requiresBooking),
      synonyms: draft.synonymsText.split(',').map((item) => item.trim()).filter(Boolean), components: draft.componentsText.split(',').map((item) => item.trim()).filter(Boolean),
    };
    try {
      if (test.code) await api.patch(`/api/admin/labs/tests/${test.code}`, { ...body, active: draft.active, version: draft.version });
      else await api.post('/api/admin/labs/tests', { ...body, code: draft.code });
      toast('Исследование сохранено', 'success');
      onSaved();
    } catch (saveError) {
      toast(saveError.message, 'error');
    }
  };
  return (
    <Modal size="lg" title={test.code ? test.name : 'Новое исследование'} onClose={onClose} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" icon={Save} onClick={save}>Сохранить</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {!test.code && <TextInput label="Код (латиница, A–Z, 0–9, _)" value={draft.code || ''} onChange={(event) => set('code', event.target.value.toUpperCase())} />}
        <TextInput label="Название" value={draft.name} onChange={(event) => set('name', event.target.value)} />
        <SelectInput label="Категория" value={draft.category} onChange={(event) => set('category', event.target.value)} options={CATEGORIES.map(([value, label]) => ({ value, label }))} />
        <SelectInput label="Биоматериал" value={draft.biomaterial} onChange={(event) => set('biomaterial', event.target.value)} options={BIOMATERIALS.map(([value, label]) => ({ value, label }))} />
        <TextInput label="Единица" value={draft.unit || ''} onChange={(event) => set('unit', event.target.value)} />
        <TextInput label="Срок по умолчанию, ч" value={draft.turnaroundHours} onChange={(event) => set('turnaroundHours', event.target.value)} inputMode="numeric" />
      </div>
      <div className="mt-3 space-y-3">
        <TextInput label="Синонимы через запятую (по ним ассистент узнаёт исследование)" value={draft.synonymsText} onChange={(event) => set('synonymsText', event.target.value)} />
        <TextInput label="Состав через запятую" value={draft.componentsText} onChange={(event) => set('componentsText', event.target.value)} />
        <TextInput label="Описание" value={draft.description || ''} onChange={(event) => set('description', event.target.value)} />
        <label className="block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">Подготовка (проверенный справочный текст)
          <textarea className={`${inputClass} mt-1 min-h-24`} value={draft.preparation || ''} onChange={(event) => set('preparation', event.target.value)} maxLength={1200} />
        </label>
        <Toggle checked={Boolean(draft.fasting)} onChange={(value) => set('fasting', value)} label="Натощак" />
        <Toggle checked={Boolean(draft.requiresBooking)} onChange={(value) => set('requiresBooking', value)} label="Только по записи" />
        {test.code && <Toggle checked={draft.active} onChange={(value) => set('active', value)} label="Активно" description="Выключенное исследование не показывается и не подбирается." />}
      </div>
    </Modal>
  );
}

function TestsTab({ canManage }) {
  const { data, error, reload } = useApi(() => api.get('/api/admin/labs/tests'), []);
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState(null);
  const visible = useMemo(() => (data?.tests || []).filter((test) => !query || `${test.name} ${test.code} ${(test.synonyms || []).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [data, query]);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <Card title="Исследования" description="Каталог общий для всех лабораторий. Цены и доступность задаются по филиалам."
      actions={canManage && <Button icon={Plus} variant="primary" onClick={() => setEdit({ name: '', category: 'clinical', biomaterial: 'venous_blood', turnaroundHours: 24, synonyms: [], components: [], active: true })}>Добавить</Button>}>
      <label className="relative mb-3 block max-w-md"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input className={`${inputClass} pl-9`} placeholder="Поиск по названию, коду, синониму" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Поиск исследования" /></label>
      {!data ? <Skeleton className="h-24 w-full" /> : (
        <ul className="divide-y divide-slate-100 text-[13px] dark:divide-slate-800" data-testid="admin-tests-list">
          {visible.map((test) => (
            <li key={test.code} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><p className="font-semibold">{test.name} <span className="font-mono text-[11px] text-slate-500">{test.code}</span> {!test.active && <Badge tone="slate">выключено</Badge>}</p>
                <p className="truncate text-slate-500">{test.biomaterialName} · {test.turnaroundHours} ч{test.fasting ? ' · натощак' : ''} · {(test.synonyms || []).slice(0, 4).join(', ')}</p></div>
              {canManage && <Button size="sm" onClick={() => setEdit(test)}>Изменить</Button>}
            </li>
          ))}
        </ul>
      )}
      {edit && <TestModal test={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Card>
  );
}

function PricesTab({ canManage }) {
  const toast = useToast();
  const branches = useApi(() => api.get('/api/admin/labs/branches'), []);
  const tests = useApi(() => api.get('/api/admin/labs/tests'), []);
  const [branchId, setBranchId] = useState('');
  const offerings = useApi(() => (branchId ? api.get(`/api/admin/labs/branches/${branchId}/offerings`) : Promise.resolve(null)), [branchId]);
  const [drafts, setDrafts] = useState({});
  const byCode = new Map((offerings.data?.offerings || []).map((item) => [item.testCode, item]));
  const draftOf = (code) => drafts[code] || (byCode.get(code) ? { price: String(byCode.get(code).price), hours: String(byCode.get(code).turnaroundHours), available: byCode.get(code).available } : { price: '', hours: '', available: true });
  const set = (code, patch) => setDrafts((current) => ({ ...current, [code]: { ...draftOf(code), ...patch } }));
  const save = async (code) => {
    const draft = draftOf(code);
    try {
      await api.put(`/api/admin/labs/branches/${branchId}/offerings/${code}`, { price: Number(draft.price), turnaroundHours: draft.hours ? Number(draft.hours) : undefined, available: draft.available });
      toast('Цена сохранена', 'success');
      setDrafts((current) => {
        const next = { ...current };
        delete next[code];
        return next;
      });
      offerings.reload();
    } catch (saveError) {
      toast(saveError.message, 'error');
    }
  };
  const remove = async (code) => {
    try {
      await api.del(`/api/admin/labs/branches/${branchId}/offerings/${code}`);
      toast('Исследование убрано из филиала', 'success');
      offerings.reload();
    } catch (removeError) {
      toast(removeError.message, 'error');
    }
  };
  const branchList = branches.data?.branches || [];
  return (
    <Card title="Цены, доступность и сроки" description="Цены демонстрационные. Дата цены ставится автоматически при сохранении.">
      <div className="mb-3 max-w-md"><SelectInput label="Филиал" value={branchId} onChange={(event) => { setBranchId(event.target.value); setDrafts({}); }} options={[{ value: '', label: 'Выберите филиал' }, ...branchList.map((branch) => ({ value: branch.id, label: branch.name }))]} /></div>
      {!branchId ? <EmptyState icon={FlaskConical} title="Выберите филиал" description="Покажем каталог с ценами этого филиала." /> : !offerings.data || !tests.data ? <Skeleton className="h-24 w-full" /> : (
        <div className="overflow-x-auto"><table className="w-full text-[13px]" data-testid="admin-prices-table">
          <thead><tr className="text-left text-slate-500"><th className="py-1.5">Исследование</th><th>Цена, ₽</th><th>Срок, ч</th><th>Доступно</th><th /></tr></thead>
          <tbody>
            {tests.data.tests.filter((test) => test.active).map((test) => {
              const draft = draftOf(test.code);
              const offered = byCode.has(test.code);
              return (
                <tr key={test.code} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5 pr-2">{test.name}{offered && <span className="ml-1 text-[11px] text-slate-400">на {byCode.get(test.code).priceDate}</span>}</td>
                  <td><input className="w-24 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-900" value={draft.price} disabled={!canManage} onChange={(event) => set(test.code, { price: event.target.value.replace(/\D/g, '') })} placeholder="нет" aria-label={`Цена: ${test.name}`} /></td>
                  <td><input className="w-16 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-900" value={draft.hours} disabled={!canManage} onChange={(event) => set(test.code, { hours: event.target.value.replace(/\D/g, '') })} placeholder={String(test.turnaroundHours)} aria-label={`Срок: ${test.name}`} /></td>
                  <td><input type="checkbox" checked={draft.available} disabled={!canManage} onChange={(event) => set(test.code, { available: event.target.checked })} aria-label={`Доступно: ${test.name}`} /></td>
                  <td className="whitespace-nowrap text-right">
                    {canManage && drafts[test.code] && draft.price !== '' && <Button size="sm" variant="primary" onClick={() => save(test.code)}>Сохранить</Button>}
                    {canManage && offered && !drafts[test.code] && <Button size="sm" onClick={() => remove(test.code)}>Убрать</Button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {offerings.data && <p className="mt-3 text-[12.5px] text-slate-500">Процедуры взятия: {offerings.data.fees.map((fee) => `${fee.name} — ${rub(fee.price)}`).join(' · ') || 'не заданы'}. Изменить — во вкладке «Филиалы».</p>}
    </Card>
  );
}

function BookingsTab({ canBookings }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, reload } = useApi(() => api.get('/api/admin/labs/bookings', { ...(status ? { status } : {}), page, pageSize: 50 }), [status, page]);
  const [cancelling, setCancelling] = useState(null);
  if (!canBookings) return <EmptyState icon={FlaskConical} title="Нет доступа" description="Для записей нужно разрешение «Демо-записи в лаборатории»." />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  return (
    <Card title="Демо-записи в лаборатории" description="Без персональных данных: номер, время, состав и сумма.">
      <div className="mb-3 max-w-xs"><SelectInput label="Статус" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} options={[{ value: '', label: 'Все' }, { value: 'CONFIRMED', label: 'Активные' }, { value: 'CANCELLED', label: 'Отменённые' }]} /></div>
      {!data ? <Skeleton className="h-24 w-full" /> : data.items.length === 0 ? <EmptyState icon={FlaskConical} title="Записей нет" description="Здесь появятся демо-записи пользователей." /> : (
        <ul className="divide-y divide-slate-100 text-[13px] dark:divide-slate-800" data-testid="admin-lab-bookings">
          {data.items.map((item) => (
            <li key={item.number} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="font-semibold"><span className="font-mono">{item.number}</span> · {item.lab?.name} {item.status === 'CANCELLED' ? <Badge tone="slate">отменена{item.cancelledBy === 'admin' ? ' администратором' : ''}</Badge> : <Badge tone="green">активна</Badge>}</p>
                <p className="text-slate-500">{item.slot ? `${item.slot.day} ${item.slot.start}` : ''} · {item.branch?.name} · создана {formatDateTime(item.createdAt)}</p>
                <p>{item.tests.map((test) => test.name).join(', ')} — <strong>{rub(item.total)}</strong></p>
              </div>
              {item.status === 'CONFIRMED' && <Button size="sm" icon={XCircle} onClick={() => setCancelling(item)}>Отменить</Button>}
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.pageSize && (
        <div className="mt-3 flex gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</Button><Button size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Дальше</Button></div>
      )}
      {cancelling && (
        <ConfirmDialog title={`Отменить запись ${cancelling.number}?`} message="Место в слоте освободится. Это демо-запись: никто не будет уведомлён." confirmLabel="Отменить запись"
          onClose={() => setCancelling(null)} onConfirm={async () => {
            await api.post(`/api/admin/labs/bookings/${cancelling.number}/cancel`, {});
            toast('Запись отменена', 'success');
            setCancelling(null);
            reload();
          }} />
      )}
    </Card>
  );
}

export default function LabsAdminPage() {
  const { can } = useAdmin();
  const [tab, setTab] = useState('labs');
  const canManage = can('labs.manage');
  const tabs = [
    { value: 'labs', label: 'Лаборатории' }, { value: 'branches', label: 'Филиалы' }, { value: 'tests', label: 'Исследования' },
    { value: 'prices', label: 'Цены' }, ...(can('labs.bookings') ? [{ value: 'bookings', label: 'Записи' }] : []),
  ];
  return (
    <div className="space-y-4" data-testid="admin-labs-page">
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        Демо-данные: лаборатории, филиалы, цены и записи вымышлены. Реальные лаборатории можно подключать только по договору с ними.{!canManage && ' Вам доступен только просмотр.'}
      </p>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Разделы лабораторий" />
      {tab === 'labs' && <LabsTab canManage={canManage} />}
      {tab === 'branches' && <BranchesTab canManage={canManage} />}
      {tab === 'tests' && <TestsTab canManage={canManage} />}
      {tab === 'prices' && <PricesTab canManage={canManage} />}
      {tab === 'bookings' && <BookingsTab canBookings={can('labs.bookings')} />}
    </div>
  );
}
