function handler(event) {
    var request = event.request;
    if (request.method === 'OPTIONS') {
        var origin = (request.headers.origin && request.headers.origin.value) || '*';
        var reqHdr = request.headers['access-control-request-headers'];
        return {
            statusCode: 204,
            statusDescription: 'No Content',
            headers: {
                'access-control-allow-origin': { value: origin },
                'access-control-allow-credentials': { value: 'true' },
                'access-control-allow-methods': { value: 'GET, POST, PUT, DELETE, OPTIONS' },
                'access-control-allow-headers': { value: reqHdr ? reqHdr.value : 'Content-Type, Authorization' },
                'access-control-max-age': { value: '600' },
                'vary': { value: 'Origin' },
            },
        };
    }
    // Translate `Authorization: Bearer <token>` into `Cookie: _note_session_v5=<token>`
    // so WebView clients that can't persist cross-site cookies can still
    // authenticate via a token they captured from the login response.
    var auth = request.headers.authorization;
    if (auth && auth.value) {
        var m = auth.value.match(/^Bearer\s+(.+)$/i);
        if (m) {
            // CloudFront Function v2.0: use request.cookies, not request.headers.cookie
            if (!request.cookies) request.cookies = {};
            request.cookies['_note_session_v5'] = { value: m[1] };
            delete request.headers.authorization;
        }
    }
    return request;
}
