import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'intent', text: "Send an email to sandhyapandey31@gmail.com with subject 'catch up' and body 'meet me at primrose hill at 6pm'" }));
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(msg.type, msg.status || '');
  if (msg.type === 'intent_result' || msg.type === 'error') {
    setTimeout(() => process.exit(0), 1000);
  }
});
