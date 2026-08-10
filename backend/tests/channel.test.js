const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const channelAdapter = require('../services/channelAdapter');

function harness(deps = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-channel-'));
    channelAdapter.useBinding(path.join(dir, 'chat.json'));
    channelAdapter.wire(deps);

    const sent = [];
    channelAdapter.setTransport(async (method, params) => {
        sent.push({ method, params });
        if (method === 'getFile') return { file_path: 'voice/note.oga' };
        return {};
    });

    return {
        sent,
        messagesTo: chat => sent
            .filter(entry => entry.method === 'sendMessage' && entry.params.chat_id === chat),
        cleanup() {
            channelAdapter.stop();
            channelAdapter.setTransport(null);
            channelAdapter.useBinding(null);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

function messageFrom(chat, text) {
    return { message: { chat: { id: chat }, text } };
}


test('an unpaired stranger gets silence; the pairing code binds the chat', async () => {
    const scope = harness();
    try {
        await channelAdapter.handleUpdate(messageFrom(111, 'hello?'));
        assert.strictEqual(scope.sent.length, 0, 'an unpaired chat must learn nothing');

        const code = channelAdapter.currentPairingCode();
        await channelAdapter.handleUpdate(messageFrom(111, ` ${code} `));

        assert.strictEqual(channelAdapter.boundChat(), 111);
        assert.match(scope.messagesTo(111)[0].params.text, /Paired/);
    } finally {
        scope.cleanup();
    }
});

test('a run of wrong pairing codes retires the code that was being guessed', async () => {
    const scope = harness();
    try {
        const code = channelAdapter.currentPairingCode();

        // Five wrong guesses, each in silence, before the owner is even reached.
        for (let i = 0; i < 5; i++) {
            await channelAdapter.handleUpdate(messageFrom(999, `guess-${i}`));
        }
        assert.strictEqual(scope.sent.length, 0, 'a guessing stranger still learns nothing');

        // The code that was being guessed is dead — offering it now binds nothing.
        await channelAdapter.handleUpdate(messageFrom(999, code));
        assert.strictEqual(channelAdapter.boundChat(), null, 'the retired code no longer pairs');

        // The freshly minted code still pairs the real owner.
        const fresh = channelAdapter.currentPairingCode();
        assert.notStrictEqual(fresh, code);
        await channelAdapter.handleUpdate(messageFrom(111, fresh));
        assert.strictEqual(channelAdapter.boundChat(), 111);
    } finally {
        scope.cleanup();
    }
});

test('only the bound chat is heard', async () => {
    const asked = [];
    const scope = harness({
        execute: async text => { asked.push(text); return { status: 'success', response: 'On it.' }; }
    });
    try {
        const code = channelAdapter.currentPairingCode();
        await channelAdapter.handleUpdate(messageFrom(111, code));

        await channelAdapter.handleUpdate(messageFrom(222, 'read my email'));
        assert.strictEqual(asked.length, 0, 'a different chat id never reaches the assistant');
        assert.strictEqual(scope.messagesTo(222).length, 0);

        await channelAdapter.handleUpdate(messageFrom(111, 'read my email'));
        assert.deepStrictEqual(asked, ['read my email']);
        assert.match(scope.messagesTo(111).at(-1).params.text, /On it\./);
    } finally {
        scope.cleanup();
    }
});

test('an approval becomes inline buttons, and the button answers it', async () => {
    const answered = [];
    const scope = harness({
        execute: async () => ({
            status: 'needs_approval',
            proposal: { id: 'p-1', kind: 'skill-build', summary: 'Build a CSV counter' }
        }),
        answer: async (id, decision) => {
            answered.push({ id, decision });
            return { response: 'Built and installed.' };
        }
    });
    try {
        const code = channelAdapter.currentPairingCode();
        await channelAdapter.handleUpdate(messageFrom(111, code));
        await channelAdapter.handleUpdate(messageFrom(111, 'make me a csv counter'));

        const card = scope.messagesTo(111).at(-1).params;
        assert.match(card.text, /Build a CSV counter/);
        const buttons = card.reply_markup.inline_keyboard[0];
        assert.deepStrictEqual(buttons.map(b => b.text), ['Approve', 'Decline']);
        assert.strictEqual(buttons[0].callback_data, 'apr:yes:p-1');

        await channelAdapter.handleUpdate({ callback_query: {
            id: 'cb-9', data: 'apr:yes:p-1', message: { chat: { id: 111 } }
        } });

        assert.deepStrictEqual(answered, [{ id: 'p-1', decision: 'yes' }]);
        assert.ok(scope.sent.some(entry => entry.method === 'answerCallbackQuery'));
        assert.match(scope.messagesTo(111).at(-1).params.text, /Built and installed\./);
    } finally {
        scope.cleanup();
    }
});

test('a button pressed from an unbound chat does nothing', async () => {
    const answered = [];
    const scope = harness({ answer: async id => { answered.push(id); return {}; } });
    try {
        const code = channelAdapter.currentPairingCode();
        await channelAdapter.handleUpdate(messageFrom(111, code));

        await channelAdapter.handleUpdate({ callback_query: {
            id: 'cb-1', data: 'apr:yes:p-1', message: { chat: { id: 222 } }
        } });

        assert.strictEqual(answered.length, 0);
    } finally {
        scope.cleanup();
    }
});

test('a voice note is transcribed, answered, and spoken back', async () => {
    const spoken = [];
    const scope = harness({
        execute: async text => ({ status: 'success', response: `You said: ${text}` }),
        transcribe: async filePath => {
            assert.strictEqual(filePath, 'voice/note.oga');
            return 'what is on my calendar';
        },
        speak: async (chat, text) => { spoken.push({ chat, text }); }
    });
    try {
        const code = channelAdapter.currentPairingCode();
        await channelAdapter.handleUpdate(messageFrom(111, code));

        await channelAdapter.handleUpdate({ message: {
            chat: { id: 111 }, voice: { file_id: 'f-1' }
        } });

        assert.match(scope.messagesTo(111).at(-1).params.text, /what is on my calendar/);
        assert.strictEqual(spoken.length, 1, 'a spoken question earns a spoken answer');
    } finally {
        scope.cleanup();
    }
});

test('polling advances past every update it has seen', async () => {
    const scope = harness({ execute: async () => ({ status: 'success', response: 'ok' }) });
    try {
        channelAdapter.setTransport(async (method, params) => {
            scope.sent.push({ method, params });
            if (method === 'getUpdates') {
                return params.offset === 0
                    ? [{ update_id: 7, message: { chat: { id: 1 }, text: 'x' } },
                       { update_id: 9, message: { chat: { id: 1 }, text: 'y' } }]
                    : [];
            }
            return {};
        });

        await channelAdapter.poll();
        await channelAdapter.poll();

        const polls = scope.sent.filter(entry => entry.method === 'getUpdates');
        assert.strictEqual(polls[1].params.offset, 10, 'the second poll asks past update 9');
    } finally {
        scope.cleanup();
    }
});
