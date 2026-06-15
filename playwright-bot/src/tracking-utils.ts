import type { TrackingItem } from './types';

const UNKNOWN_CARRIER = 'Ukendt';

export function normalizeTrackingNumber(value: string): string {
  return value.replace(/\s+/g, '').trim().toUpperCase();
}

export function hasTrackingNumberLetterPrefix(value: string): boolean {
  return /^[A-Z]{2}/.test(normalizeTrackingNumber(value));
}

export function trackingNumberKey(value: string): string {
  const normalized = normalizeTrackingNumber(value);
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+/, '') : normalized;
}

export function trackingNumbersEqual(a: string, b: string): boolean {
  return trackingNumberKey(a) === trackingNumberKey(b);
}

export function normalizeCarrier(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  const key = raw
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/ã¦/g, 'ae')
    .replace(/ã¸/g, 'oe')
    .replace(/ã¥/g, 'aa')
    .replace(/\s+/g, ' ');

  if (!key) return UNKNOWN_CARRIER;
  if (key.includes('postnord') || key.includes('post nord')) return 'PostNord';
  if (key.includes('danske fragt') || key.includes('fragtmaend') || key.includes('fragtmand')) return 'Danske Fragtmaend';
  if (key.includes('gls')) return 'GLS';
  if (key.includes('dao')) return 'DAO';
  if (key.includes('bring')) return 'Bring';
  if (key.includes('dhl')) return 'DHL';
  return raw;
}

export function detectCarrierFromTrackingNumber(trackingNumber: string): string {
  const normalized = normalizeTrackingNumber(trackingNumber);

  if (/^(GM|FM|ER)\d{6,}$/i.test(normalized)) return 'Danske Fragtmaend';
  if (/^00370\d{9,}$/.test(normalized)) return 'GLS';
  if (/^[A-Z]{2}\d{9}DK$/i.test(normalized)) return 'PostNord';
  if (/^0{0,3}73\d{15,}$/.test(normalized)) return 'PostNord';
  if (/^\d{10,18}$/.test(normalized)) return 'DAO';

  return UNKNOWN_CARRIER;
}

export function normalizeTrackingItem(item: TrackingItem): TrackingItem {
  const trackingNumber = normalizeTrackingNumber(item.trackingNumber);
  const carrier = normalizeCarrier(item.carrier);
  return {
    ...item,
    trackingNumber,
    carrier: carrier === UNKNOWN_CARRIER ? detectCarrierFromTrackingNumber(trackingNumber) : carrier,
  };
}

export function dedupeTrackingItems(items: TrackingItem[]): TrackingItem[] {
  const byTrackingNumber = new Map<string, TrackingItem>();

  for (const item of items.map(normalizeTrackingItem)) {
    const key = trackingNumberKey(item.trackingNumber);
    const existing = byTrackingNumber.get(key);
    if (!existing) {
      byTrackingNumber.set(key, item);
      continue;
    }

    const existingKnown = existing.carrier !== UNKNOWN_CARRIER;
    const itemKnown = item.carrier !== UNKNOWN_CARRIER;
    const carrier = existingKnown && !itemKnown ? existing.carrier : item.carrier;
    byTrackingNumber.set(key, {
      trackingNumber: existing.trackingNumber.length >= item.trackingNumber.length
        ? existing.trackingNumber
        : item.trackingNumber,
      carrier,
      trackingUrl: existing.trackingUrl ?? item.trackingUrl,
    });
  }

  return [...byTrackingNumber.values()];
}
