const test = require('node:test');
const assert = require('node:assert');

const { extractJson, firstBalancedObject } = require('../utils/jsonRepair');

test('a clean object and ordinary chatter both extract', () => {
    assert.deepStrictEqual(extractJson('{"intent_class":"act"}'), { intent_class: 'act' });
    // Trailing/leading prose with no stray brace was always fine; keep it so.
    assert.deepStrictEqual(
        extractJson('{"intent_class":"act"}\n\nThis routes to the skill.'),
        { intent_class: 'act' });
    assert.deepStrictEqual(
        extractJson('Here is the decision: {"intent_class":"act"}'),
        { intent_class: 'act' });
});

test('a stray brace after the object no longer defeats extraction', () => {
    // The greedy first-to-last-brace span used to overshoot to the trailing
    // brace and fail; the balanced scan stops at the object's own close.
    assert.deepStrictEqual(
        extractJson('{"intent_class":"act"} (see {details})'),
        { intent_class: 'act' });
    assert.deepStrictEqual(extractJson('{"a":1} then {"b":2}'), { a: 1 });
});

test('a brace inside a string value is not miscounted', () => {
    assert.deepStrictEqual(
        extractJson('{"note":"a } b { c","ok":true} trailing'),
        { note: 'a } b { c', ok: true });
});

test('a nested object is returned whole', () => {
    assert.deepStrictEqual(extractJson('x {"a":{"b":1},"c":2} y'), { a: { b: 1 }, c: 2 });
});

test('a fenced block still wins over loose braces', () => {
    assert.deepStrictEqual(
        extractJson('```json\n{"z":9}\n``` and {junk'),
        { z: 9 });
});

test('no object anywhere yields null', () => {
    assert.strictEqual(extractJson('no json here'), null);
    assert.strictEqual(extractJson(''), null);
    assert.strictEqual(extractJson(null), null);
});

test('firstBalancedObject reports the first complete object', () => {
    assert.strictEqual(firstBalancedObject('{"a":1} {"b":2}'), '{"a":1}');
    assert.strictEqual(firstBalancedObject('no braces'), null);
    assert.strictEqual(firstBalancedObject('{"open": true'), null); // never closes
});
