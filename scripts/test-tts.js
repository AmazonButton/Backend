const WebSocket = require('ws');
const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EA6542D08877B88A0484A790';
const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN;

const ws = new WebSocket(url, {
  headers: {
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
  }
});

ws.on('open', () => {
  console.log('WS OPENED');
  const reqId = crypto.randomUUID().replace(/-/g, '');
  const config = 'X-Timestamp:' + new Date().toISOString() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
          }
        }
      }
    });
  ws.send(config);

  const voiceName = process.argv[2] || 'vi-VN-NamMinhNeural';
  const text = 'Bạn có đơn hàng mới từ Nguyễn Văn An, Dầu đậu nành Simply Can 5L';
  const ssml = 'X-RequestId:' + reqId + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + new Date().toISOString() + '\r\nPath:ssml\r\n\r\n' +
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="vi-VN"><voice name="${voiceName}">${text}</voice></speak>`;
  ws.send(ssml);
});

let audioChunks = [];
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const str = data.toString();
    const idx = str.indexOf('Path:audio\r\n');
    if (idx !== -1) {
      const headerEnd = data.indexOf(Buffer.from('\r\n\r\n')) + 4;
      if (headerEnd > 3) {
        audioChunks.push(data.slice(headerEnd));
      }
    }
  } else {
    const text = data.toString();
    if (text.includes('Path:turn.end')) {
      const fullAudio = Buffer.concat(audioChunks);
      console.log('SUCCESS! Audio bytes:', fullAudio.length);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (err) => console.error('WS ERROR:', err));
setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 5000);
