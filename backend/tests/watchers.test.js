const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');

const watchers = require('../services/watchers');
const availability = require('../services/availability');
const procedureStore = require('../services/procedureStore');
const activityBus = require('../services/activityBus');

function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-watchers-'));
    procedureStore.open(path.join(dir, 'procedures'));
    watchers.open(path.join(dir, 'watchers.db'));
    return {
        dir,
        cleanup() {
            watchers.close();
            watchers.setRunner(null);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

function recipe(name, steps) {
    procedureStore.save({
        name,
        surface: 'dom',
        start_url: 'http://127.0.0.1:9/fixture',
        description: 'a recipe for the watcher tests',
        steps
    });
}

const LOOK = [{ action: 'navigate', url: 'http://127.0.0.1:9/fixture' }];


test('a recipe whose replay presses something irreversible cannot be watched', () => {
    const scope = scratch();
    try {
        recipe('sends-things', [
            { action: 'navigate', url: 'http://127.0.0.1:9/fixture' },
            { action: 'click', name: 'Send' }
        ]);

        assert.throws(() => watchers.add({ target: 'sends-things' }), /irreversible/);
        assert.strictEqual(watchers.list().length, 0);
    } finally {
        scope.cleanup();
    }
});

test('a watcher is due at birth, then not again until its interval has passed', async () => {
    const scope = scratch();
    try {
        recipe('reads-things', LOOK);
        watchers.setRunner(async () => ({ status: 'success', passages: [{ text: 'quiet' }] }));

        const watcher = watchers.add({ target: 'reads-things', intervalMinutes: 30 });
        const now = Date.now();

        assert.strictEqual(watchers.due(now).length, 1, 'never run means due');
        await watchers.runOne(watcher, now);

        assert.strictEqual(watchers.due(now + 60000).length, 0, 'one minute later is not due');
        assert.strictEqual(watchers.due(now + 31 * 60000).length, 1,
            'the interval elapsing makes it due — asleep or awake, the same predicate');
    } finally {
        scope.cleanup();
    }
});

test('the first look is a baseline; only a change makes a notice', async () => {
    const scope = scratch();
    const events = [];
    const off = activityBus.subscribe(event => {
        if (event.source === 'watchers') events.push(event);
    });
    try {
        recipe('reads-things', LOOK);
        let page = 'Delivery expected Thursday';
        watchers.setRunner(async () => ({ status: 'success', passages: [{ text: page }] }));

        const watcher = watchers.add({ name: 'the parcel', target: 'reads-things' });

        const first = await watchers.runOne(watchers.get(watcher.id));
        assert.strictEqual(first.first, true);
        assert.strictEqual(watchers.notices().length, 0, 'a baseline is not news');

        const same = await watchers.runOne(watchers.get(watcher.id));
        assert.strictEqual(same.changed, false);
        assert.strictEqual(watchers.notices().length, 0, 'no change is not news either');

        page = 'Delivery expected Thursday\nOut for delivery now';
        const changed = await watchers.runOne(watchers.get(watcher.id));
        assert.strictEqual(changed.changed, true);

        const [notice] = watchers.notices();
        assert.match(notice.title, /the parcel/);
        assert.match(notice.body, /Out for delivery now/);
        assert.ok(!notice.body.includes('Delivery expected Thursday'),
            'the notice carries what changed, not the whole page');

        assert.strictEqual(events.length, 1, 'the change is published on the bus');
        assert.strictEqual(events[0].event, 'notice');
    } finally {
        off();
        scope.cleanup();
    }
});

test('a failed replay is recorded and makes no notice', async () => {
    const scope = scratch();
    try {
        recipe('reads-things', LOOK);
        watchers.setRunner(async () => { throw new Error('the site is down'); });

        const watcher = watchers.add({ target: 'reads-things' });
        const result = await watchers.runOne(watcher);

        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(watchers.get(watcher.id).last_status, 'failed');
        assert.match(watchers.get(watcher.id).last_error, /site is down/);
        assert.strictEqual(watchers.notices().length, 0);
    } finally {
        scope.cleanup();
    }
});

test('a recipe re-recorded into something irreversible is refused at run time', async () => {
    const scope = scratch();
    try {
        recipe('reads-things', LOOK);
        let ran = 0;
        watchers.setRunner(async () => { ran += 1; return { status: 'success', passages: [] }; });

        const watcher = watchers.add({ target: 'reads-things' });
        recipe('reads-things', [
            { action: 'navigate', url: 'http://127.0.0.1:9/fixture' },
            { action: 'click', name: 'Save' }
        ]);

        const result = await watchers.runOne(watcher);
        assert.strictEqual(result.status, 'refused');
        assert.strictEqual(ran, 0, 'the replay must never have started');
    } finally {
        scope.cleanup();
    }
});

test('notices are an inbox: unseen until marked, then quiet', async () => {
    const scope = scratch();
    try {
        recipe('reads-things', LOOK);
        let page = 'one';
        watchers.setRunner(async () => ({ status: 'success', passages: [{ text: page }] }));

        const watcher = watchers.add({ target: 'reads-things' });
        await watchers.runOne(watchers.get(watcher.id));
        page = 'two';
        await watchers.runOne(watchers.get(watcher.id));

        const unseen = watchers.notices();
        assert.strictEqual(unseen.length, 1);

        watchers.markSeen(unseen.map(notice => notice.id));
        assert.strictEqual(watchers.notices().length, 0);
        assert.strictEqual(watchers.notices({ unseenOnly: false }).length, 1,
            'seen notices remain on the record');
    } finally {
        scope.cleanup();
    }
});

test('describeChange names what appeared, or what vanished', () => {
    const grew = watchers.describeChange('a\nb', 'a\nb\nc');
    assert.strictEqual(grew.body, 'c');

    const shrank = watchers.describeChange('a\nb', 'a');
    assert.match(shrank.body, /No longer there:\nb/);
});


function fakeChild() {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    return child;
}

test('the stay-awake assertion is caffeinate, tied to this process', () => {
    const calls = [];
    const child = fakeChild();
    availability.setSpawner((cmd, args) => { calls.push({ cmd, args }); return child; });
    try {
        const held = availability.start();

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].cmd, 'caffeinate');
        assert.deepStrictEqual(calls[0].args, ['-s', '-w', String(process.pid)],
            '-s is AC-only by the OS contract; -w dies with the backend');
        assert.strictEqual(held.holding, true);

        const released = availability.stop();
        assert.strictEqual(child.killed, true);
        assert.strictEqual(released.holding, false);
    } finally {
        availability.stop();
        availability.setSpawner(null);
    }
});

test('an exit after stop stays stopped', () => {
    const children = [];
    availability.setSpawner(() => { const c = fakeChild(); children.push(c); return c; });
    try {
        availability.start();
        availability.stop();
        children[0].emit('exit', 0);

        assert.strictEqual(children.length, 1, 'nothing respawns once stopped');
        assert.strictEqual(availability.status().holding, false);
    } finally {
        availability.stop();
        availability.setSpawner(null);
    }
});
