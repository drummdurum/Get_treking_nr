"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const tracking_utils_1 = require("../src/tracking-utils");
function testAcceptsRealTrackingNumberWithTwoLetters() {
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)('GM007092'), true);
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)('ER146618'), true);
    const items = (0, tracking_utils_1.dedupeTrackingItems)([
        {
            trackingNumber: 'GM007092',
            carrier: 'Danske Fragtmaend',
            trackingUrl: 'https://trace.fragt.dk/example',
        },
    ]);
    assert_1.default.equal(items.length, 1);
    assert_1.default.equal(items[0].trackingNumber, 'GM007092');
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)(items[0].trackingNumber), true);
}
function testRejectsPackageNumberWithoutTwoLetters() {
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)('073215400605407329'), false);
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)('00073215400605407329'), false);
    const items = (0, tracking_utils_1.dedupeTrackingItems)([
        {
            trackingNumber: '073215400605407329',
            carrier: 'PostNord',
            trackingUrl: 'https://www.postnord.dk/varktojer/track-trace/?shipmentId=073215400605407329',
        },
    ]);
    assert_1.default.equal(items.length, 1);
    assert_1.default.equal(items[0].trackingNumber, '073215400605407329');
    assert_1.default.equal((0, tracking_utils_1.hasTrackingNumberLetterPrefix)(items[0].trackingNumber), false);
}
function testNumericPostNordVariantsStillMatchForDiagnostics() {
    assert_1.default.equal((0, tracking_utils_1.trackingNumbersEqual)('073215400605407329', '00073215400605407329'), true);
}
testAcceptsRealTrackingNumberWithTwoLetters();
testRejectsPackageNumberWithoutTwoLetters();
testNumericPostNordVariantsStillMatchForDiagnostics();
console.log('tracking-utils tests OK');
