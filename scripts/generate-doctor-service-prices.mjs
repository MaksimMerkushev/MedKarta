import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const doctorsPath = path.resolve(__dirname, '../data/doctors.legacy.js');

const BASE_PRICE_MAP = {
  '\u0422\u0435\u0440\u0430\u043f\u0435\u0432\u0442': [1200, 1800],
  '\u041a\u0430\u0440\u0434\u0438\u043e\u043b\u043e\u0433': [1700, 2500],
  '\u041d\u0435\u0432\u0440\u043e\u043b\u043e\u0433': [1600, 2400],
  '\u041f\u0435\u0434\u0438\u0430\u0442\u0440': [1300, 2000],
  '\u041b\u041e\u0420': [1500, 2300],
  '\u041e\u0444\u0442\u0430\u043b\u044c\u043c\u043e\u043b\u043e\u0433': [1500, 2200],
  '\u0421\u0442\u043e\u043c\u0430\u0442\u043e\u043b\u043e\u0433': [1800, 3000],
};

const FALLBACK_PRICE = [1200, 2000];

const SERVICE_MULTIPLIER = {
  '\u0414\u0438\u0430\u0433\u043d\u043e\u0441\u0442\u0438\u043a\u0430': 1.15,
  '\u041f\u0440\u043e\u0444\u043e\u0441\u043c\u043e\u0442\u0440': 0.9,
  '\u0421\u043f\u0440\u0430\u0432\u043a\u0438': 0.75,
  '\u0427\u0435\u043a\u0430\u043f': 1.35,
  '\u0423\u0417\u0418': 1.2,
  '\u042d\u041a\u0413': 1.1,
  '\u0412\u0430\u043a\u0446\u0438\u043d\u0430\u0446\u0438\u044f': 1.25,
};

const OWNERSHIP_FACTOR = {
  '\u0413\u043e\u0441\u0443\u0434\u0430\u0440\u0441\u0442\u0432\u0435\u043d\u043d\u0430\u044f': 0.85,
  '\u0427\u0430\u0441\u0442\u043d\u0430\u044f': 1.15,
};

const stableJitter = (seed) => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  }
  return 0.94 + (hash % 13) / 100;
};

const roundTo50 = (value) => Math.round(value / 50) * 50;

const calcPriceRange = (doctor, service) => {
  const base = BASE_PRICE_MAP[doctor.specialty] || FALLBACK_PRICE;
  const serviceFactor = SERVICE_MULTIPLIER[service] || 1;
  const ownershipFactor = OWNERSHIP_FACTOR[doctor.ownership] || 1;
  const jitter = stableJitter(`${doctor.id}-${service}`);

  const min = roundTo50(base[0] * serviceFactor * ownershipFactor * jitter);
  const max = roundTo50(base[1] * serviceFactor * ownershipFactor * (jitter + 0.04));

  return {
    service,
    minRub: Math.min(min, max),
    maxRub: Math.max(min, max),
    currency: 'RUB',
  };
};

const fileRaw = fs.readFileSync(doctorsPath, 'utf8');
const match = fileRaw.match(/export const doctorsData = ([\s\S]*);\s*$/);

if (!match) {
  console.error('Cannot parse doctors data export in data/doctors.legacy.js');
  process.exit(1);
}

const doctors = JSON.parse(match[1]);

const updated = doctors.map((doctor) => {
  const services = Array.isArray(doctor.services) && doctor.services.length > 0
    ? doctor.services
    : ['\u041a\u043e\u043d\u0441\u0443\u043b\u044c\u0442\u0430\u0446\u0438\u044f'];

  const servicePrices = services.map((service) => calcPriceRange(doctor, service));

  return {
    ...doctor,
    servicePrices,
  };
});

fs.writeFileSync(doctorsPath, `export const doctorsData = ${JSON.stringify(updated, null, 2)};\n`);
console.log(`Updated service prices for ${updated.length} doctors in data/doctors.legacy.js`);
