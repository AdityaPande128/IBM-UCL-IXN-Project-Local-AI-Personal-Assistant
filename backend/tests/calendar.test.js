const test = require('node:test');
const assert = require('node:assert');

const { calendarTemplate } = require('../services/openclawBridge');

test('bare 12-1 reads as noon to one', () => {
    const plan = calendarTemplate('Create an event in my calendar: Coffee with Mark from 12-1');
    assert.ok(plan);
    assert.strictEqual(plan.title, 'Coffee with Mark');
    assert.strictEqual(plan.when, '12pm to 1pm');
});

test('explicit am stays am', () => {
    const plan = calendarTemplate('book: Standup from 9am to 10am');
    assert.strictEqual(plan.when, '9am to 10am');
});

test('pm start carries the end past twelve', () => {
    const plan = calendarTemplate('add: Review from 4pm to 5');
    assert.strictEqual(plan.when, '4pm to 5pm');
});

test('minutes survive the round trip', () => {
    const plan = calendarTemplate('schedule: Call from 9:30 to 10:15');
    assert.strictEqual(plan.when, '9:30am to 10:15am');
});

test('twelve am is midnight, not noon', () => {
    const plan = calendarTemplate('event: Launch from 12am to 1am');
    assert.strictEqual(plan.when, '12am to 1am');
});

test('an end before the start is refused', () => {
    assert.strictEqual(calendarTemplate('meeting from 3pm to 2pm'), null);
});

test('no time range means no template', () => {
    assert.strictEqual(calendarTemplate('put coffee in my calendar sometime'), null);
});

test('tomorrow lands on the next day', () => {
    const plan = calendarTemplate('calendar: Dentist from 2pm to 3pm tomorrow');
    const day = new Date();
    day.setDate(day.getDate() + 1);
    const stamp = day.getFullYear()
        + String(day.getMonth() + 1).padStart(2, '0')
        + String(day.getDate()).padStart(2, '0');
    assert.ok(plan.url.includes('&dates=' + stamp));
    assert.ok(plan.dayUrl.endsWith(
        `/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`));
});

test('the title is drawn from the colon form and bounded', () => {
    const long = 'x'.repeat(200);
    const plan = calendarTemplate(`create: ${long} from 1pm to 2pm`);
    assert.ok(plan.title.length <= 80);
});

test('a missing title falls back to a plain name', () => {
    const plan = calendarTemplate('meet Mark from 1pm to 2pm');
    assert.strictEqual(plan.title, 'New event');
});

test('the render url carries an encoded title and both stamps', () => {
    const plan = calendarTemplate('create: Tea & cake from 3pm to 4pm');
    assert.ok(plan.url.includes('text=Tea%20%26%20cake'));
    assert.ok(/dates=\d{8}T150000\/\d{8}T160000/.test(plan.url));
});
