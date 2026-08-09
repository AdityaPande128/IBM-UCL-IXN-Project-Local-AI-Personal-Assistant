import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected to backend');
  ws.send(JSON.stringify({ type: 'intent', text: "select iphone 17 pro on that webpage" }));
  console.log("Sent intent: select iphone 17 pro on that webpage");
});

ws.on('message', (data) => {
  const str = data.toString();
  try {
    const msg = JSON.parse(str);
    console.log(`[${msg.type}]`, msg.response || msg.text || msg.message || msg.error || '');
    if (msg.type === 'intent_result' || msg.type === 'error') {
      setTimeout(() => process.exit(0), 1000);
    }
  } catch {
    console.log('[binary/raw]', str.length, 'bytes');
  }
});

setTimeout(() => {
  console.log('Timeout - closing');
  ws.close();
  process.exit(0);
}, 200000);
