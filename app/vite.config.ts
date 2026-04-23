import { defineConfig } from 'vite'
import pkg from './package.json'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api/note': {
        target: 'https://note.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/note/, '/api'),
        // Rewrite cookies coming back from note.com so the browser accepts
        // them under our localhost origin: drop Domain= (defaults to host),
        // strip Secure (we're on http://localhost during dev), and strip
        // HttpOnly so the WebView can persist the session through localStorage.
        configure(proxy) {
          proxy.on('proxyRes', proxyRes => {
            const cookies = proxyRes.headers['set-cookie']
            if (!cookies) return
            proxyRes.headers['set-cookie'] = cookies.map(c =>
              c
                .replace(/;\s*Domain=[^;]+/i, '')
                .replace(/;\s*Secure/i, '')
                .replace(/;\s*HttpOnly/i, '')
                .replace(/;\s*SameSite=[^;]+/i, '; SameSite=Lax'),
            )
          })
        },
      },
    },
  },
  build: { target: 'esnext' },
})
