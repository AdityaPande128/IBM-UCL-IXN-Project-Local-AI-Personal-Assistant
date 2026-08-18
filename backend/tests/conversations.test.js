const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const conversationStore = require('../services/conversationStore');
const memoryService = require('../services/memoryService');

function scratchStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-conv-'));
    conversationStore.open(path.join(dir, 'conversations.db'));
    return { cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the first message creates the conversation and titles it', () => {
    const store = scratchStore();
    try {
        const ws = {};
        const created = conversationStore.append(ws, 'user', '  how many pdfs\nare in Downloads  ');
        assert.ok(created, 'the first message announces the new conversation');
        assert.strictEqual(created.title, 'how many pdfs are in Downloads');
        assert.strictEqual(ws.conversationId, created.id);

        assert.strictEqual(conversationStore.append(ws, 'assistant', 'Four.'), null,
            'later messages join quietly');
        const listed = conversationStore.list();
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0].messages, 2);
    } finally {
        store.cleanup();
    }
});

test('a long first message becomes a bounded title', () => {
    const store = scratchStore();
    try {
        const ws = {};
        const created = conversationStore.append(ws, 'user', 'x'.repeat(200));
        assert.ok(created.title.length <= 64);
        assert.ok(created.title.endsWith('…'));
    } finally {
        store.cleanup();
    }
});

test('messages come back in order with artifacts intact', () => {
    const store = scratchStore();
    try {
        const ws = {};
        conversationStore.append(ws, 'user', 'list them');
        conversationStore.append(ws, 'assistant', 'here', { files: [{ name: 'a.txt', path: '/a', bytes: 3 }] });
        const rows = conversationStore.messages(ws.conversationId);
        assert.deepStrictEqual(rows.map(r => r.role), ['user', 'assistant']);
        assert.strictEqual(rows[1].artifacts.files[0].name, 'a.txt');
        assert.strictEqual(rows[0].artifacts, undefined);
    } finally {
        store.cleanup();
    }
});

test('deleting a conversation removes its rows', () => {
    const store = scratchStore();
    try {
        const ws = {};
        conversationStore.append(ws, 'user', 'first');
        const other = {};
        conversationStore.append(other, 'user', 'second');

        assert.strictEqual(conversationStore.remove(ws.conversationId), true);
        assert.strictEqual(conversationStore.exists(ws.conversationId), false);
        assert.deepStrictEqual(conversationStore.messages(ws.conversationId), []);
        assert.strictEqual(conversationStore.list().length, 1, 'the other conversation stays');
        assert.strictEqual(conversationStore.remove(999), false);
    } finally {
        store.cleanup();
    }
});

test('incognito records nothing, and blank or malformed messages never land', () => {
    const store = scratchStore();
    try {
        const ws = {};
        memoryService.setIncognito(true);
        try {
            assert.strictEqual(conversationStore.append(ws, 'user', 'secret question'), null);
            assert.strictEqual(ws.conversationId, undefined, 'no conversation came into being');
        } finally {
            memoryService.setIncognito(false);
        }

        assert.strictEqual(conversationStore.append(ws, 'user', '   '), null);
        assert.strictEqual(conversationStore.append(ws, 'wizard', 'hm'), null);
        assert.strictEqual(conversationStore.list().length, 0);
    } finally {
        store.cleanup();
    }
});
