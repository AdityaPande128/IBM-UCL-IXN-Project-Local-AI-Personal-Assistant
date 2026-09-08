const { AsyncLocalStorage } = require('async_hooks');

const scope = new AsyncLocalStorage();

function privately(fn) {
    return scope.run({ private: true }, fn);
}

function isIncognito() {
    const current = scope.getStore();
    return Boolean(current && current.private);
}

module.exports = { privately, isIncognito };
