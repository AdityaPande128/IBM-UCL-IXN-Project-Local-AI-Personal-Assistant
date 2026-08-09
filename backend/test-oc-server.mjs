import { runLegacyCliEntry } from 'openclaw';

async function test() {
    console.time("First run");
    try {
        await runLegacyCliEntry(["node", "openclaw", "agent", "--agent", "main", "--message", "what is 2+2?"]);
    } catch (e) {
        console.error(e);
    }
    console.timeEnd("First run");
    
    console.time("Second run");
    try {
        await runLegacyCliEntry(["node", "openclaw", "agent", "--agent", "main", "--message", "what is 3+3?"]);
    } catch (e) {
        console.error(e);
    }
    console.timeEnd("Second run");
}

test();
