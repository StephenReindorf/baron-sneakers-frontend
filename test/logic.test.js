process.env.DEV_MEMORY_DB = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pricing, validPhone, nextArrival, schedule } = require('../server');

test('pricing follows the README rules', () => {
  assert.deepEqual(pricing(12000), { retail: 360, wholesale: 298 });
  assert.deepEqual(pricing(9000), { retail: 300, wholesale: 233.5 });
});

test('phone validation accepts Ghana formats and rejects malformed values', () => {
  assert.equal(validPhone('0244 000 000'), true);
  assert.equal(validPhone('+233244000000'), true);
  assert.equal(validPhone('12345'), false);
});

test('arrival is next day before cutoff on a weekday', () => {
  const arrival = nextArrival(new Date('2026-10-19T12:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-20');
});

test('arrival skips to Wednesday after a Monday cutoff', () => {
  const arrival = nextArrival(new Date('2026-10-19T18:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-21');
});

test('Friday after cutoff arrives Sunday', () => {
  const arrival = nextArrival(new Date('2026-10-23T18:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-25');
});

test('Saturday after cutoff arrives Tuesday', () => {
  const arrival = nextArrival(new Date('2026-10-24T18:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-27');
});

test('Saturday before cutoff arrives Sunday', () => {
  const arrival = nextArrival(new Date('2026-10-24T12:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-25');
});

test('Sunday arrives Tuesday', () => {
  const arrival = nextArrival(new Date('2026-10-25T12:00:00Z'));
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-27');
});

test('a holiday on the payment day pushes dispatch to the next dispatch day', () => {
  const arrival = nextArrival(new Date('2026-10-19T12:00:00Z'), ['2026-10-19']);
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-21');
});

test('a holiday on the arrival day pushes arrival forward', () => {
  const arrival = nextArrival(new Date('2026-10-19T12:00:00Z'), ['2026-10-20']);
  assert.equal(arrival.toISOString().slice(0, 10), '2026-10-21');
});

test('17:00 Africa/Accra is after the dispatch cutoff', () => {
  const plan = schedule(new Date('2026-10-19T17:00:00Z'));
  assert.deepEqual(plan, { dispatch: '2026-10-20', arrival: '2026-10-21' });
});
