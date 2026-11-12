/** Browser support is independent of engine catalog contents and optional legacy integrations. */
export function appNotificationsSupported(): boolean {
    return isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
