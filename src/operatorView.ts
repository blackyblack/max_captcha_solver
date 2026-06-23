interface OperatorViewModel {
  challengeId: string;
  status: string;
  screenshotIntervalMs: number;
}

function jsonForInlineScript(value: string): string {
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

export function renderOperatorView({ challengeId, status, screenshotIntervalMs }: OperatorViewModel): string {
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
    const moveThresholdPx = 2;
    let activePointerId = null;
    let lastMovePoint = null;
    let interactionQueue = Promise.resolve();

    document.title = 'Captcha ' + challengeId;
    document.getElementById('challenge').textContent = challengeId;
    document.getElementById('status').textContent = status;
    img.src = screenshotPath;

    setInterval(() => {
      img.src = screenshotPath + '?t=' + Date.now();
    }, ${Math.max(100, screenshotIntervalMs)});

    function clamp(value) {
      return Math.max(0, Math.min(1, value));
    }

    function relativePoint(event) {
      const rect = img.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / rect.width),
        y: clamp((event.clientY - rect.top) / rect.height),
        clientX: event.clientX,
        clientY: event.clientY
      };
    }

    function postPointer(action, point) {
      interactionQueue = interactionQueue
        .then(async () => {
          const response = await fetch('/operator/' + encodeURIComponent(challengeId) + '/pointer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, x: point.x, y: point.y })
          });
          if (!response.ok) throw new Error('operator pointer request failed: ' + response.status);
        })
        .catch((error) => {
          console.error(error);
        });
    }

    img.addEventListener('pointerdown', (event) => {
      if (activePointerId !== null) return;
      const point = relativePoint(event);
      activePointerId = event.pointerId;
      lastMovePoint = point;
      img.setPointerCapture(event.pointerId);
      postPointer('down', point);
      event.preventDefault();
    });

    img.addEventListener('pointermove', (event) => {
      if (activePointerId !== event.pointerId || !lastMovePoint) return;
      const point = relativePoint(event);
      const moved = Math.hypot(point.clientX - lastMovePoint.clientX, point.clientY - lastMovePoint.clientY);
      if (moved < moveThresholdPx) return;

      lastMovePoint = point;
      postPointer('move', point);
      event.preventDefault();
    });

    img.addEventListener('pointerup', (event) => {
      if (activePointerId !== event.pointerId) return;
      const point = relativePoint(event);

      activePointerId = null;
      lastMovePoint = null;
      postPointer('up', point);
      img.releasePointerCapture(event.pointerId);
      event.preventDefault();
    });

    img.addEventListener('pointercancel', (event) => {
      if (activePointerId !== event.pointerId) return;
      const point = relativePoint(event);
      activePointerId = null;
      lastMovePoint = null;
      postPointer('up', point);
    });
  </script>
</body>
</html>`;
}
