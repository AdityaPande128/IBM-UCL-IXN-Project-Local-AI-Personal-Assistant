const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

function publish(source, event, data = {}) {
    bus.emit('activity', { source, event, at: Date.now(), ...data });
}

function subscribe(handler) {
    bus.on('activity', handler);
    return () => bus.off('activity', handler);
}

module.exports = { publish, subscribe };
