function handler(event) {
    var request = event.request;
    var response = event.response;

    var originHeader = request.headers.origin;
    if (originHeader && originHeader.value) {
        response.headers['access-control-allow-origin'] = { value: originHeader.value };
        response.headers['access-control-allow-credentials'] = { value: 'true' };
        response.headers['vary'] = { value: 'Origin' };
    }

    var cookies = response.cookies;
    if (cookies) {
        for (var name in cookies) {
            var c = cookies[name];
            var parts = (c.attributes || '').split(';');
            var kept = [];
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].trim();
                if (!p) continue;
                var low = p.toLowerCase();
                if (low.indexOf('domain=') === 0) continue;
                if (low === 'httponly') continue;
                if (low.indexOf('samesite=') === 0) continue;
                if (low === 'secure') continue;
                kept.push(p);
            }
            kept.push('SameSite=None');
            kept.push('Secure');
            c.attributes = kept.join('; ');
        }

        // Expose session cookie value as a custom header so WebView clients
        // that can't persist cross-site cookies can read it and replay as
        // Authorization: Bearer on subsequent requests.
        if (cookies['_note_session_v5']) {
            response.headers['x-session-token'] = {
                value: cookies['_note_session_v5'].value,
            };
            response.headers['access-control-expose-headers'] = {
                value: 'X-Session-Token',
            };
        }
    }

    return response;
}
