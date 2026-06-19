'use strict';

function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}

function renderOperatorView({ challengeId, status, screenshotIntervalMs }) {
  const screenshotPath = `/operator/${encodeURIComponent(challengeId)}/screenshot`;

  return `<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Captcha</title>
  <style>
    body { margin: 0; background: #111; color: #eee; font-family: sans-serif; }
    #bar { padding: 8px; }
    #screen { width: 100%; touch-action: none; display: block; }
  </style>
</head>
<body>
  <div id="bar"><span id="challenge"></span>: <span id="status"></span></div>
  <img id="screen" alt="">
  <script>
    const challengeId = ${jsonForInlineScript(challengeId)};
    const status = ${jsonForInlineScript(status)};
    const screenshotPath = ${jsonForInlineScript(screenshotPath)};
    const img = document.getElementById('screen');

    document.title = 'Captcha ' + challengeId;
    document.getElementById('challenge').textContent = challengeId;
    document.getElementById('status').textContent = status;
    img.src = screenshotPath;

    setInterval(() => {
      img.src = screenshotPath + '?t=' + Date.now();
    }, ${Math.max(500, screenshotIntervalMs)});

    img.addEventListener('click', async (event) => {
      const rect = img.getBoundingClientRect();
      await fetch('/operator/' + encodeURIComponent(challengeId) + '/tap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height
        })
      });
    });
  </script>
</body>
</html>`;
}

module.exports = {
  renderOperatorView
};
