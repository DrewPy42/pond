<script setup lang="ts">
import QRCode from 'qrcode'
import { ref, watchEffect } from 'vue'

const props = withDefaults(defineProps<{ value: string; size?: number; label?: string }>(), {
  size: 200,
  label: 'QR code',
})

const src = ref('')
const failed = ref(false)

// Built from the QR module matrix as an SVG data URL shown in an <img>: crisp at any size,
// no canvas, no v-html, and nothing leaves the browser.
const QUIET_ZONE = 2

function toSvgDataUrl(text: string): string {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = modules.size
  const dim = n + QUIET_ZONE * 2
  let path = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (modules.get(r, c)) path += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`
    }
  }
  // Always dark on white, in both themes, so scanners get full contrast.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#FFFFFF"/><path d="${path}" fill="#1C2B39"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

watchEffect(() => {
  try {
    src.value = toSvgDataUrl(props.value)
    failed.value = false
  } catch {
    src.value = ''
    failed.value = true
  }
})
</script>

<template>
  <img v-if="src" :src="src" :alt="label" :width="size" :height="size" class="qr" />
  <v-alert v-else-if="failed" type="error" variant="tonal" density="compact">
    Couldn't draw the QR code. Use the secret key instead.
  </v-alert>
</template>

<style scoped>
.qr {
  display: block;
  border-radius: 8px;
}
</style>
