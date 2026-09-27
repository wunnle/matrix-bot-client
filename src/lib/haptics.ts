import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'

/**
 * Taptic feedback, named for the moment it marks rather than the waveform.
 *
 * Native only: the plugin's web fallback is navigator.vibrate, which iOS Safari
 * doesn't have and which on Android buzzes far harder than a tick should. Every
 * call is fire-and-forget — a missed tap must never surface as an error.
 */
const enabled = Capacitor.isNativePlatform()

function run(fn: () => Promise<void>) {
  if (!enabled) return
  fn().catch(() => {})
}

/** A message, reaction or pill left the device. */
export function hapticSend() {
  run(() => Haptics.impact({ style: ImpactStyle.Light }))
}

/** A long-press was recognised, or a drag picked something up. */
export function hapticPress() {
  run(() => Haptics.impact({ style: ImpactStyle.Medium }))
}

/** A small toggle: dictation on/off, a sheet action. */
export function hapticTick() {
  run(() => Haptics.selectionChanged())
}

/** The agent finished its run. */
export function hapticSuccess() {
  run(() => Haptics.notification({ type: NotificationType.Success }))
}

/** The agent stopped and is waiting on you. */
export function hapticWarning() {
  run(() => Haptics.notification({ type: NotificationType.Warning }))
}
