import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
  console.log('Connected to backend');
  ws.send(JSON.stringify({ type: 'intent', text: 'hello' }));
  console.log('Sent intent: hello');
});

ws.on('message', (data) => {
  const str = data.toString();
  try {
    const msg = JSON.parse(str);
    console.log(`[${msg.type}]`, msg.response || msg.text || msg.message || msg.error || '');
  } catch {
    console.log('[binary/raw]', str.length, 'bytes');
  }
});

setTimeout(() => {
  console.log('Timeout - closing');
  ws.close();
  process.exit(0);
}, 120000);
