import assert from 'assert';
import {
  dedupeTrackingItems,
  hasTrackingNumberLetterPrefix,
  trackingNumbersEqual,
} from '../src/tracking-utils';

function testAcceptsRealTrackingNumberWithTwoLetters(): void {
  assert.equal(hasTrackingNumberLetterPrefix('GM007092'), true);
  assert.equal(hasTrackingNumberLetterPrefix('ER146618'), true);

  const items = dedupeTrackingItems([
    {
      trackingNumber: 'GM007092',
      carrier: 'Danske Fragtmaend',
      trackingUrl: 'https://trace.fragt.dk/example',
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].trackingNumber, 'GM007092');
  assert.equal(hasTrackingNumberLetterPrefix(items[0].trackingNumber), true);
}

function testRejectsPackageNumberWithoutTwoLetters(): void {
  assert.equal(hasTrackingNumberLetterPrefix('073215400605407329'), false);
  assert.equal(hasTrackingNumberLetterPrefix('00073215400605407329'), false);

  const items = dedupeTrackingItems([
    {
      trackingNumber: '073215400605407329',
      carrier: 'PostNord',
      trackingUrl: 'https://www.postnord.dk/varktojer/track-trace/?shipmentId=073215400605407329',
    },
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].trackingNumber, '073215400605407329');
  assert.equal(hasTrackingNumberLetterPrefix(items[0].trackingNumber), false);
}

function testNumericPostNordVariantsStillMatchForDiagnostics(): void {
  assert.equal(trackingNumbersEqual('073215400605407329', '00073215400605407329'), true);
}

testAcceptsRealTrackingNumberWithTwoLetters();
testRejectsPackageNumberWithoutTwoLetters();
testNumericPostNordVariantsStillMatchForDiagnostics();

console.log('tracking-utils tests OK');
