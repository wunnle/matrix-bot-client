/**
 * Removes a room's notifications from this device once you're looking at it,
 * the way messaging apps tidy the lock screen / notification centre.
 *
 * Native: APNs alerts carry `roomId` in their payload (api/_push.js), which the
 * push plugin hands back as `data`. Web: the service worker stores it in each
 * notification's `data` (public/sw.js). Only this device's notifications —
 * clearing them on your other devices needs a server push.
 *
 * Never throws: a failure only means the notifications stay where they are.
 */
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

export async function clearRoomNotifications(roomId: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { notifications } = await PushNotifications.getDeliveredNotifications()
      const forRoom = notifications.filter((n) => n.data?.roomId === roomId)
      if (forRoom.length) await PushNotifications.removeDeliveredNotifications({ notifications: forRoom })
      return
    }
    if (!('serviceWorker' in navigator)) return
    const registration = await navigator.serviceWorker.getRegistration()
    const notifications = (await registration?.getNotifications()) ?? []
    for (const n of notifications) {
      if (n.data?.roomId === roomId) n.close()
    }
  } catch {
    // Older native builds, or a browser without getNotifications.
  }
}
