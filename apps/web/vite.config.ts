import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue(), vuetify()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3210' } },
  test: { environment: 'happy-dom', server: { deps: { inline: ['vuetify'] } } },
})
